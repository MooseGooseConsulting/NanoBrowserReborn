# Nano Browser modernization — corrected coding-agent handoff

**Date:** 2026-08-26  
**Upstream inspected:** `nanobrowser/nanobrowser@24a14b76e14a9c30fd84878ca7985049d1e7d064`

This supersedes the earlier Spec Kit handoff ZIP. The earlier handoff incorrectly promoted several engineering ideas into user requirements.

## Rule

`spec.md` contains only things the user actually requested in this discussion.

Everything else is one of:

- factual observation from the code;
- engineering defect;
- candidate design;
- research question;
- backlog item from earlier related work.

Do not turn those into user requirements without explicit approval.

## Read order

1. `ARTIFACTS.md`
2. `CODE_CONFIGURATION_FINDINGS.md`
3. `specs/001-modernize-nano-browser/spec.md`
4. `specs/001-modernize-nano-browser/requirements-provenance.md`
5. `specs/001-modernize-nano-browser/checklists/requirements.md`
6. `specs/001-modernize-nano-browser/OPEN_QUESTIONS.md`
7. `specs/001-modernize-nano-browser/research.md`
8. `specs/001-modernize-nano-browser/plan.md`
9. `specs/001-modernize-nano-browser/tasks.md`
10. `BACKLOG.md`
11. `AGENT_PROMPT.md`

The coding agent must inspect the source itself before changing code.
