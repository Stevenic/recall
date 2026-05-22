/**
 * Profile loader: parses a YAML file describing a recall-bench run end-to-end
 * (persona/dataset, env file, models, harness, per-operation defaults).
 *
 * Inner paths are resolved **relative to the profile file** unless they are
 * absolute. The loader can also apply a profile's `env.file` via dotenv so
 * provider API keys are available before the CLI builds models.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import YAML from 'yaml';
import type { TimeRange } from './types.js';
import { parseTimeRange, expandRangeSeries } from './types.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface ProfilePersona {
    /** Persona id (matches the directory name). */
    id: string;
    /** Path to the persona directory. May be absolute or relative to the profile. */
    dir?: string;
    /**
     * Arcs filename within the persona dir. Memories/qa dirs are derived from
     * the filename suffix (e.g., `arcs-180d.yaml` → `memories-180d/`, `qa-180d/`).
     * Default: `arcs-1000d.yaml`.
     */
    arcs?: string;
}

export interface ProfileEnv {
    /** Path to a .env file. May be absolute or relative to the profile. */
    file?: string;
}

export interface ProfileModels {
    /** Generation model spec, e.g. `openai:gpt-4o-mini`. */
    generation?: string;
    /** Judge model spec used by the bench harness. */
    judge?: string;
    /**
     * Optional appellate judge spec. When set, primary-judge failures are
     * re-scored by this judge; the appellate verdict is final. See
     * HarnessConfig.appellateJudge.
     */
    appellateJudge?: string;
    /** Optional override used by `create-persona`. Defaults to `generation`. */
    creation?: string;
    /** Optional override used by `generate-conversations`. Defaults to `generation`. */
    conversation?: string;
}

export interface ProfileHarness {
    /** Adapter module path (absolute or relative to the profile) or gRPC URL. */
    adapter: string;
    /**
     * Optional named export to call as a factory with `config`. When omitted,
     * the module's default export is used as a `MemorySystemAdapter` instance.
     */
    factory?: string;
    /** Pass-through config object handed to the factory. */
    config?: Record<string, unknown>;
}

export interface ProfileRun {
    ranges?: TimeRange[];
    seed?: number;
    timeout?: number;
    parallelism?: number;
    /** Per-checkpoint cap on historical-question evaluations (see HarnessConfig.sample). */
    sample?: number;
    /** Days-around-relevant-day window the judge sees for grounding (see HarnessConfig.judgeMemoryWindow). */
    judgeMemoryWindow?: number;
    /**
     * Enable group-aware categories. When false (default), the harness skips
     * `group-session-attribution` and `information-boundary` Q&A pairs — no
     * known memory system supports per-session access controls today, so
     * those rows otherwise add noise. When true, both categories run AND the
     * judge receives boundary metadata for `information-boundary` pairs.
     */
    groupsEnabled?: boolean;
}

export interface ProfileGenerate {
    days?: number;
    start?: number;
    end?: number;
    temperature?: number;
    maxTokens?: number;
    historyWindow?: number;
}

