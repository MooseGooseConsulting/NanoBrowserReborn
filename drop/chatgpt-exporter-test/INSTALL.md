# Immediate installation and usage

## Use the upstream userscript now

1. Install Tampermonkey or Violentmonkey.
2. In Chrome 138+, open the manager extension's details and enable **Allow User Scripts** once.
3. Open either the Greasy Fork page or the repository's raw `dist/chatgpt.user.js` URL and approve installation once.
4. Open or reload ChatGPT. The script runs automatically on matching ChatGPT pages at `document-end`.
5. Use **Export Helper** in the ChatGPT sidebar, then select Markdown, HTML, screenshot, JSON, or text. **Export All** opens the multi-conversation dialog.

The script itself does not need to be clicked on every page load. Exporting is an explicit action: on desktop the format menu may open on hover, then the format itself is one click; otherwise opening the menu adds a click.

## Recommended Nano Browser integration

For the first implementation, vendor and pin:

- the current `chatgpt.user.js` bundle,
- JSZip 3.9.1,
- html2canvas 1.4.1,
- a compatibility prelude that defines `unsafeWindow`, `GM_getValue`, `GM_setValue`, and `GM_deleteValue`.

Register those packaged files on ChatGPT URLs in `MAIN` world at `document_end`. Expose deterministic commands such as:

```text
chatgpt.export_current(format="markdown")
chatgpt.export_all(format="markdown")
```

Initially those commands may drive the injected menu. A cleaner second patch adds a message/event API directly to the exporter source so the action calls the exporter rather than relying on menu selectors.

For arbitrary user-installed scripts, add the `userScripts` permission and a registry based on `chrome.userScripts.register()`. That path requires the one-time **Allow User Scripts** toggle and a real metadata/dependency/grant compatibility layer; it is unnecessary for this one reviewed script.
