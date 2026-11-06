# skills

Agent skills for Claude Code (and any agent that reads `SKILL.md` folders).

| Skill | What it does |
| --- | --- |
| [`rec`](rec/SKILL.md) | Ports a `pnpm rec <base-url> <route>` command into a web repo: a Playwright video of one route, with `--slow` (Slow 4G + 4x CPU) and `--click` (list → detail), as H.264 .mp4 for PR before/after. User-invoked: type `/rec`. |

## Install

Clone, then link the skills you want into your user skills folder:

```bash
git clone https://github.com/oswaldb22/skills.git ~/GIT/projects/skills
ln -s ~/GIT/projects/skills/rec ~/.claude/skills/rec
```
