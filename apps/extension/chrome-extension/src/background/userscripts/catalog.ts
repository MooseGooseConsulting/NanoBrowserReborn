export const FIXTURE_SCRIPT_ID = 'fixture';

export const REVIEWED_USERSCRIPT_IDS = [FIXTURE_SCRIPT_ID] as const;

export type ReviewedUserscriptId = (typeof REVIEWED_USERSCRIPT_IDS)[number];

export const PACKAGED_MODE_FILE = 'userscripts/mode-packaged.js';
export const USER_SCRIPTS_MODE_FILE = 'userscripts/mode-user-scripts.js';
export const COMPAT_FILE = 'userscripts/compat.js';
export const FIXTURE_FILE = 'userscripts/fixture.user.js';

export const PACKAGED_JS = [PACKAGED_MODE_FILE, COMPAT_FILE, FIXTURE_FILE] as const;
export const USER_SCRIPTS_JS = [USER_SCRIPTS_MODE_FILE, COMPAT_FILE, FIXTURE_FILE] as const;

export type UserscriptRegistrationMode = 'chrome.scripting.registerContentScripts' | 'chrome.userScripts';

export function isReviewedUserscriptId(id: string): id is ReviewedUserscriptId {
  return (REVIEWED_USERSCRIPT_IDS as readonly string[]).includes(id);
}

export function filesForMode(mode: UserscriptRegistrationMode): string[] {
  return mode === 'chrome.userScripts' ? [...USER_SCRIPTS_JS] : [...PACKAGED_JS];
}

export function contentScriptIdFor(scriptId: string): string {
  return `nano-userscript-packaged-${scriptId}`;
}

export function userScriptIdFor(scriptId: string): string {
  return `nano-userscript-${scriptId}`;
}
