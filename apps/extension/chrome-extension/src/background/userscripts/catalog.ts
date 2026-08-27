export const FIXTURE_SCRIPT_ID = 'fixture';
export const CHATGPT_ORGANIZE_SCRIPT_ID = 'chatgpt-organize';

export const REVIEWED_USERSCRIPT_IDS = [FIXTURE_SCRIPT_ID, CHATGPT_ORGANIZE_SCRIPT_ID] as const;

export type ReviewedUserscriptId = (typeof REVIEWED_USERSCRIPT_IDS)[number];

export const PACKAGED_MODE_FILE = 'userscripts/mode-packaged.js';
export const USER_SCRIPTS_MODE_FILE = 'userscripts/mode-user-scripts.js';
export const COMPAT_FILE = 'userscripts/compat.js';
export const FIXTURE_FILE = 'userscripts/fixture.user.js';
export const CHATGPT_ORGANIZE_FILE = 'userscripts/chatgpt-organize.user.js';

const PAYLOAD_FILE_BY_ID: Record<ReviewedUserscriptId, string> = {
  [FIXTURE_SCRIPT_ID]: FIXTURE_FILE,
  [CHATGPT_ORGANIZE_SCRIPT_ID]: CHATGPT_ORGANIZE_FILE,
};

/**
 * Hostnames the payload may run on. Empty means any injectable http(s) tab.
 * chatgpt-organize is origin-locked; the organize body itself is the next PR.
 */
export const REVIEWED_USERSCRIPT_HOSTS: Record<ReviewedUserscriptId, readonly string[]> = {
  [FIXTURE_SCRIPT_ID]: [],
  [CHATGPT_ORGANIZE_SCRIPT_ID]: ['chatgpt.com'],
};

export type UserscriptRegistrationMode = 'chrome.scripting.registerContentScripts' | 'chrome.userScripts';

export function isReviewedUserscriptId(id: string): id is ReviewedUserscriptId {
  return (REVIEWED_USERSCRIPT_IDS as readonly string[]).includes(id);
}

export function payloadFileFor(scriptId: ReviewedUserscriptId): string {
  return PAYLOAD_FILE_BY_ID[scriptId];
}

export function filesForMode(mode: UserscriptRegistrationMode, scriptId: string): string[] {
  if (!isReviewedUserscriptId(scriptId)) {
    throw new Error(`Unknown reviewed userscript id: ${scriptId}`);
  }
  const modeFile = mode === 'chrome.userScripts' ? USER_SCRIPTS_MODE_FILE : PACKAGED_MODE_FILE;
  return [modeFile, COMPAT_FILE, payloadFileFor(scriptId)];
}

export function contentScriptIdFor(scriptId: string): string {
  return `nano-userscript-packaged-${scriptId}`;
}

export function userScriptIdFor(scriptId: string): string {
  return `nano-userscript-${scriptId}`;
}

export function allContentScriptIds(): string[] {
  return REVIEWED_USERSCRIPT_IDS.map(contentScriptIdFor);
}

export function allUserScriptIds(): string[] {
  return REVIEWED_USERSCRIPT_IDS.map(userScriptIdFor);
}
