# Open questions

## OQ-001 — “deterministic scaling”

Current explicit user wording:

> “must retain the ability for deterministic scaling.”

Do not translate this into max turns, max actions, periodic planning, concurrency, deterministic routing, or resource scaling without evidence.

The coding agent should inspect the existing Nano behavior/settings and preceding discussion and identify what existing control this refers to. If ambiguity remains, preserve the existing deterministic controls while implementing independent work and flag this one term for clarification.

## OQ-002 — How far to go on configuration architecture

The user asked whether Nano could become a thin extension with a desktop driver, but the source shows the immediate configuration problem can be fixed without first moving the runtime out of the extension.

Therefore:

- fix the concrete setup/config UX first;
- keep desktop-driver work as a candidate architecture for the larger runtime modernization;
- do not make the configuration fix depend on it unless the code demonstrates a real need.
