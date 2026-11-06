/**
 * Record a short video of one route of a running instance — production, a
 * Vercel preview or a local server — from the shell. For what a screenshot
 * cannot show: a loading state giving way to content, an animation playing
 * out, or a link opening the next page.
 *
 *   pnpm rec <base-url> <route> [--theme light|dark] [--width 390] [--slow] [--click <selector>]... [--out path]
 *
 *   pnpm rec http://localhost:3000 / --slow
 *   pnpm rec https://my-app-git-my-branch.vercel.app /pricing --width 390
 *   pnpm rec http://localhost:3000 /blog --click "main a[href^='/blog/']" --out tmp/shots/blog-open.mp4
 *
 * What is on the video: the route is opened once first, in a page that is not
 * recorded, so the JavaScript is in the browser's cache as it is for a
 * returning visitor (and any sign-in happens there). The video starts on a
 * fresh page at the navigation to <route>, holds until it settles (network
 * quiet and no loading state on screen, 10s at most, 30s under --slow), clicks
 * each --click selector in order, waiting for the URL to change (5s at most)
 * and the page to settle again after each, and holds the final state for 2s.
 *
 * --slow throttles that page through the Chrome DevTools Protocol: DevTools'
 * "Slow 4G" preset (562.5ms latency, 180 KB/s down, 84.4 KB/s up), and the CPU
 * slowed 4x.
 *
 * A before/after pair is the same command run against production (or main's
 * preview) and the PR's preview; the host is in the file name, so the two do
 * not overwrite each other.
 *
 * Vercel Authentication: when the base URL is one of this project's previews
 * (PREVIEW_HOST below) and
 * VERCEL_AUTOMATION_BYPASS_SECRET is set (.env.local or the environment, never
 * printed), the secret goes as `x-vercel-protection-bypass` on one request to
 * that host, which trades it for a cookie. No other host and no page request
 * ever carries it.
 *
 * Output: an H.264 .mp4 under `tmp/shots/`, converted from Playwright's .webm
 * by ffmpeg. Without ffmpeg on PATH the .webm is kept, and the run says so.
 * `--out x.webm` keeps the .webm on purpose.
 *
 * First run on a machine: `pnpm exec playwright install chromium`.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserContext, Page } from "playwright";

// ADAPT(theme): the themes the site ships, the default first. A single-theme
// site keeps one entry, and `--theme` then accepts only that one.
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

// ADAPT(overlays): what sits on top of every frame and is not the subject —
// a cookie banner, a preview toolbar, a chat widget. CSS for what a selector
// reaches; HIDE_TEXT hides any fixed-position element containing the text,
// for widgets whose markup has no stable selector.
const HIDE_CSS = "vercel-live-feedback { display: none !important; }";
const HIDE_TEXT: string[] = [];

// ADAPT(loading): a selector matching the app's loading placeholders (a
// skeleton component, a spinner). While one is visible the page has not
// settled. Undefined when the site has none: network quiet alone then.
const LOADING_SELECTOR: string | undefined = undefined;

/**
 * ADAPT(sign-in): runs once, before the warm-up page opens the route, with the
 * bypass cookie already in the context. Sign in here (a test user, a token
 * through the auth provider's testing API, never a production secret) and
 * throw when it fails: every later page of the context shares the session.
 * A public site leaves it empty.
 */
async function signIn(_context: BrowserContext, _url: string, _theme: Theme): Promise<void> {}

// ADAPT(preview-host): this project's Vercel preview hosts, the only hosts the
// bypass secret is ever sent to. Vercel names them `<project>-<hash>-<team>` and
// `<project>-git-<branch>-<team>`; read both parts from a real preview URL of
// the repo. Keep the project, the hash-or-branch shape and the team in it:
// anyone can deploy to `*.vercel.app`, so a looser pattern hands the secret to
// a look-alike. A name pattern narrows the risk without closing it; an exact
// host list is the stricter choice for a repo that wants it.
const PREVIEW_HOST = /^my-app-(?:git-[a-z0-9-]+|[a-z0-9]+)-my-team\.vercel\.app$/;

