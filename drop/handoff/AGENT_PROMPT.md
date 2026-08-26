# Coding-agent prompt

Read this entire corrected handoff before coding.

Critical rule: **do not promote engineering ideas into user requirements.**

Start with the actual source, especially the configuration paths listed in `CODE_CONFIGURATION_FINDINGS.md`.

The first job is concrete:

1. reproduce and characterize current setup/configuration behavior;
2. fix the actual setup-readiness mismatch;
3. create a coherent save/reuse/restore configuration workflow over the existing storage model;
4. simplify first-run setup;
5. validate the configured model/provider before declaring setup complete;
6. fix concrete configuration bugs.

Do not begin by building a desktop daemon, MarkMap, BrowserPort, event database, or visual-perception framework.

After Phase 1 is green, validate/rebase the existing LangGraph modernization code pack and continue through `tasks.md`.

For Leader/Follower work:
- preserve the existing two-role workflow;
- let the Follower signal when control should return;
- do not remove deterministic existing controls;
- the phrase “deterministic scaling” is unresolved and must not be reinterpreted silently.

For set-of-marks:
- inspect how Nano actually generates them first;
- solve demonstrated mark-volume problems;
- SAM 3 is an optional experiment proposed by the user, not a mandated architecture.

Every final claim must be backed by tests/build/qualification evidence.
