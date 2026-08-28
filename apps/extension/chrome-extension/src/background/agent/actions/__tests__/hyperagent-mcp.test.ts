import { describe, expect, it } from 'vitest';
import {
  formatHyperagentMcpResult,
  HYPERAGENT_MCP_ENDPOINT,
  HYPERAGENT_MCP_PROTOCOL_VERSION,
  HyperagentMcpClient,
  isHyperagentMcpWriteOperation,
  type HyperagentMcpFetchResponse,
} from '../hyperagent-mcp';

function response(
  body: string,
  options: { status?: number; headers?: Record<string, string> } = {},
): HyperagentMcpFetchResponse {
  return {
    ok: (options.status || 200) >= 200 && (options.status || 200) < 300,
    status: options.status || 200,
    headers: new Headers(options.headers),
    text: async () => body,
  };
}

describe('Hyperagent MCP client', () => {
  it('initializes a session, discovers tools, and keeps the bearer credential out of the payload', async () => {
    const requests: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
    const client = new HyperagentMcpClient({
      accessToken: 'test-bearer-token',
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        const request = JSON.parse(init.body) as { method: string; id?: number };
        if (request.method === 'initialize') {
          return response(
            JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { serverInfo: { name: 'Hyperagent' } } }),
            {
              headers: { 'mcp-session-id': 'session-1', 'content-type': 'application/json' },
            },
          );
        }
        if (request.method === 'notifications/initialized') {
          return response('', { status: 202 });
        }
        return response(
          JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'create_thread' }] } }),
          {
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });

    await expect(client.listTools()).resolves.toEqual({ tools: [{ name: 'create_thread' }] });
    expect(requests).toHaveLength(3);
    expect(requests.every(request => request.url === HYPERAGENT_MCP_ENDPOINT)).toBe(true);
    expect(JSON.parse(requests[0].init.body)).toMatchObject({
      method: 'initialize',
      params: { protocolVersion: HYPERAGENT_MCP_PROTOCOL_VERSION },
    });
    expect(JSON.parse(requests[1].init.body)).toMatchObject({ method: 'notifications/initialized' });
    expect(requests[2].init.headers).toMatchObject({
      'mcp-protocol-version': HYPERAGENT_MCP_PROTOCOL_VERSION,
      'mcp-session-id': 'session-1',
    });
    expect(requests[0].init.headers.authorization).toBe('Bearer test-bearer-token');
    expect(requests.map(request => request.init.body).join('\n')).not.toContain('test-bearer-token');
  });

  it('calls a documented tool after initialization and parses an SSE result', async () => {
    const methods: string[] = [];
    const client = new HyperagentMcpClient({
      accessToken: 'test-bearer-token',
      allowWriteTools: true,
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(init.body) as { method: string; id?: number; params?: unknown };
        methods.push(request.method);
        if (request.method === 'initialize') {
          return response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        if (request.method === 'notifications/initialized') {
          return response('', { status: 202 });
        }
        expect(request).toMatchObject({
          method: 'tools/call',
          params: { name: 'create_thread', arguments: { agentId: 'agent-1', prompt: 'summarize this' } },
        });
        return response(
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'thread-1' }] } })}\n\n`,
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        );
      },
    });

    const result = await client.callTool('create_thread', { agentId: 'agent-1', prompt: 'summarize this' });
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    expect(JSON.parse(formatHyperagentMcpResult('create_thread', result, 'test-bearer-token'))).toMatchObject({
      operation: 'create_thread',
      result: { content: [{ text: 'thread-1' }] },
    });
  });

  it('redacts the configured token from remote failures', async () => {
    const client = new HyperagentMcpClient({
      accessToken: 'test-bearer-token',
      fetchImpl: async () => response('authentication failed for Bearer test-bearer-token', { status: 401 }),
    });

    await expect(client.listTools()).rejects.toThrow(
      'Hyperagent MCP initialize returned HTTP 401: authentication failed for Bearer [redacted]',
    );
  });

  it('redacts the configured token from tool results before they enter action memory', () => {
    const formatted = formatHyperagentMcpResult(
      'list_threads',
      { content: [{ type: 'text', text: 'Bearer test-bearer-token' }] },
      'test-bearer-token',
    );

    expect(formatted).not.toContain('test-bearer-token');
    expect(formatted).toContain('Bearer [redacted]');
  });

  it('marks only documented external-write tools as mutating', () => {
    expect(isHyperagentMcpWriteOperation('list_tools')).toBe(false);
    expect(isHyperagentMcpWriteOperation('list_agents')).toBe(false);
    expect(isHyperagentMcpWriteOperation('get_thread')).toBe(false);
    expect(isHyperagentMcpWriteOperation('list_threads')).toBe(false);
    expect(isHyperagentMcpWriteOperation('create_thread')).toBe(true);
    expect(isHyperagentMcpWriteOperation('send_message')).toBe(true);
    expect(isHyperagentMcpWriteOperation('create_attachment_upload')).toBe(true);
  });

  it('does not let a client dispatch external writes without explicit authorization', async () => {
    const client = new HyperagentMcpClient({
      accessToken: 'test-bearer-token',
      fetchImpl: async () => {
        throw new Error('fetch should not be reached');
      },
    });

    await expect(client.callTool('create_thread', {})).rejects.toThrow(
      'Hyperagent MCP create_thread requires explicit user-requested dispatch authorization',
    );
  });

  it('does not pass credential-shaped action arguments to MCP', async () => {
    const client = new HyperagentMcpClient({
      accessToken: 'test-bearer-token',
      fetchImpl: async () => {
        throw new Error('fetch should not be reached');
      },
    });

    await expect(client.callTool('list_agents', { access_token: 'not-the-configured-token' })).rejects.toThrow(
      'Hyperagent MCP action arguments must not contain credentials',
    );
  });
});
