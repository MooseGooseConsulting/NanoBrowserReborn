(() => {
  const runs = GM_getValue('runs', 0) + 1;
  GM_setValue('runs', runs);
  globalThis.__nanoUserscriptPoc = {
    loaded: true,
    mode: globalThis.__nanoUserscriptMode,
    runs,
    unsafeWindowIsPageWindow: unsafeWindow === window,
  };
  const paint = () => {
    if (!document.body || document.querySelector('#nano-userscript-poc')) return;
    const banner = document.createElement('aside');
    banner.id = 'nano-userscript-poc';
    banner.dataset.mode = globalThis.__nanoUserscriptMode;
    banner.dataset.runs = String(runs);
    banner.textContent = `Nano Reborn userscript fixture loaded via ${globalThis.__nanoUserscriptMode} (runs: ${runs})`;
    banner.style.cssText = 'padding:10px;margin:10px;border:2px solid currentColor;border-radius:8px';
    document.body.prepend(banner);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint, { once: true });
  else paint();
})();
