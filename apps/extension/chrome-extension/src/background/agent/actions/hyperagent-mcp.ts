export const HYPERAGENT_MCP_ENDPOINT = 'https://hyperagent.com/api/mcp';
export const HYPERAGENT_MCP_PROTOCOL_VERSION = '2025-03-26';

export const HYPERAGENT_MCP_TOOL_NAMES = [
  'list_agents',
  'create_thread',
  'send_message',
  'get_thread',
  'list_threads',
  'create_attachment_upload',
] as const;

export type HyperagentMcpToolName = (typeof HYPERAGENT_MCP_TOOL_NAMES)[number];
export type HyperagentMcpOperation = 'list_tools' | HyperagentMcpToolName;

const HYPERAGENT_MCP_WRITE_TOOL_NAMES = ['create_thread', 'send_message', 'create_attachment_upload'] as const;

export function isHyperagentMcpWriteOperation(operation: HyperagentMcpOperation): boolean {
  return (HYPERAGENT_MCP_WRITE_TOOL_NAMES as readonly string[]).includes(operation);
}

export interface HyperagentMcpFetchResponse {
  ok: boolean;
  status: number;
  headers: Pick<Headers, 'get'>;
  text: () => Promise<string>;
}

export type HyperagentMcpFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<HyperagentMcpFetchResponse>;

export class HyperagentMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HyperagentMcpError';
  }
}

interface JsonRpcEnvelope {
  id?: number;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

interface HyperagentMcpRequestResult {
  result: unknown;
  sessionId: string | null;
}

function redact(value: string, accessToken: string): string {
  const withExactTokenRedacted = accessToken ? value.replaceAll(accessToken, '[redacted]') : value;
  return withExactTokenRedacted.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]');
}

function parseJsonRpc(body: string, contentType: string | null, accessToken: string): JsonRpcEnvelope {
  const candidates = contentType?.includes('text/event-stream')
    ? body.split(/\r?\n\r?\n/).flatMap(event =>
        event
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice('data:'.length).trim()),
      )
    : [body.trim()];

  for (const candidate of candidates.reverse()) {
    if (!candidate) {
      continue;
    }
    try {
      return JSON.parse(candidate) as JsonRpcEnvelope;
    } catch {
      // A stream can contain non-JSON events before its JSON-RPC response.
    }
  }
  throw new HyperagentMcpError(
    `Hyperagent MCP returned an unreadable response: ${redact(body.slice(0, 240), accessToken)}`,
  );
}

function remoteError(method: string, error: JsonRpcEnvelope['error'], accessToken: string): HyperagentMcpError {
  const message = typeof error?.message === 'string' ? redact(error.message, accessToken) : 'unknown remote error';
  return new HyperagentMcpError(`Hyperagent MCP ${method} failed: ${message}`);
}

function containsCredentialArgument(value: unknown, accessToken: string): boolean {
  if (typeof value === 'string') {
    return (accessToken.length > 0 && value.includes(accessToken)) || /Bearer\s+/i.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(item => containsCredentialArgument(item, accessToken));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, nestedValue]) =>
        /(authorization|access[_-]?token|bearer|api[_-]?key|secret)/i.test(key) ||
        containsCredentialArgument(nestedValue, accessToken),
    );
  }
  return false;
}

export class HyperagentMcpClient {
  private nextRequestId = 0;
  private initialized = false;
  private sessionId: string | null = null;

  constructor(
    private readonly options: {
      accessToken: string;
      fetchImpl?: HyperagentMcpFetch;
      allowWriteTools?: boolean;
    },
  ) {}

  async listTools(): Promise<unknown> {
    await this.ensureInitialized();
    return (await this.request('tools/list', {})).result;
  }

  async callTool(name: HyperagentMcpToolName, args: Record<string, unknown>): Promise<unknown> {
    if (isHyperagentMcpWriteOperation(name) && this.options.allowWriteTools !== true) {
      throw new HyperagentMcpError(`Hyperagent MCP ${name} requires explicit user-requested dispatch authorization`);
    }
    if (containsCredentialArgument(args, this.options.accessToken.trim())) {
      throw new HyperagentMcpError('Hyperagent MCP action arguments must not contain credentials');
    }
    await this.ensureInitialized();
    return (await this.request('tools/call', { name, arguments: args })).result;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const initialized = await this.request('initialize', {
      protocolVersion: HYPERAGENT_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'nano-reborn', version: '0.1.13' },
    });
    this.sessionId = initialized.sessionId;
    this.initialized = true;
    await this.request('notifications/initialized', {}, true);
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    notification = false,
  ): Promise<HyperagentMcpRequestResult> {
    const accessToken = this.options.accessToken.trim();
    if (!accessToken) {
      throw new HyperagentMcpError('Hyperagent MCP is not configured. Save an access token in Settings first.');
    }

    const id = notification ? undefined : ++this.nextRequestId;
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    };
    if (this.initialized) {
      headers['mcp-protocol-version'] = HYPERAGENT_MCP_PROTOCOL_VERSION;
    }
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const body = JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params });
    const fetchImpl = this.options.fetchImpl || (fetch as unknown as HyperagentMcpFetch);
    let response: HyperagentMcpFetchResponse;
    try {
      response = await fetchImpl(HYPERAGENT_MCP_ENDPOINT, { method: 'POST', headers, body });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HyperagentMcpError(`Hyperagent MCP ${method} could not be reached: ${redact(message, accessToken)}`);
    }

    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HyperagentMcpError(
        `Hyperagent MCP ${method} response could not be read: ${redact(message, accessToken)}`,
      );
    }
    if (!response.ok) {
      const detail = responseBody ? `: ${redact(responseBody.slice(0, 240), accessToken)}` : '';
      throw new HyperagentMcpError(`Hyperagent MCP ${method} returned HTTP ${response.status}${detail}`);
    }

    const sessionId = response.headers.get('mcp-session-id');
    if (notification) {
      return { result: null, sessionId };
    }

    const envelope = parseJsonRpc(responseBody, response.headers.get('content-type'), accessToken);
    if (envelope.id !== id) {
      throw new HyperagentMcpError(`Hyperagent MCP ${method} returned an unexpected response id`);
    }
    if (envelope.error) {
      throw remoteError(method, envelope.error, accessToken);
    }
    if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
      throw new HyperagentMcpError(`Hyperagent MCP ${method} returned no result`);
    }
    return { result: envelope.result, sessionId };
  }
}

export function formatHyperagentMcpResult(
  operation: HyperagentMcpOperation,
  result: unknown,
  accessToken: string,
): string {
  return redact(JSON.stringify({ service: 'hyperagent-mcp', operation, result }), accessToken);
}
