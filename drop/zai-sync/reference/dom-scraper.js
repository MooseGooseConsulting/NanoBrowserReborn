/**
 * SUPERSEDED — kept for reference only. Do not use for real capture.
 *
 * The original DOM scraper, the first working version of this project.
 * Paste into DevTools console on a chat.z.ai conversation page.
 *
 * Why it was replaced (see RESEARCH.md §2): it lazy-loads and needs the scroll loop
 * below; it collapses the model's reasoning to "Thought Process" and discards it;
 * it renders markdown to lossy plain text; it hides orphaned regeneration branches;
 * and it captures one conversation at a time.
 *
 * Measured loss on a single chat: DOM produced 24,143 chars where the API produced
 * 30,269 chars of markdown PLUS 12,356 chars of reasoning.
 *
 * Retained because it is the only path that needs no API knowledge at all — useful
 * as a fallback if the API shape changes drastically and you need something working
 * in 30 seconds.
 */
async function exportFullChat() {
  const container = document.querySelector('#messages-container');
  let lastHeight = -1, stable = 0;

  // Scroll-to-top until height stops growing: the app lazy-loads older messages.
  while (stable < 2) {
    container.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 900));
    const h = container.scrollHeight;
    if (h === lastHeight) stable++; else stable = 0;
    lastHeight = h;
  }

  const msgDivs = Array.from(container.querySelectorAll('[id^="message-"]'))
    .filter((d) => !d.id.endsWith('-start')); // duplicate empty marker divs

  const lines = [`# Z.ai Chat Export`, `URL: ${location.href}`,
    `Exported: ${new Date().toISOString()}`, `Turns: ${msgDivs.length}`, ''];

  msgDivs.forEach((div, i) => {
    const role = div.querySelector('.chat-user') ? 'USER'
      : div.querySelector('.chat-assistant') ? 'ASSISTANT' : 'unknown';
    lines.push('---', `## Turn ${i + 1} (${role})`, '', (div.innerText || '').trim(), '');
  });

  const text = lines.join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'zai-chat-export.md';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return `Downloaded ${text.length} chars across ${msgDivs.length} turns`;
}
await exportFullChat();
