// ==UserScript==
// @name        Exporter runtime fixture
// @match       http://127.0.0.1/*
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_deleteValue
// @grant       unsafeWindow
// @run-at      document-end
// ==/UserScript==
(() => {
  function boot() {
    const runs = GM_getValue('fixtureRuns', 0) + 1;
    GM_setValue('fixtureRuns', runs);

    unsafeWindow.__userscriptRuntimeFixture = {
      loaded: true,
      runs,
      unsafeWindowIsPageWindow: unsafeWindow === window,
    };

    document.documentElement.dataset.userscriptLoaded = 'true';
    const target = document.querySelector('#injection-target');
    if (!target || document.querySelector('#fixture-export-helper')) return;

    target.textContent = `Userscript loaded (run ${runs}).`;

    const trigger = document.createElement('button');
    trigger.id = 'fixture-export-helper';
    trigger.textContent = 'Export Helper';
    trigger.addEventListener('click', () => {
      menu.dataset.open = menu.dataset.open === 'true' ? 'false' : 'true';
    });

    const menu = document.createElement('span');
    menu.id = 'fixture-menu';
    menu.dataset.open = 'false';

    const markdown = document.createElement('button');
    markdown.id = 'fixture-export-markdown';
    markdown.textContent = 'Markdown';
    markdown.addEventListener('click', () => {
      const turns = [...document.querySelectorAll('#conversation article')].map((node) => {
        const role = node.dataset.role === 'user' ? 'You' : 'Assistant';
        return `#### ${role}:\n${node.querySelector('p')?.textContent ?? ''}`;
      });
      const body = `---\ntitle: Local userscript fixture\n---\n\n${turns.join('\n\n')}\n`;
      const blob = new Blob([body], { type: 'text/markdown' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'local-userscript-fixture.md';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 0);
    });

    menu.append(markdown);
    target.after(trigger, menu);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
