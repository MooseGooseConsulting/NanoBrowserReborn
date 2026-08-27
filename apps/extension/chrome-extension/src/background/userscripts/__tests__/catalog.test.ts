import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHATGPT_ORGANIZE_FILE,
  CHATGPT_ORGANIZE_SCRIPT_ID,
  COMPAT_FILE,
  FIXTURE_FILE,
  FIXTURE_SCRIPT_ID,
  HYPERAGENT_OBSERVE_FILE,
  HYPERAGENT_OBSERVE_SCRIPT_ID,
  PACKAGED_MODE_FILE,
  REVIEWED_USERSCRIPT_HOSTS,
  REVIEWED_USERSCRIPT_IDS,
  USER_SCRIPTS_MODE_FILE,
  filesForMode,
  isHyperagentObserveOrigin,
  isReviewedUserscriptId,
  payloadFileFor,
} from '../catalog';

describe('reviewed userscript catalog', () => {
  it('registers hyperagent-observe alongside fixture and the chatgpt-organize hook', () => {
    expect(isReviewedUserscriptId(HYPERAGENT_OBSERVE_SCRIPT_ID)).toBe(true);
    expect(isReviewedUserscriptId(FIXTURE_SCRIPT_ID)).toBe(true);
    expect(isReviewedUserscriptId(CHATGPT_ORGANIZE_SCRIPT_ID)).toBe(true);
    expect(isReviewedUserscriptId('chatgpt-export')).toBe(false);
    expect([...REVIEWED_USERSCRIPT_IDS]).toEqual(['fixture', 'chatgpt-organize', 'hyperagent-observe']);
  });

  it('maps each reviewed id to its own payload file', () => {
    expect(payloadFileFor(HYPERAGENT_OBSERVE_SCRIPT_ID)).toBe(HYPERAGENT_OBSERVE_FILE);
    expect(payloadFileFor(FIXTURE_SCRIPT_ID)).toBe(FIXTURE_FILE);
    expect(payloadFileFor(CHATGPT_ORGANIZE_SCRIPT_ID)).toBe(CHATGPT_ORGANIZE_FILE);
    expect(filesForMode('chrome.scripting.registerContentScripts', 'hyperagent-observe')).toEqual([
      PACKAGED_MODE_FILE,
      COMPAT_FILE,
      HYPERAGENT_OBSERVE_FILE,
    ]);
    expect(filesForMode('chrome.userScripts', 'hyperagent-observe')).toEqual([
      USER_SCRIPTS_MODE_FILE,
      COMPAT_FILE,
      HYPERAGENT_OBSERVE_FILE,
    ]);
    expect(filesForMode('chrome.scripting.registerContentScripts', 'fixture')).toEqual([
      PACKAGED_MODE_FILE,
      COMPAT_FILE,
      FIXTURE_FILE,
    ]);
    expect(() => filesForMode('chrome.scripting.registerContentScripts', 'chatgpt-export')).toThrow(
      /Unknown reviewed userscript id/,
    );
  });
});

describe('hyperagent-observe origin gate', () => {
  it('allows hyperagent.com only', () => {
    expect(isHyperagentObserveOrigin('https://hyperagent.com/thread/abc')).toBe(true);
    expect(isHyperagentObserveOrigin('https://www.hyperagent.com/')).toBe(true);
    expect(isHyperagentObserveOrigin('https://example.com/')).toBe(false);
    expect(isHyperagentObserveOrigin('https://hyperagent.com.evil.example/')).toBe(false);
    expect(isHyperagentObserveOrigin('https://chatgpt.com/')).toBe(false);
    expect(isHyperagentObserveOrigin('chrome://extensions')).toBe(false);
    expect(REVIEWED_USERSCRIPT_HOSTS[HYPERAGENT_OBSERVE_SCRIPT_ID]).toEqual(['hyperagent.com', 'www.hyperagent.com']);
    expect(REVIEWED_USERSCRIPT_HOSTS[FIXTURE_SCRIPT_ID]).toEqual([]);
  });
});

describe('hyperagent-observe payload source', () => {
  it('uses same-origin GET + SSE, not DOM scrape, writes, or drop/ imports', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../../../../public/userscripts/hyperagent-observe.user.js'), 'utf8');
    expect(src).toContain('/api/threads/');
    expect(src).toContain('/status');
    expect(src).toContain('/usage');
    expect(src).toContain('/usage-breakdown');
    expect(src).toContain('/api/events/stream');
    expect(src).toContain('EventSource');
    expect(src).toContain('__nanoHyperagentObserveStop');
    expect(src).toContain('MAX_FETCHES');
    expect(src).not.toMatch(/saved\.rows\.slice\(\)\.reverse\(\)/);
    expect(src).toMatch(/credentials:\s*'same-origin'/);
    expect(src).toMatch(/method:\s*'GET'/);
    expect(src).not.toMatch(/method:\s*'PATCH'/);
    expect(src).not.toMatch(/method:\s*'POST'/);
    expect(src).not.toMatch(/\bdrop\//);
    expect(src).not.toMatch(/querySelectorAll/);
    expect(src).not.toMatch(/innerText/);
    expect(src).not.toMatch(/supabase/i);
    expect(src).not.toMatch(/anonKey/);
    expect(src).not.toMatch(/\/api\/mcp/);
  });
});
