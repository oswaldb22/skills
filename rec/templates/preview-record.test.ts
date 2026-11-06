// ADAPT(runner): node:test as written; port the asserts to the repo's runner
// (vitest, jest) and the import path to where the script landed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bypassSecretFor,
  explainLanding,
  ffmpegArgs,
  parseRecordArgs,
  SLOW_NETWORK,
  videoTarget,
} from "../scripts/preview-record";

// ADAPT(names): a preview host of this project (matching PREVIEW_HOST), one of
// another team on the same platform, and the default theme.
const PREVIEW = "https://my-app-git-feat-x-my-team.vercel.app";
const PREVIEW_HOST = "my-app-git-feat-x-my-team.vercel.app";
const FOREIGN_PREVIEW = "https://my-app-git-feat-x-someone-else.vercel.app";
const THEME = "light";

describe("parseRecordArgs", () => {
  it("joins the base URL and the route, at desktop width", () => {
    assert.deepEqual(parseRecordArgs([PREVIEW, "/pricing"]), {
      url: `${PREVIEW}/pricing`,
      theme: THEME,
      width: 1440,
      slow: false,
      clicks: [],
      out: `tmp/shots/${PREVIEW_HOST}__pricing__${THEME}__1440.mp4`,
    });
  });

  it("names the home page, a query, and a throttled recording apart", () => {
    assert.equal(
      parseRecordArgs(["http://localhost:3000", "/", "--slow"]).out,
      `tmp/shots/localhost-3000__home__${THEME}__1440__slow.mp4`,
    );
    assert.equal(
      parseRecordArgs(["http://localhost:3000", "/blog?tag=x"]).out,
      `tmp/shots/localhost-3000__blog-tag-x__${THEME}__1440.mp4`,
    );
  });

  it("keeps every --click, in order, and reads the flags in any position", () => {
    assert.deepEqual(
      parseRecordArgs([
        "--click",
        "main a[href^='/blog/']",
        PREVIEW,
        "/blog",
        "--width",
        "390",
        "--click",
        "nav a:has-text('Pricing')",
        "--slow",
        "--out",
        "tmp/after.webm",
      ]),
      {
        url: `${PREVIEW}/blog`,
        theme: THEME,
        width: 390,
        slow: true,
        clicks: ["main a[href^='/blog/']", "nav a:has-text('Pricing')"],
        out: "tmp/after.webm",
      },
    );
  });

  const refusals: [string[], string][] = [
    [[], "base URL"],
    [[PREVIEW], "route"],
    [["ftp://example.com", "/"], "http"],
    [[PREVIEW, "pricing"], "start with /"],
    [[PREVIEW, "//evil.example/x"], `stay on ${PREVIEW_HOST}`],
    [[PREVIEW, "/\\evil.example/x"], `stay on ${PREVIEW_HOST}`],
    [[PREVIEW, "/", "--theme", "sepia"], "--theme"],
    [[PREVIEW, "/", "--width", "0"], "--width"],
    [[PREVIEW, "/", "--click"], "--click"],
    [[PREVIEW, "/", "--click", " "], "--click"],
    [[PREVIEW, "/", "--out", "tmp/x.png"], ".mp4 or a .webm"],
    [[PREVIEW, "/", "--full-page"], "--full-page"],
    [[PREVIEW, "/", "/extra"], "/extra"],
  ];
  for (const [argv, reason] of refusals) {
    it(`refuses ${JSON.stringify(argv)}, with the usage`, () => {
      assert.throws(
        () => parseRecordArgs(argv),
        (error: Error) =>
          error.message.includes(reason) && error.message.includes("Usage: pnpm rec"),
      );
    });
  }
});

describe("bypassSecretFor", () => {
  const env = { VERCEL_AUTOMATION_BYPASS_SECRET: "s3cret" };

  it("sends the secret to this project's previews over https", () => {
    assert.equal(bypassSecretFor(`${PREVIEW}/`, env), "s3cret");
  });

  it("sends it nowhere else", () => {
    assert.equal(bypassSecretFor("https://example.com/", env), undefined);
    assert.equal(bypassSecretFor("http://localhost:3000/", env), undefined);
    assert.equal(bypassSecretFor(`http://${PREVIEW_HOST}/`, env), undefined);
    assert.equal(bypassSecretFor("https://vercel.app.evil.example/", env), undefined);
    // Someone else's deployments, on Vercel all the same.
    assert.equal(bypassSecretFor("https://evil-app.vercel.app/", env), undefined);
    assert.equal(bypassSecretFor(`${FOREIGN_PREVIEW}/`, env), undefined);
  });

  it("is absent when unset", () => {
    assert.equal(bypassSecretFor(`${PREVIEW}/`, {}), undefined);
  });
});

describe("explainLanding", () => {
  it("says nothing when the same host answered", () => {
    assert.equal(explainLanding(`${PREVIEW}/pricing`, `${PREVIEW}/pricing/`), undefined);
  });

  it("names Vercel Authentication and the env var", () => {
    assert.match(
      explainLanding(`${PREVIEW}/`, "https://vercel.com/login?next=x") ?? "",
      /VERCEL_AUTOMATION_BYPASS_SECRET/,
    );
  });

  it("names another host", () => {
    assert.equal(
      explainLanding("https://www.example.com/", "https://example.com/"),
      "The site redirected to https://example.com.",
    );
  });
});

describe("videoTarget", () => {
  it("converts to the .mp4 asked for when ffmpeg is there", () => {
    assert.deepEqual(videoTarget("tmp/shots/a.mp4", true), {
      path: "tmp/shots/a.mp4",
      convert: true,
    });
  });

  it("keeps the .webm beside it when ffmpeg is not", () => {
    assert.deepEqual(videoTarget("tmp/shots/a.mp4", false), {
      path: "tmp/shots/a.webm",
      convert: false,
    });
  });

  it("keeps a .webm asked for, ffmpeg or not", () => {
    assert.deepEqual(videoTarget("tmp/a.webm", true), { path: "tmp/a.webm", convert: false });
  });
});

describe("ffmpegArgs", () => {
  it("writes an H.264 .mp4 that QuickTime plays, overwriting, without audio", () => {
    const args = ffmpegArgs("in dir/rec.webm", "tmp/shots/out.mp4");
    assert.deepEqual(args.slice(0, 5), ["-y", "-loglevel", "error", "-i", "in dir/rec.webm"]);
    assert.equal(args.at(-1), "tmp/shots/out.mp4");
    assert.ok(args.join(" ").includes("-c:v libx264 -pix_fmt yuv420p"));
    assert.ok(args.includes("+faststart"));
    assert.ok(args.includes("-an"));
  });
});

describe("SLOW_NETWORK", () => {
  // DevTools' "Slow 4G"; the header of scripts/preview-record.ts quotes these.
  it("is DevTools' Slow 4G preset", () => {
    assert.deepEqual(SLOW_NETWORK, {
      offline: false,
      latency: 562.5,
      downloadThroughput: 180_000,
      uploadThroughput: 84_375,
    });
  });
});
