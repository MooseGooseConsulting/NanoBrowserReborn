(() => {
  const prefix = '__nano_userscript__:';
  globalThis.unsafeWindow = globalThis;
  globalThis.GM_getValue = (key, fallback = undefined) => {
    const raw = localStorage.getItem(prefix + key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  };
  globalThis.GM_setValue = (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value));
  globalThis.GM_deleteValue = key => localStorage.removeItem(prefix + key);
})();
