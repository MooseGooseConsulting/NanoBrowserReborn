import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = await fs.readFile(path.join(here, 'service-worker.js'), 'utf8');

function eventMock() {
  return { listeners: [], addListener(fn) { this.listeners.push(fn); } };
}

async function runScenario(nativeUserScripts) {
  const calls = {
    userRegister: [],
    userUnregister: [],
    contentRegister: [],
    contentUnregister: [],
    storageSet: [],
  };

  const chrome = {
    runtime: { onInstalled: eventMock(), onStartup: eventMock() },
    storage: {
      local: {
        async set(value) { calls.storageSet.push(value); },
      },
    },
    scripting: {
      async registerContentScripts(value) { calls.contentRegister.push(value); },
      async unregisterContentScripts(value) { calls.contentUnregister.push(value); },
    },
  };

  if (nativeUserScripts) {
    chrome.userScripts = {
      async register(value) { calls.userRegister.push(value); },
      async unregister(value) { calls.userUnregister.push(value); },
    };
  }

  const context = vm.createContext({ chrome, console, Date, Promise, setTimeout, clearTimeout });
  vm.runInContext(code, context, { filename: 'service-worker.js' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  return calls;
}

const native = await runScenario(true);
if (native.userRegister.length !== 1) throw new Error(`Expected one native registration: ${JSON.stringify(native)}`);
const nativeScript = native.userRegister[0][0];
if (nativeScript.world !== 'MAIN' || nativeScript.runAt !== 'document_end') throw new Error('Native registration world/timing mismatch');
if (nativeScript.js.map(x => x.file).join(',') !== [
  'userscripts/mode-user-scripts.js',
  'userscripts/compat.js',
  'userscripts/fixture.user.js',
].join(',')) throw new Error('Native registration file order mismatch');
if (native.contentRegister.length !== 0) throw new Error('Fallback should not register when userScripts is available');

const fallback = await runScenario(false);
if (fallback.contentRegister.length !== 1) throw new Error(`Expected one packaged registration: ${JSON.stringify(fallback)}`);
const fallbackScript = fallback.contentRegister[0][0];
if (fallbackScript.world !== 'MAIN' || fallbackScript.runAt !== 'document_end') throw new Error('Fallback registration world/timing mismatch');
if (fallbackScript.persistAcrossSessions !== true) throw new Error('Fallback should persist across sessions');
if (fallbackScript.js.join(',') !== [
  'userscripts/mode-packaged.js',
  'userscripts/compat.js',
  'userscripts/fixture.user.js',
].join(',')) throw new Error('Fallback registration file order mismatch');

console.log(JSON.stringify({
  native: {
    registration: nativeScript,
    finalStatus: native.storageSet.at(-1),
  },
  fallback: {
    registration: fallbackScript,
    finalStatus: fallback.storageSet.at(-1),
  },
}, null, 2));
console.log('NANOBROWSER_SERVICE_WORKER_LOGIC=PASS');
