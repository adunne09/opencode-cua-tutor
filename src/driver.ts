/**
 * Minimal Cua Driver MCP client for tutor mode.
 *
 * SAFETY: tutor mode must never click or type. This wrapper only exposes an allowlist of
 * read-only tools plus the agent-cursor overlay tools. move_cursor is always sent WITHOUT a
 * `target` and WITHOUT `scope:"desktop"`, which per the Cua Driver reference moves "only the
 * agent cursor overlay, in screen points" and never the user's real pointer.
 * Source: docs/content/docs/cua-driver/reference/mcp-tools/pointer-cursor-and-browser.mdx
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomUUID } from 'node:crypto';

const ALLOWED_TOOLS = new Set([
  'list_apps',
  'list_windows',
  'get_window_state',
  'move_cursor',
  'set_agent_cursor_enabled',
  'set_agent_cursor_motion',
  'start_session',
  'get_agent_cursor_state',
]);

export type WindowInfo = {
  window_id: number;
  pid: number;
  app_name?: string;
  title?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  z_index?: number | null;
  is_on_screen?: boolean;
  on_current_space?: boolean;
  layer?: number;
};

const visible = (w: WindowInfo) => w.is_on_screen !== false && w.on_current_space !== false && (w.layer ?? 0) === 0;
const byZ = (a: WindowInfo, b: WindowInfo) => (b.z_index ?? -1) - (a.z_index ?? -1);

/** The driver needs OS discovery/config, not the parent's unrelated provider credentials. */
export function driverEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    value !== undefined && (/^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|XDG_CONFIG_HOME|XDG_DATA_HOME)$/.test(key) ||
      key.startsWith('LC_') || key.startsWith('CUA_DRIVER_'))
  )) as Record<string, string>;
}

export class CuaDriver {
  private client?: Client;
  private connecting?: Promise<Client>;
  private closed = false;
  private started = false;
  private sessionTouched = false;
  private starting?: Promise<void>;
  readonly session: string;
  /** Every Cua Driver tool this wrapper has sent, in order (for audits and the debug CLI). */
  readonly history: string[] = [];
  /** Count actual screenshot-bearing MCP requests, not inferred visual decisions. */
  screenshotRequests = 0;

  constructor(
    private readonly binary: string,
    sessionPrefix: string,
    private readonly env = driverEnvironment()
  ) {
    this.session = `${sessionPrefix.slice(0, 40)}-${randomUUID().slice(0, 8)}`;
  }

