# Nano Reborn extension

This tree started as [nanobrowser/nanobrowser](https://github.com/nanobrowser/nanobrowser) at `24a14b76e14a9c30fd84878ca7985049d1e7d064` (Apache-2.0). It is an independent derivative. See repo-root `NOTICE`.

Unmodified snapshot: `vendor/nanobrowser`.

Build: Node 22.12+, pnpm 9.15+. `pnpm install` then `pnpm build`. Load `dist` unpacked in Chrome.

What we keep: Leader/Planner + Follower/Navigator, side panel, follow-ups, history, replay, pause/resume/cancel, set-of-marks.

What we are replacing: in-extension Puppeteer loop with Stagehand over CDP (`apps/stagehand-host`). Userscript invocation is a first-class action. Analytics and product firewall start off.
