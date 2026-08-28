import { useEffect, useState } from 'react';
import { hyperagentMcpStore } from '@extension/storage';

interface HyperagentSettingsProps {
  isDarkMode?: boolean;
}

export const HyperagentSettings = ({ isDarkMode = false }: HyperagentSettingsProps) => {
  const [accessToken, setAccessToken] = useState('');
  const [configured, setConfigured] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    hyperagentMcpStore
      .hasAccessToken()
      .then(setConfigured)
      .catch(() => setStatus('Unable to read the Hyperagent MCP session setting.'));
  }, []);

  const save = async () => {
    try {
      await hyperagentMcpStore.setAccessToken(accessToken);
      setAccessToken('');
      setConfigured(true);
      setStatus('Configured for this Chrome session.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to save the Hyperagent MCP session setting.');
    }
  };

  const clear = async () => {
    try {
      await hyperagentMcpStore.clearAccessToken();
      setAccessToken('');
      setConfigured(false);
      setStatus('Cleared from this Chrome session.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to clear the Hyperagent MCP session setting.');
    }
  };

  return (
    <section className="space-y-6">
      <div
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-white'} p-6 text-left shadow-sm`}>
        <h2 className={`mb-2 text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
          Hyperagent MCP
        </h2>
        <p className={`mb-5 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          Save a Hyperagent MCP OAuth bearer token only for the current Chrome session. It is kept in extension-only
          session storage, is cleared when Chrome restarts, and is never sent to a page or stored in the repository.
        </p>

        <label
          htmlFor="hyperagent-mcp-access-token"
          className={`mb-2 block text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
          MCP access token
        </label>
        <input
          id="hyperagent-mcp-access-token"
          type="password"
          autoComplete="off"
          value={accessToken}
          onChange={event => setAccessToken(event.target.value)}
          placeholder={configured ? 'A token is configured for this session' : 'Paste a session token'}
          className={`w-full rounded-md border ${isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-200' : 'border-gray-300 bg-white text-gray-700'} px-3 py-2`}
        />

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={!accessToken.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">
            Save for this session
          </button>
          <button
            type="button"
            onClick={clear}
            disabled={!configured}
            className={`rounded-md border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${isDarkMode ? 'border-slate-600 text-gray-200 hover:bg-slate-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
            Clear token
          </button>
          <span className={`text-sm ${configured ? 'text-green-600' : isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            {configured ? 'Configured' : 'Not configured'}
          </span>
        </div>
        {status && <p className={`mt-3 text-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>{status}</p>}
      </div>
    </section>
  );
};
