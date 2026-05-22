/**
 * Model spec parser & provider-aware GeneratorModel factory.
 *
 * Spec syntax: `<provider>:<model>;<optional-endpoint>`
 *
 *   openai:gpt-4o-mini
 *   openai:gpt-4o-mini;https://api.openai.com/v1
 *   anthropic:claude-sonnet-4-6
 *   azure:gpt-4o;https://my-resource.openai.azure.com
 *
 * Provider-specific API keys come from environment variables (typically
 * loaded via dotenv from the profile's `env.file`):
 *
 *   openai     → OPENAI_API_KEY
 *   anthropic  → ANTHROPIC_API_KEY
 *   azure      → AZURE_OPENAI_API_KEY (and optionally AZURE_OPENAI_API_VERSION)
 */

import { OpenAiGeneratorModel } from './openai-generator-model.js';
import { AnthropicGeneratorModel } from './anthropic-generator-model.js';
import { AzureOpenAiGeneratorModel } from './azure-openai-generator-model.js';
import type { GeneratorModel } from './generator-types.js';

export type ModelProvider = 'openai' | 'anthropic' | 'azure';

const PROVIDERS: ReadonlyArray<ModelProvider> = ['openai', 'anthropic', 'azure'];

export interface ModelSpec {
    provider: ModelProvider;
    /** Model id (or, for Azure, deployment name). */
    model: string;
    /** Optional endpoint override; for Azure, the resource base URL. */
    endpoint?: string;
}

/**
 * Parse a `<provider>:<model>;<endpoint>` spec into its parts.
 *
 * Throws if the provider is unknown or the model field is empty. The endpoint
 * is optional; semicolon is the delimiter (chosen because URLs commonly
 * contain colons).
 */
export function parseModelSpec(spec: string): ModelSpec {
    if (typeof spec !== 'string' || spec.trim().length === 0) {
        throw new Error('Model spec is empty.');
    }
    const trimmed = spec.trim();

    // Split provider on first colon, model+endpoint on first semicolon.
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0 || colonIdx === trimmed.length - 1) {
        throw new Error(
            `Invalid model spec "${spec}". Expected "<provider>:<model>" (with optional ";<endpoint>").`,
        );
    }
    const providerRaw = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const rest = trimmed.slice(colonIdx + 1);

    if (!isProvider(providerRaw)) {
        throw new Error(
            `Unknown model provider "${providerRaw}" in spec "${spec}". Supported: ${PROVIDERS.join(', ')}.`,
        );
    }

    const semiIdx = rest.indexOf(';');
    const model = (semiIdx === -1 ? rest : rest.slice(0, semiIdx)).trim();
    const endpoint =
        semiIdx === -1 ? undefined : rest.slice(semiIdx + 1).trim() || undefined;

    if (model.length === 0) {
        throw new Error(`Model spec "${spec}" is missing a model id after the provider.`);
    }

    const result: ModelSpec = { provider: providerRaw, model };
    if (endpoint !== undefined) result.endpoint = endpoint;
    return result;
}

function isProvider(s: string): s is ModelProvider {
    return (PROVIDERS as ReadonlyArray<string>).includes(s);
}

export interface CreateModelOptions {
    /** Per-call request timeout in ms. */
    timeout?: number;
    /** Override the env source (mainly for tests). Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
}

/**
 * Construct a `GeneratorModel` for the given spec, reading API keys from the
 * appropriate provider env vars.
 */
export function createModelFromSpec(
    spec: ModelSpec | string,
    opts: CreateModelOptions = {},
): GeneratorModel {
    const parsed = typeof spec === 'string' ? parseModelSpec(spec) : spec;
    const env = opts.env ?? process.env;

    switch (parsed.provider) {
        case 'openai': {
            const cfg: ConstructorParameters<typeof OpenAiGeneratorModel>[0] = {
                model: parsed.model,
            };
            const key = env.OPENAI_API_KEY;
            if (key) cfg.apiKey = key;
            if (parsed.endpoint) cfg.baseURL = parsed.endpoint;
            if (opts.timeout !== undefined) cfg.timeout = opts.timeout;
            return new OpenAiGeneratorModel(cfg);
        }
        case 'anthropic': {
            const cfg: ConstructorParameters<typeof AnthropicGeneratorModel>[0] = {
                model: parsed.model,
            };
            const key = env.ANTHROPIC_API_KEY;
            if (key) cfg.apiKey = key;
            if (parsed.endpoint) cfg.baseURL = parsed.endpoint;
            if (opts.timeout !== undefined) cfg.timeout = opts.timeout;
            return new AnthropicGeneratorModel(cfg);
        }
        case 'azure': {
            const cfg: ConstructorParameters<typeof AzureOpenAiGeneratorModel>[0] = {
                deployment: parsed.model,
            };
            const key = env.AZURE_OPENAI_API_KEY ?? env.OPENAI_API_KEY;
            if (key) cfg.apiKey = key;
            const endpoint = parsed.endpoint ?? env.AZURE_OPENAI_ENDPOINT;
            if (endpoint) cfg.endpoint = endpoint;
            const apiVersion = env.AZURE_OPENAI_API_VERSION;
            if (apiVersion) cfg.apiVersion = apiVersion;
            if (opts.timeout !== undefined) cfg.timeout = opts.timeout;
            return new AzureOpenAiGeneratorModel(cfg);
        }
    }
}

/**
 * Returns true when the given string looks like a model spec
 * (`<provider>:<model>...`) — used by the CLI to route between specs and
 * legacy module-path-based selectors.
 */
export function isModelSpec(value: string): boolean {
    if (typeof value !== 'string') return false;
    const colonIdx = value.indexOf(':');
    if (colonIdx <= 0) return false;
    const providerRaw = value.slice(0, colonIdx).toLowerCase();
    return isProvider(providerRaw);
}
