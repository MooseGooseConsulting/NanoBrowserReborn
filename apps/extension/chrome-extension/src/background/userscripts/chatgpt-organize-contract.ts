/**
 * Live ChatGPT API contract the packaged chatgpt-organize seed depends on.
 * Keep-current rewrites must preserve these bytes-level tokens. Tests assert
 * the public/userscripts/chatgpt-organize.user.js seed (and any overlay) against
 * this object — not a parallel TypeScript reimplementation.
 *
 * Origin: chatgpt.com only. chat.openai.com 308s and does not serve /backend-api.
 *
 * Calls (same-origin fetch, credentials: include):
 *   GET  /api/auth/session
 *   GET  /backend-api/conversations?offset=&limit=
 *   GET  /backend-api/conversation/:id
 *   PATCH /backend-api/conversation/:id  body { title }
 *
 * Headers:
 *   Authorization: Bearer <session.accessToken>
 *   Oai-Device-Id: only when the oai-did cookie exists (never invent)
 *   Chatgpt-Account-Id: from _account cookie or session.accountId
 *
 * HTTP 200 + { success: false } is a failed mutation.
 */
export const CHATGPT_ORGANIZE_API_CONTRACT = {
  originHost: 'chatgpt.com',
  sessionPath: '/api/auth/session',
  backendApiPrefix: '/backend-api',
  listPath: '/conversations?offset=',
  conversationPath: '/conversation/${item.id}',
  titlePatchMethod: 'PATCH',
  authorizationBearer: 'Authorization: `Bearer ${accessToken}`',
  optionalDeviceHeader: "'Oai-Device-Id'",
  deviceCookie: 'oai-did',
  accountHeader: "'Chatgpt-Account-Id'",
  successFalseToken: 'success === false',
  waiterHook: '__nanoChatGptOrganize',
  oneShotHook: '__nanoOrganizeRun',
} as const;

export function assertSourceMatchesChatGptOrganizeContract(source: string): void {
  const required = [
    CHATGPT_ORGANIZE_API_CONTRACT.sessionPath,
    CHATGPT_ORGANIZE_API_CONTRACT.backendApiPrefix,
    CHATGPT_ORGANIZE_API_CONTRACT.listPath,
    CHATGPT_ORGANIZE_API_CONTRACT.conversationPath,
    CHATGPT_ORGANIZE_API_CONTRACT.titlePatchMethod,
    CHATGPT_ORGANIZE_API_CONTRACT.authorizationBearer,
    CHATGPT_ORGANIZE_API_CONTRACT.optionalDeviceHeader,
    CHATGPT_ORGANIZE_API_CONTRACT.deviceCookie,
    CHATGPT_ORGANIZE_API_CONTRACT.accountHeader,
    CHATGPT_ORGANIZE_API_CONTRACT.successFalseToken,
    CHATGPT_ORGANIZE_API_CONTRACT.waiterHook,
    CHATGPT_ORGANIZE_API_CONTRACT.oneShotHook,
    CHATGPT_ORGANIZE_API_CONTRACT.originHost,
  ];
  for (const token of required) {
    if (!source.includes(token)) {
      throw new Error(`chatgpt-organize source missing contract token: ${token}`);
    }
  }
  if (!source.includes('if (device) headers')) {
    throw new Error('chatgpt-organize source must send Oai-Device-Id only when oai-did exists');
  }
}
