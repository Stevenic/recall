/**
 * @recall/bench-harness-mempalace — public API
 *
 * Loaded by `recall-bench run` via a JS module path:
 *
 *   harness:
 *     adapter: ../../bench-harnesses/mempalace/dist/index.js
 *     factory: createMempalaceAdapter
 *     config:
 *       mempalaceCommand: ["uv", "run", "--project", "C:/source/mempalace", "mempalace-mcp"]
 *       synthesisProvider: azure
 *       synthesisModel: gpt-5.4-mini
 *       identityName: Jordan
 *       identity: |
 *         Jordan is an AI executive assistant ...
 *
 * Default export is a `MemorySystemAdapter` instance configured from
 * environment variables, suitable for `recall-bench run --adapter <path>`
 * without a profile.
 */

import { MempalaceAdapter, type MempalaceAdapterConfig } from './adapter.js';

export { MempalaceAdapter } from './adapter.js';
export type { MempalaceAdapterConfig } from './adapter.js';
export type { SynthesisModel, SynthesisOptions } from './synthesis.js';
export type {
    DayMetadata,
    MemorySystemAdapter,
    QueryDetail,
    RetrievalEntry,
} from './types.js';

/**
 * Construct a configured adapter. Prefer this over `new MempalaceAdapter`
 * if you want a stable factory call site.
 */
export function createMempalaceAdapter(
    config: MempalaceAdapterConfig = {},
): MempalaceAdapter {
    return new MempalaceAdapter(config);
}

/**
 * Read adapter config from environment variables. Returns an empty object
 * when nothing is set, so callers can spread it over hard-coded config
 * without overwriting explicit fields.
 */
export function configFromEnv(): MempalaceAdapterConfig {
    const cfg: MempalaceAdapterConfig = {};
    const cmd = process.env['RECALL_MP_COMMAND'];
    if (cmd) {
        // Whitespace-split is fine for the simple `bin arg1 arg2` shapes we expect.
        // For complex argv (paths with spaces), pass `mempalaceCommand` explicitly
        // in the profile config — env-var serialization is best-effort only.
        cfg.mempalaceCommand = cmd.split(/\s+/).filter((p) => p.length > 0);
    }
    const cwd = process.env['RECALL_MP_CWD'];
    if (cwd) cfg.cwd = cwd;
    const palace = process.env['RECALL_MP_PALACE'];
    if (palace) cfg.palacePath = palace;
    const provider = process.env['RECALL_MP_SYNTHESIS_PROVIDER'];
    if (provider === 'openai' || provider === 'azure') cfg.synthesisProvider = provider;
    const synthesisModel = process.env['RECALL_MP_SYNTHESIS_MODEL'];
    if (synthesisModel) cfg.synthesisModel = synthesisModel;
    const searchK = process.env['RECALL_MP_SEARCH_K'];
    if (searchK) {
        const parsed = parseInt(searchK, 10);
        if (Number.isFinite(parsed) && parsed > 0) cfg.searchK = parsed;
    }
    const maxDistance = process.env['RECALL_MP_MAX_DISTANCE'];
    if (maxDistance) {
        const parsed = parseFloat(maxDistance);
        if (Number.isFinite(parsed)) cfg.maxDistance = parsed;
    }
    const timeout = process.env['RECALL_MP_REQUEST_TIMEOUT_MS'];
    if (timeout) {
        const parsed = parseInt(timeout, 10);
        if (Number.isFinite(parsed) && parsed > 0) cfg.requestTimeoutMs = parsed;
    }
    return cfg;
}

/** Default-export instance used by `recall-bench run --adapter <path-to-this-module>`. */
const defaultAdapter = createMempalaceAdapter(configFromEnv());
export default defaultAdapter;
