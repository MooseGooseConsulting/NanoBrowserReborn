import { MemorySaver } from '@langchain/langgraph/web';

/**
 * MV3-safe checkpointer for the Leader/Follower turn graph.
 *
 * Choice: MemorySaver (pure in-memory, zero Node APIs — safe in MV3
 * service workers and trivially bundleable by Vite), imported via the
 * `@langchain/langgraph/web` entry: the package root pulls
 * `node:async_hooks` (AsyncLocalStorage singleton setup), which has no
 * worker build and breaks the MV3 bundle. The /web entry is the
 * maintained browser/worker build and exports everything this turn needs
 * (StateGraph, Annotation, MemorySaver, START/END).
 *
 * Rejected: checkpoint-sqlite / checkpoint-postgres. The sqlite
 * checkpointer needs better-sqlite3 native bindings (Node-only, no
 * worker support); postgres needs sockets. Either would also add a new
 * dependency, which this rebase explicitly avoids.
 *
 * Deferred (same bucket as ADR-004 run-queue persistence): durable
 * cross-turn / cross-reload checkpointing. The saver is therefore created
 * per turn and keyed by run id (invoke with
 * `{ configurable: { thread_id: runId } }`); turn-to-turn memory stays
 * owned by AgentContext, exactly as in the legacy path.
 */
export function createTurnCheckpointer(): MemorySaver {
  return new MemorySaver();
}
