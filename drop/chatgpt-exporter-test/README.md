# ChatGPT Exporter compatibility test directory

This directory tests two practical claims without touching a real ChatGPT account:

- A normal browser harness can inject a userscript, supply ChatGPT Exporter's four userscript globals, preserve state across reinjection, and trigger a file download.
- A Nano Browser-style Manifest V3 service worker can register the script through either `chrome.userScripts` or a packaged `chrome.scripting.registerContentScripts` path.

## Run

```bash
./run-tests.sh
```

## Real exporter

The sandbox used to create this directory could inspect GitHub but could not make an outbound connection from the shell/browser, so the 903,608-byte real bundle is not copied here. On a normal machine:

```bash
./real/fetch-current.sh
python ./real/run_real_exporter.py \
  --profile-dir ~/.cache/chatgpt-exporter-test-profile \
  --url 'https://chatgpt.com/c/YOUR-CONVERSATION-ID'
```

Log in once in that dedicated profile. The runner injects JSZip, html2canvas, the four expected userscript globals, and then the actual exporter bundle. It does not extract credentials.

## What this proves—and what it does not

**Proved locally:** metadata contract, JavaScript syntax, userscript execution, `unsafeWindow`, GM get/set/delete compatibility, state across reinjection, generated download contents, and both Nano Browser registration branches at the service-worker logic level.

**Not exercised here:** a real authenticated ChatGPT conversation, the upstream exporter's current DOM/API selectors, or unpacked-extension E2E in Chromium. The optional scripts are included so those final checks can be run directly in a normal desktop browser environment.
