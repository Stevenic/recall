import * as path from "path";
import type { FileStorage } from "./interfaces/storage.js";

export interface IdentityConfig {
    /** Path to IDENTITY.md, relative to memory root or absolute. Default: "IDENTITY.md" */
    path?: string;
    /** Display name override. Default: parsed from H1 of the identity file */
    name?: string;
}

export interface ResolvedIdentity {
    /** Display name (from `name` config, the file's H1, or fallback) */
    name: string;
    /** Body of IDENTITY.md (text after the H1). Empty string when fallback. */
    role: string;
    /** Raw file content as read (empty when fallback) */
    raw: string;
    /** Absolute path the loader tried. */
    resolvedPath: string;
    /** True when IDENTITY.md was missing or empty and a generic fallback was used */
    fallback: boolean;
}

const FALLBACK_NAME = "Agent";
const FALLBACK_ROLE = "a knowledge-worker agent";

/**
 * Loader and cache for an agent's IDENTITY.md.
 *
 * Identity is read on first {@link resolve} and cached for the lifetime of
 * the loader. A missing or empty file degrades gracefully to a generic
 * "knowledge-worker agent" role and emits a one-time warning.
 *
 * Call {@link invalidate} after editing IDENTITY.md to force a re-read on
 * the next {@link resolve}.
 */
export class IdentityLoader {
    private readonly _memoryRoot: string;
    private readonly _storage: FileStorage;
    private readonly _config: IdentityConfig;
    private _cached: ResolvedIdentity | null = null;
    private _warned = false;

    constructor(
        memoryRoot: string,
        storage: FileStorage,
        config?: IdentityConfig,
    ) {
        this._memoryRoot = memoryRoot;
        this._storage = storage;
        this._config = config ?? {};
    }

    /** Resolved identity. Cached after the first call. */
    async resolve(): Promise<ResolvedIdentity> {
        if (this._cached) return this._cached;

        const filePath = this._resolvePath();
        const exists = await this._storage.pathExists(filePath);

        if (!exists) {
            this._cached = this._fallback(filePath);
            this._maybeWarn(filePath, "missing");
            return this._cached;
        }

        const buf = await this._storage.readFile(filePath);
        const raw = buf.toString("utf-8");

        if (raw.trim().length === 0) {
            this._cached = this._fallback(filePath);
            this._maybeWarn(filePath, "empty");
            return this._cached;
        }

        const { name, role } = parseIdentityMarkdown(raw);
        this._cached = {
            name: this._config.name ?? name ?? FALLBACK_NAME,
            role: role.length > 0 ? role : FALLBACK_ROLE,
            raw,
            resolvedPath: filePath,
            fallback: false,
        };
        return this._cached;
    }

    /**
     * Build the framing block prepended to every synthesis prompt.
     * Always returns a non-empty string (uses fallback content when needed).
     */
    async frame(): Promise<string> {
        const id = await this.resolve();
        return formatIdentityFrame(id);
    }

    /** Force a re-read on the next {@link resolve}. */
    invalidate(): void {
        this._cached = null;
    }

    private _resolvePath(): string {
        const configured = this._config.path ?? "IDENTITY.md";
        if (path.isAbsolute(configured)) return configured;
        return path.join(this._memoryRoot, configured);
    }

    private _fallback(attemptedPath: string): ResolvedIdentity {
        return {
            name: this._config.name ?? FALLBACK_NAME,
            role: FALLBACK_ROLE,
            raw: "",
            resolvedPath: attemptedPath,
            fallback: true,
        };
    }

    private _maybeWarn(filePath: string, reason: "missing" | "empty"): void {
        if (this._warned) return;
        this._warned = true;
        const detail = reason === "missing" ? "not found" : "is empty";
        console.warn(
            `[recall] IDENTITY.md ${detail} at ${filePath} — falling back to "${FALLBACK_ROLE}". Synthesis quality is reduced; create the file with a one-line role description.`,
        );
    }
}

/**
 * Parse an IDENTITY.md body into `{ name, role }`. The first H1 line becomes
 * the name; everything after it is the role. Returns nulls when the structure
 * does not match.
 */
export function parseIdentityMarkdown(raw: string): {
    name: string | null;
    role: string;
} {
    const lines = raw.split(/\r?\n/);
    let name: string | null = null;
    const bodyLines: string[] = [];

    for (const line of lines) {
        if (name === null) {
            const h1 = line.match(/^#\s+(.+?)\s*$/);
            if (h1) {
                name = h1[1].trim();
                continue;
            }
            if (line.trim().length === 0) continue;
        }
        bodyLines.push(line);
    }

    const role = bodyLines.join("\n").trim();
    return { name, role };
}

/**
 * Render the `<IDENTITY>...</IDENTITY>` framing block used by every synthesis
 * prompt (compactor, wiki stub generation, dreaming, WISDOM distillation).
 */
export function formatIdentityFrame(id: ResolvedIdentity): string {
    const body =
        id.raw.trim().length > 0
            ? id.raw.trim()
            : `# ${id.name}\n\n${id.role}`;
    return `<IDENTITY>\n${body}\n</IDENTITY>`;
}
