const USER_SCRIPT_ID = 'nano-userscript-poc';
const CONTENT_SCRIPT_ID = 'nano-userscript-poc-packaged';
const MATCHES = ['http://127.0.0.1/*', 'http://localhost/*'];

async function clearRegistrations() {
  try {
    if (chrome.userScripts) await chrome.userScripts.unregister({ ids: [USER_SCRIPT_ID] });
  } catch (_) {}
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch (_) {}
}

async function registerRunner() {
  await clearRegistrations();
  let nativeError = null;

  try {
    if (!chrome.userScripts) throw new Error('chrome.userScripts is undefined; enable Allow User Scripts for this extension');
    await chrome.userScripts.register([{
      id: USER_SCRIPT_ID,
      matches: MATCHES,
      runAt: 'document_end',
      world: 'MAIN',
      js: [
        { file: 'userscripts/mode-user-scripts.js' },
        { file: 'userscripts/compat.js' },
        { file: 'userscripts/fixture.user.js' }
      ]
    }]);
    await chrome.storage.local.set({
      runnerStatus: { ok: true, mode: 'chrome.userScripts', checkedAt: new Date().toISOString() }
    });
    return;
  } catch (error) {
    nativeError = String(error?.message || error);
  }

  // A reviewed script packaged with the Nano Browser fork does not need the arbitrary-code
  // userScripts API. This is the zero-toggle path for first-class site adapters.
  await chrome.scripting.registerContentScripts([{
    id: CONTENT_SCRIPT_ID,
    matches: MATCHES,
    runAt: 'document_end',
    world: 'MAIN',
    persistAcrossSessions: true,
    js: [
      'userscripts/mode-packaged.js',
      'userscripts/compat.js',
      'userscripts/fixture.user.js'
    ]
  }]);
  await chrome.storage.local.set({
    runnerStatus: {
      ok: true,
      mode: 'chrome.scripting.registerContentScripts',
      nativeUserScriptsError: nativeError,
      checkedAt: new Date().toISOString()
    }
  });
}

chrome.runtime.onInstalled.addListener(() => registerRunner());
chrome.runtime.onStartup.addListener(() => registerRunner());
registerRunner();
