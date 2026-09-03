# Nano Reborn

Independent derivative of [nanobrowser/nanobrowser](https://github.com/nanobrowser/nanobrowser) (13.7k stars, Apache-2.0). Not affiliated with that project. We grabbed the agent system (Leader/Planner + Follower/Navigator) and drive it via a stealthy in-browser MV3 actuator (`BrowserPort` seam) and reviewed userscripts. Stagehand/external CDP is explicitly excluded from the extension path to preserve stealth (zero debugger banners, no background Node daemon, authentic user sessions).

This is not a GitHub fork and is not intended to merge upstream.

## Layout

- `apps/extension/` — the product extension (from Nano, rebranded).
- `apps/stagehand-host/` — standalone external prototype only (not used by the extension).
- `vendor/` — unmodified upstream snapshots tagged `upstream-image`.
- `drop/` — original working drop (handoff notes, LangGraph overlay, userscript POC, zai-sync). Historical; not the process.
- `docs/FORWARD.md` — what to do next, with test gates.

## License

Apache-2.0 for Nano-derived code. See `NOTICE`.
