/**
 * GeneratorModel implementation that delegates to CLI coding agents
 * (claude, codex, copilot) by spawning them as subprocesses.
 *
 * Adapted from packages/core/src/defaults/cli-agent-model.ts for the
 * GeneratorModel interface used by the bench pipeline.
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { GeneratorModel, GeneratorModelOptions, GeneratorModelResult } from './generator-types.js';

export type CliAgentName = 'claude' | 'codex' | 'copilot';

export interface CliGeneratorModelConfig {
    agent: CliAgentName | string;
    args?: string[];
    stdinPrompt?: boolean;
    timeout?: number; // default: 120_000
}

interface AgentResolution {
    command: string;
    args: string[];
    stdinPrompt: boolean;
}

const WELL_KNOWN_AGENTS: Record<CliAgentName, AgentResolution> = {
    claude: {
        command: 'claude',
        args: ['--print'],
        stdinPrompt: true,
    },
    codex: {
        command: 'codex',
        args: [],
        stdinPrompt: true,
    },
    copilot: {
        command: 'copilot',
        args: [],
        stdinPrompt: true,
    },
};

/** Names of built-in CLI agents. */
export const CLI_AGENT_NAMES: readonly string[] = Object.keys(WELL_KNOWN_AGENTS);

/** Check whether a string is a known agent name. */
export function isCliAgentName(name: string): name is CliAgentName {
    return name in WELL_KNOWN_AGENTS;
}

/**
 * GeneratorModel backed by a CLI coding agent subprocess.
 *
 * Usage:
 * ```ts
 * const model = new CliGeneratorModel({ agent: 'claude' });
 * const result = await model.complete(systemPrompt, userMessage, { temperature: 0.7 });
 * ```
 */
export class CliGeneratorModel implements GeneratorModel {
    private readonly _config: CliGeneratorModelConfig;

    constructor(config: CliGeneratorModelConfig) {
        this._config = config;
    }

    async complete(
        systemPrompt: string,
        userMessage: string,
        options?: GeneratorModelOptions,
    ): Promise<GeneratorModelResult> {
        const resolved = this._resolve(options);
        const timeout = this._config.timeout ?? 120_000;

        // Combine system prompt and user message with a separator
        const fullPrompt = `${systemPrompt}\n\n---\n\n${userMessage}`;

        const text = resolved.stdinPrompt
            ? await runWithStdin(resolved.command, resolved.args, fullPrompt, timeout)
            : await runWithTempFile(resolved.command, resolved.args, fullPrompt, timeout);

        return { text: text.trim() };
    }

    private _resolve(options?: GeneratorModelOptions): AgentResolution {
        const name = this._config.agent;
        const extraArgs = [...(this._config.args ?? [])];

        // Well-known coding-agent CLIs (claude, codex, copilot) don't accept
        // --temperature / --max-tokens flags. Only pass them to custom commands.
        const isWellKnown = name in WELL_KNOWN_AGENTS;
        if (!isWellKnown) {
            if (options?.temperature !== undefined) {
                extraArgs.push('--temperature', String(options.temperature));
            }
            if (options?.maxTokens !== undefined) {
                extraArgs.push('--max-tokens', String(options.maxTokens));
            }
        }

        if (isWellKnown) {
            const base = WELL_KNOWN_AGENTS[name as CliAgentName];
            return {
                command: base.command,
                args: [...base.args, ...extraArgs],
                stdinPrompt: this._config.stdinPrompt ?? base.stdinPrompt,
            };
        }

        // Custom command
        return {
            command: name,
            args: extraArgs,
            stdinPrompt: this._config.stdinPrompt ?? false,
        };
    }
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

function runWithStdin(
    command: string,
    args: string[],
    prompt: string,
    timeout: number,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

        // Explicit watchdog — spawn()'s `timeout` option uses SIGTERM, which
        // Windows does not actually deliver; a hung subprocess can sit forever.
        // Force-kill with tree-kill semantics via taskkill on Windows, SIGKILL
        // on POSIX.
        const watchdog = setTimeout(() => {
            killChildTree(child);
            done(() => reject(new Error(`Agent timed out after ${timeout}ms`)));
        }, timeout);

        child.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        child.on('error', (err: Error) => {
            clearTimeout(watchdog);
            done(() => reject(err));
        });

        child.on('close', (code: number | null) => {
            clearTimeout(watchdog);
            if (code === 0) {
                done(() => resolve(stdout));
            } else {
                done(() => reject(
                    new Error(`Agent exited with code ${code}: ${stderr || stdout}`),
                ));
            }
        });

        // Write prompt to stdin with EPIPE protection
        child.stdin.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code !== 'EPIPE' && err.code !== 'EOF') {
                clearTimeout(watchdog);
                done(() => reject(err));
            }
        });
        child.stdin.end(prompt);
    });
}

/**
 * Force-kill a spawned child and its descendants. On Windows we use
 * taskkill /T /F because SIGTERM/SIGKILL are not honored reliably by
 * shell-launched subprocesses. On POSIX we fall back to SIGKILL.
 */
function killChildTree(child: ReturnType<typeof spawn>): void {
    if (child.killed || child.pid === undefined) return;
    if (process.platform === 'win32') {
        try {
            // `spawn` with shell: true wraps the command in cmd.exe — we need
            // to kill the tree so claude.cmd's child processes don't linger.
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                stdio: 'ignore',
                shell: false,
            });
        } catch {
            // Best effort; fall through to kill() below.
        }
    }
    try {
        child.kill('SIGKILL');
    } catch {
        // Already dead or unkillable — nothing more we can do.
    }
}

async function runWithTempFile(
    command: string,
    args: string[],
    prompt: string,
    timeout: number,
): Promise<string> {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `recall-bench-prompt-${Date.now()}.txt`);

    try {
        await fs.writeFile(tmpFile, prompt);
        return await runWithStdin(command, [...args, tmpFile], '', timeout);
    } finally {
        await fs.unlink(tmpFile).catch(() => {});
    }
}