  private async connect(signal?: AbortSignal): Promise<Client> {
    if (this.closed) throw new Error('Tutor driver is closed');
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: 'opencode-cua-tutor', version: '0.2.0' });
        const transport = new StdioClientTransport({ command: this.binary, args: ['mcp'], env: this.env });
        try {
          await client.connect(transport, { signal, timeout: 5000 });
          if (this.closed) throw new Error('Tutor driver closed during connection');
          this.client = client;
          return client;
        } catch (error) {
          await client.close().catch(() => {});
          await transport.close().catch(() => {});
          throw error;
        } finally {
          this.connecting = undefined;
        }
      })();
    }
    return this.connecting;
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.callWithImages(name, args, signal)).data;
  }

  /** Like `call`, plus any base64 image content blocks (get_window_state's screenshot). */
  async callWithImages(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ data: Record<string, unknown>; images: string[] }> {
    if (!ALLOWED_TOOLS.has(name)) throw new Error(`tutor mode refuses Cua Driver tool ${name}`);
    if (args.session !== undefined && args.session !== this.session) throw new Error('Tutor cannot control another cursor session');
    if (name === 'move_cursor' && ('target' in args || 'scope' in args || 'delivery_mode' in args)) {
      throw new Error('tutor mode only moves the agent cursor overlay');
    }
    if ((name === 'move_cursor' || name === 'start_session' || name.includes('agent_cursor')) && args.session !== this.session) {
      throw new Error('Tutor cursor calls require their own session');
    }
    signal?.throwIfAborted();
    const client = await this.connect(signal);
    signal?.throwIfAborted();
    this.history.push(name);
    if (name === 'get_window_state' && args.include_screenshot !== false) this.screenshotRequests++;
    const result = (await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 5000 })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content?: { type: string; text?: string; data?: string }[];
    };
    const images = (result.content ?? []).filter((p) => p.type === 'image' && p.data).map((p) => p.data as string);
    const text = (result.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n');
    if (result.isError) throw new Error(`cua-driver ${name}: ${text || 'error'}`);
    const checked = (data: Record<string, unknown>) => {
      if (data.ok === false || data.success === false) throw new Error(`cua-driver ${name} refused the request`);
      return { data, images };
    };
    if (result.structuredContent) return checked(result.structuredContent);
    // TODO(verify): every tool we use is documented to return structuredContent; fall back to JSON text.
    let data: Record<string, unknown>;
    try { data = JSON.parse(text) as Record<string, unknown>; }
    catch { data = { text }; }
    return checked(data);
  }

  async ensureSession(signal?: AbortSignal): Promise<void> {
    if (this.started) return;
    if (!this.starting) {
      // The server may create the session even if cancellation loses its reply.
      this.sessionTouched = true;
      this.starting = this.call('start_session', { session: this.session }, signal)
        .then(() => { this.started = true; })
        .finally(() => { this.starting = undefined; });
    }
    await this.starting;
    signal?.throwIfAborted();
  }

  private windowsOf(result: Record<string, unknown>): WindowInfo[] {
    return ((result.windows ?? result.items ?? []) as WindowInfo[]).filter(visible);
  }

  /** Frontmost on-screen window of the named app (name substring or bundle id, as list_windows matches). */
  async findWindow(app: string, signal?: AbortSignal): Promise<WindowInfo> {
    const windows = this.windowsOf(await this.call('list_windows', { app }, signal));
    if (!windows.length) throw new Error(`${app} has no on-screen window. Open it first.`);
    // Prefer an exact app-name match over a substring hit ("Notes" vs "Sticky Notes").
    const exact = windows.filter((w) => (w.app_name ?? '').toLowerCase() === app.toLowerCase());
    return (exact.length ? exact : windows).sort(byZ)[0];
  }

  async frontWindowOf(pid: number, signal?: AbortSignal): Promise<WindowInfo | undefined> {
    return this.windowsOf(await this.call('list_windows', { pid }, signal)).filter((w) => w.pid === pid).sort(byZ)[0];
  }

  /** Unique app names with an on-screen window, sorted longest-first for safe explicit-mention matching. */
  async openAppNames(signal?: AbortSignal): Promise<string[]> {
    const windows = this.windowsOf(await this.call('list_windows', { on_screen_only: true }, signal));
    const seen = new Map<string, string>();
    for (const w of windows) {
      const name = w.app_name?.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, name);
    }
    return [...seen.values()].sort((a, b) => b.length - a.length);
  }

  /** Full metadata makes walk-budget exhaustion distinguishable from unknown AX coverage. */
  async windowState(pid: number, windowId: number, signal?: AbortSignal, screenshot = false, expanded = false): Promise<{ data: Record<string, unknown>; images: string[] }> {
    return this.callWithImages('get_window_state', {
      pid,
      window_id: windowId,
      tree_format: 'elements',
      full_output: true,
      max_elements: expanded ? 2000 : 1500,
      max_depth: expanded ? 50 : 25,
      timeout_ms: expanded ? 4000 : 3000,
      include_screenshot: screenshot,
      ...(screenshot ? { max_image_dimension: 0, screenshot_format: 'png' } : {}),
      session: this.session,
    }, signal);
  }

  /** Glide the session's agent cursor (overlay only) to a screen point. Never clicks. */
  async pointAt(x: number, y: number, signal?: AbortSignal): Promise<void> {
    await this.ensureSession(signal);
    await this.call('set_agent_cursor_enabled', { session: this.session, enabled: true }, signal);
    signal?.throwIfAborted();
    await this.call('move_cursor', { x, y, session: this.session }, signal);
    signal?.throwIfAborted();
  }

  async clear(): Promise<void> {
    if (!this.sessionTouched || !this.client) return;
    await this.call('set_agent_cursor_enabled', { session: this.session, enabled: false }, AbortSignal.timeout(2000));
  }

  /** Where the session's agent cursor is now (screen points), for verification. Read-only. */
  async cursorState(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.call('get_agent_cursor_state', { session: this.session }, signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.connecting?.catch(() => {});
    await this.starting?.catch(() => {});
    if (this.sessionTouched && this.client) {
      await this.client.callTool(
        { name: 'set_agent_cursor_enabled', arguments: { session: this.session, enabled: false } },
        undefined, { timeout: 2000 }
      ).catch(() => {});
    }
    await this.client?.close().catch(() => {});
    this.client = undefined;
    this.started = false;
    this.sessionTouched = false;
  }
}