export const DEFAULT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;
const SETTLE_TIMEOUT_MS = 10_000;
const SLOW_SETTLE_TIMEOUT_MS = 30_000;
const URL_CHANGE_TIMEOUT_MS = 5_000;
const TAIL_MS = 2_000;
export const OUT_DIR = "tmp/shots";

/** DevTools' "Slow 4G" preset, in the units `Network.emulateNetworkConditions` takes. */
export const SLOW_NETWORK = {
  offline: false,
  latency: 562.5, // ms
  downloadThroughput: 180_000, // bytes/s
  uploadThroughput: 84_375, // bytes/s
};
const SLOW_CPU_RATE = 4;

const USAGE = `Usage: pnpm rec <base-url> <route> [--theme ${THEMES.join("|")}] [--width 390] [--slow] [--click <selector>]... [--out path]`;

export type RecordRequest = {
  url: string;
  theme: Theme;
  width: number;
  slow: boolean;
  /** Clicked in order once the route settles. */
  clicks: string[];
  /** A .mp4, or a .webm when asked for one. */
  out: string;
};

const refuse = (reason: string): never => {
  throw new Error(`${reason}\n${USAGE}`);
};

const isTheme = (value: string): value is Theme => (THEMES as readonly string[]).includes(value);

const slug = (value: string): string =>
  value.replace(/[^a-zA-Z0-9.]+/g, "-").replace(/^-+|-+$/g, "");

/** The page asked for, on the base URL's host and nowhere else. */
export function resolveTarget(base: string | undefined, route: string | undefined): URL {
  if (base === undefined) return refuse("Missing the base URL.");
  if (!URL.canParse(base)) return refuse(`The base URL ${base} is not a URL.`);
  const origin = new URL(base);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    return refuse("The base URL is http or https.");
  }
  if (route === undefined) return refuse("Missing the route, e.g. /pricing.");
  if (!route.startsWith("/")) return refuse("The route has to start with /, e.g. /pricing.");
  // `//host/x` resolves to another host, and so does `/\host/x`: the URL parser
  // reads a backslash as a slash. The bypass secret and any session follow the
  // URL, so the check is on what it resolved to rather than on how it is spelt.
  const target = new URL(route, origin.origin);
  if (target.origin !== origin.origin) {
    return refuse(`The route ${route} has to start with / and stay on ${origin.host}.`);
  }
  return target;
}

/** `<host>__<route>__<theme>__<width>[__slow].mp4` under `tmp/shots/`. */
export const defaultOut = (target: URL, theme: Theme, width: number, slow: boolean): string =>
  `${OUT_DIR}/${[
    slug(target.host),
    // The query is part of the name, so `?tab=` recordings of one page do not
    // overwrite each other.
    slug(target.pathname + target.search) || "home",
    theme,
    width,
  ].join("__")}${slow ? "__slow" : ""}.mp4`;

export function parseRecordArgs(argv: string[]): RecordRequest {
  const positionals: string[] = [];
  let theme: Theme = THEMES[0];
  let width = DEFAULT_WIDTH;
  let slow = false;
  let out: string | undefined;
  const clicks: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--slow") {
      slow = true;
      continue;
    }
    const value = argv[index + 1];
    index += 1;
    if (arg === "--theme") {
      if (value === undefined || !isTheme(value)) {
        return refuse(`--theme is ${THEMES.join(" or ")}.`);
      }
      theme = value;
    } else if (arg === "--width") {
      width = Number(value);
      if (!Number.isInteger(width) || width <= 0) {
        return refuse("--width is a number of pixels, e.g. 390.");
      }
    } else if (arg === "--out") {
      if (value === undefined || !/\.(mp4|webm)$/.test(value)) {
        return refuse("--out is a .mp4 or a .webm file.");
      }
      out = value;
    } else if (arg === "--click") {
      if (value === undefined || value.trim() === "" || value.startsWith("--")) {
        return refuse("--click needs a selector, e.g. \"main a[href^='/blog/']\".");
      }
      clicks.push(value);
    } else {
      return refuse(`Unknown flag ${arg}.`);
    }
  }

  const [base, route, ...extra] = positionals;
  const target = resolveTarget(base, route);
  if (extra.length > 0) return refuse(`Unexpected argument ${extra[0]}.`);

  return {
    url: target.href,
    theme,
    width,
    slow,
    clicks,
    out: out ?? defaultOut(target, theme, width, slow),
  };
}

