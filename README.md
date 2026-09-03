# Nano Reborn

Independent derivative of [nanobrowser/nanobrowser](https://github.com/nanobrowser/nanobrowser) (13.7k stars, Apache-2.0). Not affiliated with that project. We grabbed the agent system (Leader/Planner + Follower/Navigator) and are replacing obsolete browser guts with an in-browser MV3 actuator and a `BrowserPort` seam (optional Stagehand CDP host behind the same plug per ADR-003) plus reviewed userscript invocation.

This is not a GitHub fork and is not intended to merge upstream.

## Layout

- `apps/extension/` — the product extension (from Nano, rebranded).
- `apps/stagehand-host/` — Node host: Stagehand v4 over CDP against the user's Chrome.
- `vendor/` — unmodified upstream snapshots tagged `upstream-image`.
- `drop/` — original working drop (handoff notes, LangGraph overlay, userscript POC, zai-sync). Historical; not the process.
- `docs/FORWARD.md` — what to do next, with test gates.

## License

Apache-2.0 for Nano-derived code. See `NOTICE`.
