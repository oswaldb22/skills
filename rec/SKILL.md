---
name: rec
description: Port `pnpm rec` (a video of one route, for PR before/after) into the current web repo, then record.
disable-model-invocation: true
---

# rec

Port a `pnpm rec <base-url> <route>` command into the current repo: a Playwright script that records one route of production, a preview or a local server as an H.264 .mp4, with `--slow` (Slow 4G + 4x CPU, so loading states show), repeatable `--click <selector>` (list → detail), `--width` and `--theme`. A before/after pair is one command run against the base and the PR's preview.

The script is a template: [`templates/preview-record.ts`](templates/preview-record.ts) and its tests, [`templates/preview-record.test.ts`](templates/preview-record.test.ts). Everything except the `ADAPT(...)` blocks is generic; the port is filling those blocks from what this repo actually does.

If the repo already has `scripts/preview-record.ts`, skip to step 4 and record.

## 1. Survey

Answer each `ADAPT` block from the repo's own files, citing the file that settles it:

- **theme**: the themes the site ships and the default (a theme provider, a `dark:` variant policy, a `colorScheme` in the layout). One theme → `THEMES = ["light"]`.
- **overlays**: what covers every frame and is not the subject: cookie or consent banner, preview toolbar, chat widget, dev overlay. Selector into `HIDE_CSS`; a widget with no stable selector goes into `HIDE_TEXT` by its visible text.
- **loading**: the loading placeholder component (skeleton, spinner) and the selector that matches it, or none.
- **sign-in**: whether the routes worth recording sit behind auth, and the provider's documented testing path (Clerk `@clerk/testing`, Auth.js credentials, a seeded test user). Public site → leave `signIn` empty.
- **runner**: the test runner, the package manager, how scripts run TypeScript (`tsx`, `node --experimental-strip-types`), and the Node version the repo pins.

Also read the repo's agent docs (`AGENTS.md`, `CLAUDE.md`, contribution rules) for formatting, test and commit conventions; they override this skill.

Done when every `ADAPT` block has an answer with its source file. Ask the user only for what no file settles (which test user, whether a preview is protected).

## 2. Port

1. Copy the template to `scripts/preview-record.ts` and the test beside the repo's other tests.
2. Fill each `ADAPT` block with the survey's answer, then delete the `ADAPT(...)` markers. Sign-in secrets come from `.env.local` by name, are never printed, and a production key is refused before anything is sent.
3. Wire it: `playwright` as a devDependency (or reuse `@playwright/test` if present, adjusting the imports), a `rec` script in `package.json`, `/tmp/` in `.gitignore`, and one line in the repo's agent doc naming `pnpm rec`, its two flags that matter (`--slow`, `--click`), and the script header as the usage.
4. `pnpm exec playwright install chromium`.

Done when `grep -n ADAPT` over both files prints nothing.

## 3. Verify

- The ported tests pass in the repo's runner, the full suite still passes, and the typecheck and linter report nothing new in the two files.
- Two real runs: a plain one on the home route, and one with `--slow --click "<a link on that page>" --width 390`.
- Grab the last frame of each (`ffmpeg -v error -sseof -0.5 -i <video> -frames:v 1 <png>`) into the scratchpad and look at it.

Done when both frames show the intended page, signed in where that applies, with no overlay on top, and `ffprobe` reports `h264` at the requested width.

## 4. Record and attach

For a PR's before/after: run the same command against the base (production or main's preview) and against the PR's preview; the host is in each file name. Attach the videos with the `pr-images` skill when it is installed; otherwise drag the .mp4 into the PR body on github.com.

Open the port itself as its own PR, following the repo's conventions, with the two verification videos as its evidence.
