import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type {
    MemoryModel,
    CompleteOptions,
    CompletionResult,
} from "../interfaces/model.js";

export type CliAgentName = "claude" | "codex" | "copilot";

export interface CliAgentModelConfig {
    agent: CliAgentName | string;
    args?: string[];
    stdinPrompt?: boolean;
    timeout?: number; // default: 120000
}

interface AgentResolution {
    command: string;
    args: string[];
    stdinPrompt: boolean;
}

const WELL_KNOWN_AGENTS: Record<CliAgentName, AgentResolution> = {
    claude: {
        command: "claude",
        args: ["--print"],
        stdinPrompt: true,
    },
    codex: {
        command: "codex",
        args: [],
        stdinPrompt: true,
    },
    copilot: {
        command: "copilot",
        args: [],
        stdinPrompt: true,
    },
};

/**
 * Default MemoryModel that delegates to a CLI coding agent subprocess.
 */
export class CliAgentModel implements MemoryModel {
    private readonly _config: CliAgentModelConfig;

    constructor(config: CliAgentModelConfig) {
        this._config = config;
    }

    async complete(
        prompt: string,
        options?: CompleteOptions,
    ): Promise<CompletionResult> {
        const resolved = this._resolve();
        const timeout = this._config.timeout ?? 120_000;

        // Build the full prompt including system prompt
        let fullPrompt = prompt;
        if (options?.systemPrompt) {
            fullPrompt = `${options.systemPrompt}\n\n---\n\n${prompt}`;
        }

        try {
            const text = resolved.stdinPrompt
                ? await this._runWithStdin(
                      resolved.command,
                      resolved.args,
                      fullPrompt,
                      timeout,
                  )
                : await this._runWithTempFile(
                      resolved.command,
                      resolved.args,
                      fullPrompt,
                      timeout,
                  );

            return { text: text.trim() };
        } catch (err: unknown) {
            const message =
                err instanceof Error ? err.message : String(err);
            const isTimeout = message.includes("timed out");
            return {
                text: "",
                error: {
                    code: isTimeout ? "timeout" : "model_error",
                    message,
                    retryable: isTimeout,
                },
            };
        }
    }

    private _resolve(): AgentResolution {
        const name = this._config.agent;
        if (name in WELL_KNOWN_AGENTS) {
            const base = WELL_KNOWN_AGENTS[name as CliAgentName];
            return {
                command: base.command,
                args: [...base.args, ...(this._config.args ?? [])],
                stdinPrompt:
                    this._config.stdinPrompt ?? base.stdinPrompt,
            };
        }
        // Custom command
        return {
            command: name,
            args: this._config.args ?? [],
            stdinPrompt: this._config.stdinPrompt ?? false,
        };
    }

    private _runWithStdin(
        command: string,
        args: string[],
        prompt: string,
        timeout: number,
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, {
                stdio: ["pipe", "pipe", "pipe"],
                timeout,
                shell: true,
            });

            let stdout = "";
            let stderr = "";

            child.stdout.on("data", (data: Buffer) => {
                stdout += data.toString();
            });

            child.stderr.on("data", (data: Buffer) => {
                stderr += data.toString();
            });

            child.on("error", (err: Error) => {
                reject(err);
            });

            child.on("close", (code: number | null) => {
                if (code === 0) {
                    resolve(stdout);
                } else {
                    reject(
                        new Error(
                            `Agent exited with code ${code}: ${stderr || stdout}`,
                        ),
                    );
                }
            });

            // Write prompt to stdin with EPIPE protection
            child.stdin.on("error", (err: NodeJS.ErrnoException) => {
                if (
                    err.code !== "EPIPE" &&
                    err.code !== "EOF"
                ) {
                    reject(err);
                }
            });
            child.stdin.end(prompt);
        });
    }

    private async _runWithTempFile(
        command: string,
        args: string[],
        prompt: string,
        timeout: number,
    ): Promise<string> {
        const tmpDir = os.tmpdir();
        const tmpFile = path.join(
            tmpDir,
            `recall-prompt-${Date.now()}.txt`,
        );

        try {
            await fs.writeFile(tmpFile, prompt);
            return await this._runWithStdin(
                command,
                [...args, tmpFile],
                "",
                timeout,
            );
        } finally {
            await fs.unlink(tmpFile).catch(() => {});
        }
    }
}
