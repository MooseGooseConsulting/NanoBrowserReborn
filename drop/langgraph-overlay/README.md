# Nano Browser LangGraph modernization bundle

Reconstructed modernization overlay for upstream Nano Browser commit
`24a14b76e14a9c30fd84878ca7985049d1e7d064`.

## Contents

- `overlay/` — files to copy over a clean checkout.
  - typed LangGraph execution graph
  - rewritten `Executor`
  - graph-routing tests
  - modernized LangChain/LangGraph dependency family
  - validation script
- `docs/IMPLEMENTATION_REPORT.md` — what changed and why.
- `docs/DEPENDENCY_UPGRADE_AUDIT.md` — staged modernization audit.
- `docs/LANGGRAPH_MODERNIZATION.md` — application and follow-on guide.
- `scripts/apply-overlay.sh` — guarded helper that applies the overlay to the exact baseline commit.
- `scripts/validate-langgraph-modernization.sh` — same validation script included in the overlay.
- `RECONSTRUCTION_NOTE.md` — what could and could not be recovered from the expired original bundle.

## Apply

```bash
./scripts/apply-overlay.sh /path/to/nanobrowser
cd /path/to/nanobrowser
corepack pnpm install --no-frozen-lockfile
./scripts/validate-langgraph-modernization.sh
```

Commit the regenerated `pnpm-lock.yaml` after validation.
