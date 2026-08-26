/**
 * DOWNSTREAM view layer. Reads raw records, produces readable/queryable shapes.
 *
 * Nothing here runs at capture time. Re-run it over stored raw whenever you learn
 * something new about the schema — that is the entire point of capturing raw first.
 *
 * Block types seen in the wild so far:
 *   'reasoning'   — model thinking (often LARGER than the answer; absent from the DOM)
 *   'text'        — prose answer
 *   'tool_calls'  — AGENT CHATS ONLY. content is an ARRAY of {id,type,function:{name,arguments}},
 *                   plus sibling `results`. Never a string. Do not concatenate into prose.
 * Unknown types are preserved verbatim under `unknownBlocks` rather than dropped.
 */

/** Walk currentId -> root, then descend, to get the active branch in order. */
export function walkActiveBranch(history) {
  const msgs = (history && history.messages) || {};
  const chain = [];
  const seen = new Set();
  let cur = history && history.currentId;

  if (!cur || !msgs[cur]) {
    const leaves = Object.values(msgs).filter((m) => !m.childrenIds || !m.childrenIds.length);
    leaves.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    cur = leaves.length ? leaves[0].id : null;
  }

  const anchor = cur;
  while (cur && msgs[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.push(msgs[cur]);
    cur = msgs[cur].parentId;
  }
  chain.reverse();

  // currentId *should* be the leaf, but if it is stale we would drop the tail.
  let node = anchor && msgs[anchor];
  while (node && node.childrenIds && node.childrenIds.length) {
    const kids = node.childrenIds.map((id) => msgs[id]).filter(Boolean);
    if (!kids.length) break;
    kids.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const next = kids[0];
    if (seen.has(next.id)) break;
    seen.add(next.id);
    chain.push(next);
    node = next;
  }
  return chain;
}

export function splitBlocks(full) {
  let text = '', reasoning = '';
  const toolCalls = [], unknownBlocks = [];

  if (!full) return { text, reasoning, toolCalls, unknownBlocks };
  if (typeof full.content === 'string' && full.content) text = full.content;

  for (const b of (Array.isArray(full.content_blocks) ? full.content_blocks : [])) {
    if (!b) continue;
    if (b.type === 'reasoning') {
      if (b.content) reasoning += b.content;
    } else if (b.type === 'tool_calls') {
      for (const c of (Array.isArray(b.content) ? b.content : [])) {
        const fn = (c && c.function) || {};
        let args = fn.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep raw */ } }
        toolCalls.push({
          id: c && c.id, name: fn.name || null, arguments: args ?? null,
          results: b.results ?? null, started_at: b.started_at ?? null, ended_at: b.ended_at ?? null,
        });
      }
    } else if (b.type === 'text' && typeof b.content === 'string') {
      text += (text ? '\n\n' : '') + b.content;
    } else {
      unknownBlocks.push(b); // preserved, never stringified into prose
    }
  }
  return { text, reasoning, toolCalls, unknownBlocks };
}

/** raw record -> flat, DB-friendly conversation. */
export function normalize(raw) {
  const detail = raw.detail || {};
  const hist = (detail.chat && detail.chat.history) || {};
  const branch = walkActiveBranch(hist);
  const msgs = raw.messages || {};

  const messages = branch.map((stub) => {
    const full = msgs[stub.id];
    const parts = splitBlocks(full);
    return {
      id: stub.id,
      role: stub.role || (full && full.role) || 'unknown',
      timestamp: stub.timestamp || (full && full.timestamp) || null,
      model: (full && (full.model_name || full.model)) || null,
      usage: (full && full.usage) || null,
      files: (full && full.files) || [],
      ...parts,
    };
  });

  return {
    id: raw.id,
    title: detail.title || null,
    kind: detail.type || 'default',        // 'default' | 'general_agent'
    isAgent: (detail.type || '') === 'general_agent',
    agentContext: detail.im_context || null,
    created_at: detail.created_at || null,
    updated_at: detail.updated_at || null,
    models: (detail.chat && detail.chat.models) || [],
    messages,
    orphaned: Object.keys(hist.messages || {}).length - branch.length,
  };
}

export function toMarkdown(raw, { includeReasoning = true, includeTools = true } = {}) {
  const c = normalize(raw);
  const out = [`# ${c.title || c.id}`, ''];
  out.push(`- chat_id: \`${c.id}\``);
  out.push(`- kind: ${c.kind}${c.isAgent ? ' (agent)' : ''}`);
  if (c.updated_at) out.push(`- updated: ${new Date(c.updated_at * 1000).toISOString()}`);
  if (c.models.length) out.push(`- models: ${c.models.join(', ')}`);
  if (c.orphaned > 0) out.push(`- ${c.orphaned} message(s) on inactive branches (kept in raw, omitted here)`);
  out.push('');

  for (const m of c.messages) {
    out.push('---', '', `## ${m.role.toUpperCase()}${m.model ? ` (${m.model})` : ''}`, '');
    if (includeReasoning && m.reasoning) {
      out.push('<details><summary>reasoning</summary>', '', m.reasoning, '', '</details>', '');
    }
    if (m.text) out.push(m.text, '');
    if (includeTools) {
      for (const t of m.toolCalls) {
        const a = typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments, null, 2);
        out.push(`<details><summary>🔧 ${t.name || 'tool'}</summary>`, '', '```json',
          String(a || '').slice(0, 8000), '```', '', '</details>', '');
      }
    }
    for (const f of m.files) {
      const nm = (f.file && f.file.meta && f.file.meta.name) || f.name || 'attachment';
      out.push(`📎 **${nm}** (${f.type || 'file'})`, '');
    }
    if (!m.text && !m.reasoning && !m.toolCalls.length) out.push('_(empty)_', '');
  }
  return out.join('\n');
}
