(() => {
  const PREFIX = '__gm_bridge__:';
  const memory = globalThis.__GM_BRIDGE_MEMORY__ ??= new Map();

  const localStorageAvailable = (() => {
    try {
      const key = `${PREFIX}probe`;
      localStorage.setItem(key, '1');
      localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  })();

  const getRaw = (key) => localStorageAvailable
    ? localStorage.getItem(PREFIX + key)
    : (memory.has(key) ? memory.get(key) : null);
  const setRaw = (key, value) => {
    if (localStorageAvailable) localStorage.setItem(PREFIX + key, value);
    else memory.set(key, value);
  };
  const deleteRaw = (key) => {
    if (localStorageAvailable) localStorage.removeItem(PREFIX + key);
    else memory.delete(key);
  };
  const decode = (raw, fallback) => {
    if (raw === null) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  };

  Object.defineProperties(globalThis, {
    unsafeWindow: { configurable: true, value: globalThis },
    GM_getValue: {
      configurable: true,
      value: (key, fallback = undefined) => decode(getRaw(key), fallback),
    },
    GM_setValue: {
      configurable: true,
      value: (key, value) => setRaw(key, JSON.stringify(value)),
    },
    GM_deleteValue: {
      configurable: true,
      value: (key) => deleteRaw(key),
    },
  });
})();