/**
 * The bypass secret, only for one of this project's previews over https. The
 * secret opens every preview of the project, and the base URL is whatever was
 * typed, so any other host — another project's `*.vercel.app` included — gets
 * no bypass request at all.
 */
export function bypassSecretFor(
  url: string,
  env: Record<string, string | undefined>,
): string | undefined {
  const { protocol, hostname } = new URL(url);
  if (protocol !== "https:" || !PREVIEW_HOST.test(hostname)) return undefined;
  return env.VERCEL_AUTOMATION_BYPASS_SECRET || undefined;
}

/** Why the page that loaded is not the one asked for, when another host answered. */
export function explainLanding(requestedUrl: string, landedUrl: string): string | undefined {
  const requested = new URL(requestedUrl);
  const landed = new URL(landedUrl);
  if (landed.origin === requested.origin) return undefined;
  if (landed.hostname === "vercel.com" || landed.hostname.endsWith(".vercel.com")) {
    return "Vercel Authentication answered instead of the site. Set VERCEL_AUTOMATION_BYPASS_SECRET (Vercel → Project → Deployment Protection) in .env.local.";
  }
  return `The site redirected to ${landed.origin}.`;
}

/**
 * Where the video ends up, and whether ffmpeg makes it. Without ffmpeg an .mp4
 * asked for becomes the .webm beside where it would have been.
 */
export function videoTarget(
  out: string,
  ffmpegFound: boolean,
): { path: string; convert: boolean } {
  if (out.endsWith(".webm")) return { path: out, convert: false };
  if (!ffmpegFound) return { path: out.replace(/\.mp4$/, ".webm"), convert: false };
  return { path: out, convert: true };
}

/** Playwright's VP8 .webm as an H.264 .mp4 that GitHub and QuickTime play. */
export const ffmpegArgs = (input: string, output: string): string[] => [
  "-y",
  "-loglevel",
  "error",
  "-i",
  input,
  "-c:v",
  "libx264",
  // QuickTime and Safari play only 4:2:0, which needs even dimensions.
  "-pix_fmt",
  "yuv420p",
  "-vf",
  "scale=trunc(iw/2)*2:trunc(ih/2)*2",
  "-movflags",
  "+faststart",
  "-an",
  output,
];

/** Runs in every page before the site's scripts: overlays hidden, smooth scroll off. */
function prepareFrame({ css, texts }: { css: string; texts: string[] }) {
  const hide = () => {
    document.documentElement.style.scrollBehavior = "auto";
    if (texts.length === 0) return;
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      if (getComputedStyle(element).position !== "fixed") continue;
      if (!texts.some((text) => element.textContent?.includes(text))) continue;
      element.style.setProperty("display", "none", "important");
    }
  };
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    hide();
    new MutationObserver(hide).observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * Settled: the network quiet and no loading placeholder on screen. Network
 * quiet alone comes too early on a streamed page, whose data arrives after a
 * lull. Both are waited for up to `timeout`, and neither is required:
 * analytics can keep the network busy for good.
 */
async function settle(page: Page, timeout: number) {
  await page.waitForLoadState("networkidle", { timeout }).catch(() => undefined);
  if (LOADING_SELECTOR === undefined) return;
  await page
    .waitForFunction(
      (selector) =>
        ![...document.querySelectorAll(selector)].some((element) => element.checkVisibility()),
      LOADING_SELECTOR,
      { timeout, polling: 100 },
    )
    .catch(() => undefined);
}

const ffmpegOnPath = (): boolean =>
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error === undefined;