export interface Profile {
    /** Absolute path to the profile YAML file (set by `loadProfile`). */
    profilePath: string;
    /** Directory containing the profile (used to resolve inner relative paths). */
    profileDir: string;
    persona?: ProfilePersona;
    env?: ProfileEnv;
    models?: ProfileModels;
    harness?: ProfileHarness;
    run?: ProfileRun;
    generate?: ProfileGenerate;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load a profile YAML, validate the shape, and return the parsed object with
 * `profilePath` / `profileDir` populated for downstream relative-path resolution.
 */
export async function loadProfile(profilePath: string): Promise<Profile> {
    const abs = path.resolve(profilePath);
    const raw = await readFile(abs, 'utf8');
    let parsed: unknown;
    try {
        parsed = YAML.parse(raw);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to parse profile YAML at ${abs}: ${detail}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Profile at ${abs} must be a YAML mapping at the top level.`);
    }
    const validated = validateProfile(parsed as Record<string, unknown>, abs);
    return {
        ...validated,
        profilePath: abs,
        profileDir: path.dirname(abs),
    };
}

/**
 * Apply a profile's `env.file` via dotenv so provider API keys land in
 * `process.env` before model factories are constructed. Idempotent — repeat
 * calls won't re-load the same file.
 */
export function applyProfileEnv(profile: Profile, override = false): void {
    const envFile = profile.env?.file;
    if (!envFile) return;
    const abs = resolveProfilePath(profile, envFile);
    dotenvConfig({ path: abs, override });
}

/**
 * Resolve a path inside a profile relative to the profile file itself.
 * Absolute paths are returned unchanged.
 */
export function resolveProfilePath(profile: Profile, p: string): string {
    if (path.isAbsolute(p)) return p;
    return path.resolve(profile.profileDir, p);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateProfile(raw: Record<string, unknown>, source: string): Omit<Profile, 'profilePath' | 'profileDir'> {
    const out: Omit<Profile, 'profilePath' | 'profileDir'> = {};

    if (raw.persona !== undefined) {
        out.persona = validatePersona(raw.persona, source);
    }
    if (raw.env !== undefined) {
        out.env = validateEnv(raw.env, source);
    }
    if (raw.models !== undefined) {
        out.models = validateModels(raw.models, source);
    }
    if (raw.harness !== undefined) {
        out.harness = validateHarness(raw.harness, source);
    }
    if (raw.run !== undefined) {
        out.run = validateRun(raw.run, source);
    }
    if (raw.generate !== undefined) {
        out.generate = validateGenerate(raw.generate, source);
    }
    return out;
}

function validatePersona(raw: unknown, source: string): ProfilePersona {
    const obj = expectObject(raw, 'persona', source);
    const id = expectString(obj.id, 'persona.id', source);
    const persona: ProfilePersona = { id };
    if (obj.dir !== undefined) persona.dir = expectString(obj.dir, 'persona.dir', source);
    if (obj.arcs !== undefined) persona.arcs = expectString(obj.arcs, 'persona.arcs', source);
    return persona;
}

function validateEnv(raw: unknown, source: string): ProfileEnv {
    const obj = expectObject(raw, 'env', source);
    const env: ProfileEnv = {};
    if (obj.file !== undefined) env.file = expectString(obj.file, 'env.file', source);
    return env;
}

function validateModels(raw: unknown, source: string): ProfileModels {
    const obj = expectObject(raw, 'models', source);
    const models: ProfileModels = {};
    for (const k of ['generation', 'judge', 'appellateJudge', 'creation', 'conversation'] as const) {
        if (obj[k] !== undefined) models[k] = expectString(obj[k], `models.${k}`, source);
    }
    return models;
}

function validateHarness(raw: unknown, source: string): ProfileHarness {
    const obj = expectObject(raw, 'harness', source);
    const adapter = expectString(obj.adapter, 'harness.adapter', source);
    const harness: ProfileHarness = { adapter };
    if (obj.factory !== undefined) {
        harness.factory = expectString(obj.factory, 'harness.factory', source);
    }
    if (obj.config !== undefined) {
        if (typeof obj.config !== 'object' || obj.config === null || Array.isArray(obj.config)) {
            throw new Error(`Profile ${source}: "harness.config" must be an object/mapping.`);
        }
        harness.config = obj.config as Record<string, unknown>;
    }
    return harness;
}

function validateRun(raw: unknown, source: string): ProfileRun {
    const obj = expectObject(raw, 'run', source);
    const run: ProfileRun = {};
    if (obj.ranges !== undefined) {
        run.ranges = parseProfileRanges(obj.ranges, source);
    }
    if (obj.seed !== undefined) run.seed = expectNumber(obj.seed, 'run.seed', source);
    if (obj.timeout !== undefined) run.timeout = expectNumber(obj.timeout, 'run.timeout', source);
    if (obj.parallelism !== undefined) run.parallelism = expectNumber(obj.parallelism, 'run.parallelism', source);
    if (obj.sample !== undefined) run.sample = expectNumber(obj.sample, 'run.sample', source);
    if (obj.judgeMemoryWindow !== undefined) run.judgeMemoryWindow = expectNumber(obj.judgeMemoryWindow, 'run.judgeMemoryWindow', source);
    if (obj.groupsEnabled !== undefined) {
        if (typeof obj.groupsEnabled !== 'boolean') {
            throw new Error(`Profile ${source}: "run.groupsEnabled" must be a boolean, got ${typeof obj.groupsEnabled}.`);
        }
        run.groupsEnabled = obj.groupsEnabled;
    }
    return run;
}

/**
 * Parse the profile's `run.ranges` value. Accepts:
 *   - Array of numbers (days) or strings ("30d", "6mo", "1y", "full", "180")
 *   - Object `{ start, end, step }` describing an arithmetic progression
 *     (e.g., `{ start: 6, end: 180, step: 6 }` → 30 checkpoints every 6 days)
 *   - Object `{ series: [...] }` carrying the same array form as above
 */
function parseProfileRanges(raw: unknown, source: string): TimeRange[] {
    if (Array.isArray(raw)) {
        return raw.map((r) => {
            try {
                return parseTimeRange(r as string | number);
            } catch (err) {
                throw new Error(
                    `Profile ${source}: "run.ranges" contains invalid entry "${String(r)}": ${(err as Error).message}`,
                );
            }
        });
    }
    if (raw && typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        if ('start' in obj || 'end' in obj || 'step' in obj) {
            const start = expectNumber(obj.start, 'run.ranges.start', source);
            const end = expectNumber(obj.end, 'run.ranges.end', source);
            const step = expectNumber(obj.step, 'run.ranges.step', source);
            return expandRangeSeries({ start, end, step });
        }
        if (Array.isArray(obj.series)) {
            return parseProfileRanges(obj.series, source);
        }
    }
    throw new Error(
        `Profile ${source}: "run.ranges" must be an array (e.g. [30d, 90d, 6mo]) or a {start, end, step} object.`,
    );
}

function validateGenerate(raw: unknown, source: string): ProfileGenerate {
    const obj = expectObject(raw, 'generate', source);
    const gen: ProfileGenerate = {};
    for (const k of ['days', 'start', 'end', 'temperature', 'maxTokens', 'historyWindow'] as const) {
        if (obj[k] !== undefined) gen[k] = expectNumber(obj[k], `generate.${k}`, source);
    }
    return gen;
}

function expectObject(raw: unknown, field: string, source: string): Record<string, unknown> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`Profile ${source}: "${field}" must be a mapping.`);
    }
    return raw as Record<string, unknown>;
}

function expectString(raw: unknown, field: string, source: string): string {
    if (typeof raw !== 'string') {
        throw new Error(`Profile ${source}: "${field}" must be a string, got ${typeof raw}.`);
    }
    return raw;
}

function expectNumber(raw: unknown, field: string, source: string): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new Error(`Profile ${source}: "${field}" must be a finite number, got ${String(raw)}.`);
    }
    return raw;
}
