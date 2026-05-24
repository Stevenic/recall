/**
 * Minimal MCP JSON-RPC client over stdio.
 *
 * MemPalace's `mempalace-mcp` server speaks the standard MCP protocol —
 * newline-delimited JSON-RPC 2.0 on stdout, logs on stderr. We only need
 * `initialize`, `tools/call`, and `ping`, so we don't pull in a full MCP SDK.
 *
 * Single in-flight request at a time. The bench drives the adapter
 * sequentially (one ingestDay or query call resolves before the next),
 * which matches the server's request/response cadence. Concurrent calls
 * would interleave on the JSON-RPC `id` field — the queue here serializes
 * them anyway as a safety net.
 */

import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface, Interface } from 'node:readline';

export interface McpClientOptions {
    /**
     * argv vector for spawning the MCP server. The harness appends
     * `--palace <path>` automatically; do not include it here.
     */
    command: string[];
    /** Working directory for the spawned process. Default: cwd. */
    cwd?: string;
    /** Extra env vars merged onto process.env. */
    env?: Record<string, string>;
    /** Palace directory to back the server. Appended as `--palace <path>`. */
    palacePath: string;
    /**
     * Per-request timeout in ms. Search calls on a warm HNSW are well under
     * a second; cold start (embedder load) can take ~15s. Default: 60_000.
     */
    requestTimeoutMs?: number;
    /**
     * Capture stderr lines. Default: forwarded as-is to process.stderr so
     * operators see mempalace's server logs alongside bench output.
     */
    onStderr?: (line: string) => void;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT = 60_000;

export class McpClient {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private stdoutReader: Interface | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private exited = false;

    constructor(private readonly opts: McpClientOptions) {
        if (!opts.command || opts.command.length === 0) {
            throw new Error('McpClient: command must be a non-empty argv array');
        }
        if (!opts.palacePath) {
            throw new Error('McpClient: palacePath is required');
        }
    }

    async start(): Promise<void> {
        if (this.proc) throw new Error('McpClient.start called twice');
        const [bin, ...args] = this.opts.command;
        const fullArgs = [...args, '--palace', this.opts.palacePath];
        this.proc = spawn(bin!, fullArgs, {
            cwd: this.opts.cwd,
            env: { ...process.env, ...this.opts.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        }) as ChildProcessWithoutNullStreams;

        this.proc.on('exit', (code, signal) => {
            this.exited = true;
            const reason = new Error(
                `mempalace-mcp exited (code=${code} signal=${signal ?? 'none'})`,
            );
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(reason);
            }
            this.pending.clear();
        });

        this.proc.on('error', (err) => {
            const reason = new Error(`mempalace-mcp spawn error: ${err.message}`);
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(reason);
            }
            this.pending.clear();
        });

        // Forward server-side logs so the bench operator can see mempalace's
        // own diagnostics inline. Each chunk is split on newlines to keep
        // the bench output line-aligned.
        this.proc.stderr.setEncoding('utf-8');
        this.proc.stderr.on('data', (chunk: string) => {
            for (const line of chunk.split(/\r?\n/)) {
                if (!line) continue;
                if (this.opts.onStderr) {
                    this.opts.onStderr(line);
                } else {
                    process.stderr.write(`[mempalace-mcp] ${line}\n`);
                }
            }
        });

        this.proc.stdout.setEncoding('utf-8');
        this.stdoutReader = createInterface({ input: this.proc.stdout });
        this.stdoutReader.on('line', (line: string) => this.handleLine(line));

        // MCP handshake. Mempalace negotiates protocolVersion automatically.
        await this.request('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: '@recall/bench-harness-mempalace', version: '0.1.0' },
        });
        // The "initialized" notification is required by some clients; mempalace
        // ignores notifications/* but sending it is the polite handshake step.
        this.notify('notifications/initialized', {});
    }

    /** Send a `tools/call` for the named tool with the given arguments. */
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        const reply = (await this.request('tools/call', {
            name,
            arguments: args,
        })) as McpToolCallReply;
        if (reply?.isError) {
            const text = extractFirstText(reply.content) ?? JSON.stringify(reply);
            throw new Error(`Tool ${name} failed: ${text}`);
        }
        const text = extractFirstText(reply?.content);
        if (text == null) {
            return reply;
        }
        try {
            return JSON.parse(text);
        } catch {
            return { raw: text };
        }
    }

    async stop(): Promise<void> {
        if (!this.proc || this.exited) {
            this.proc = null;
            return;
        }
        try {
            this.proc.stdin.end();
        } catch {
            // ignore
        }
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                try {
                    this.proc?.kill('SIGKILL');
                } catch {
                    // ignore
                }
                resolve();
            }, 5_000);
            this.proc!.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
        this.stdoutReader?.close();
        this.stdoutReader = null;
        this.proc = null;
    }

    private notify(method: string, params: unknown): void {
        if (!this.proc || this.exited) return;
        const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
        this.proc.stdin.write(payload + '\n');
    }

    private request(method: string, params: unknown): Promise<unknown> {
        if (!this.proc || this.exited) {
            return Promise.reject(new Error('McpClient is not running'));
        }
        const id = this.nextId++;
        const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP request "${method}" (id=${id}) timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
            this.proc!.stdin.write(payload + '\n');
        });
    }

    private handleLine(line: string): void {
        if (!line.trim()) return;
        let msg: unknown;
        try {
            msg = JSON.parse(line);
        } catch {
            // Not JSON — almost certainly a stdout leak from a dependency.
            // Mempalace pipes its own deps to stderr (see mcp_server.py top),
            // but defend against new leaks anyway.
            process.stderr.write(`[mempalace-mcp:stdout] ${line}\n`);
            return;
        }
        const m = msg as { id?: number; result?: unknown; error?: { message?: string; code?: number } };
        if (typeof m.id !== 'number') return; // notifications (no id) are dropped
        const pending = this.pending.get(m.id);
        if (!pending) return;
        this.pending.delete(m.id);
        clearTimeout(pending.timer);
        if (m.error) {
            pending.reject(new Error(`MCP error ${m.error.code ?? '?'}: ${m.error.message ?? 'unknown'}`));
        } else {
            pending.resolve(m.result);
        }
    }
}

interface McpToolCallReply {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
}

function extractFirstText(content: McpToolCallReply['content']): string | null {
    if (!Array.isArray(content)) return null;
    for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
    }
    return null;
}