async function main() {
  const request = parseRecordArgs(process.argv.slice(2));
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
  const bypassSecret = bypassSecretFor(request.url, process.env);
  const settleTimeout = request.slow ? SLOW_SETTLE_TIMEOUT_MS : SETTLE_TIMEOUT_MS;

  // Loaded here so the tests of the helpers above never start a browser stack.
  const { chromium } = await import("playwright");

  const videoDir = await mkdtemp(path.join(os.tmpdir(), "pnpm-rec-"));
  const browser = await chromium.launch();
  try {
    const size = { width: request.width, height: VIEWPORT_HEIGHT };
    const context = await browser.newContext({
      viewport: size,
      colorScheme: request.theme,
      // Every page of the context is recorded, each to its own file.
      recordVideo: { dir: videoDir, size },
    });
    await context.addInitScript(prepareFrame, { css: HIDE_CSS, texts: HIDE_TEXT });

    if (bypassSecret) {
      // One request, redirects not followed: Vercel answers with the bypass
      // cookie, the context keeps it, and the secret never rides along on a
      // page request, where analytics or a redirect would see the header.
      await context.request.get(request.url, {
        headers: {
          "x-vercel-protection-bypass": bypassSecret,
          "x-vercel-set-bypass-cookie": "true",
        },
        maxRedirects: 0,
      });
    }
    await signIn(context, request.url, request.theme);

    // Warm-up, not on the video: fills the cache and answers the wall checks.
    const warmUp = await context.newPage();
    const warmResponse = await warmUp.goto(request.url);
    const blocked = explainLanding(request.url, warmUp.url());
    if (blocked) throw new Error(blocked);
    if (warmResponse && warmResponse.status() >= 400) {
      throw new Error(`${warmUp.url()} answered ${warmResponse.status()}.`);
    }
    await settle(warmUp, SETTLE_TIMEOUT_MS);

    // The video of this page starts here, at the navigation to the route.
    const page = await context.newPage();
    await warmUp.close();
    await warmUp.video()?.delete();

    if (request.slow) {
      page.setDefaultNavigationTimeout(SLOW_SETTLE_TIMEOUT_MS * 2);
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", SLOW_NETWORK);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: SLOW_CPU_RATE });
    }

    await page.goto(request.url);
    await settle(page, settleTimeout);

    for (const selector of request.clicks) {
      const before = page.url();
      await page
        .locator(selector)
        .first()
        .click({ timeout: settleTimeout })
        .catch(() => {
          throw new Error(
            `Nothing to click for ${selector} on ${page.url()} within ${settleTimeout / 1000}s.`,
          );
        });
      await page
        .waitForURL((url) => url.href !== before, { timeout: URL_CHANGE_TIMEOUT_MS })
        .catch(() => undefined);
      await settle(page, settleTimeout);
    }
    await page.waitForTimeout(TAIL_MS);

    const landed = page.url();
    const video = page.video();
    // The video is written out when its page's context closes.
    await context.close();
    if (!video) throw new Error("Playwright recorded no video.");

    const ffmpegFound = ffmpegOnPath();
    const target = videoTarget(request.out, ffmpegFound);
    await mkdir(path.dirname(target.path), { recursive: true });
    if (target.convert) {
      const webm = path.join(videoDir, "recording.webm");
      await video.saveAs(webm);
      const result = spawnSync("ffmpeg", ffmpegArgs(webm, target.path), { stdio: "inherit" });
      if (result.status !== 0) {
        // The recording is kept: a run is not cheap to repeat.
        const kept = videoTarget(request.out, false).path;
        await video.saveAs(kept);
        throw new Error(
          `ffmpeg could not convert the recording to ${target.path}. The .webm is kept at ${kept}.`,
        );
      }
    } else {
      await video.saveAs(target.path);
    }
    console.log(`${target.path}  ←  ${request.url}`);
    if (!ffmpegFound && !request.out.endsWith(".webm")) {
      console.log("Note: no ffmpeg on PATH, so the .webm is kept as recorded.");
    }
    if (landed !== request.url && request.clicks.length === 0) {
      console.log(`Note: asked for ${request.url}, and the site redirected to ${landed}.`);
    }
  } finally {
    await browser.close();
    await rm(videoDir, { recursive: true, force: true });
  }
}

// Only when run as a program, not when a test imports the helpers above.
const invokedDirectly = process.argv[1]
  ? process.argv[1] === fileURLToPath(import.meta.url)
  : false;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
