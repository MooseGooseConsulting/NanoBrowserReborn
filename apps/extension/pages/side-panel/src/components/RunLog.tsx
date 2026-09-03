import { isControlHandoffState, type RunLogEntry } from '../sidePanelLogic';

interface RunLogProps {
  entries: RunLogEntry[];
  isDarkMode?: boolean;
}

/**
 * Minimal read-only run log: renders EXECUTION data the side panel already
 * receives (step number, actor, state) plus a marker for control-handoff
 * transitions (task lifecycle / run clock). No protocol changes.
 */
export default function RunLog({ entries, isDarkMode = false }: RunLogProps) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <details
      className={`mx-2 mb-2 rounded-lg border text-xs ${isDarkMode ? 'border-slate-700 text-gray-300' : 'border-sky-100 text-gray-600'}`}
      data-testid="run-log">
      <summary className="cursor-pointer px-2 py-1 font-medium">Run log ({entries.length})</summary>
      <ul className="max-h-40 space-y-0.5 overflow-y-auto px-2 pb-2">
        {entries.map((entry, index) => (
          <li key={`${entry.timestamp}-${index}`} data-state={entry.state}>
            <span className="tabular-nums">
              #{entry.step}/{entry.maxSteps}
            </span>{' '}
            <span>{entry.actor}</span> <span>{entry.state}</span>
            {isControlHandoffState(entry.state) && <span> · handoff</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
