/**
 * GeneratorModel implementation backed by the OpenAI Chat Completions API.
 *
 * Resolved by the CLI when --model is `openai` (default model) or
 * `openai:<model-id>` (specific model, e.g. `openai:gpt-4o`,
 * `openai:gpt-5`, `openai:o3-mini`).
 *
 * Authentication: reads `OPENAI_API_KEY` from the environment by default,
 * or pass `apiKey` in the config. For Azure OpenAI / proxied deployments,
 * pass `baseURL` to override the endpoint.
 *
 * Used by both the generation pipeline (persona-creator, day-generator,
 * conversation-generator) and the bench harness's judge model.
 */

import OpenAI from 'openai';
import type { GeneratorModel, GeneratorModelOptions, GeneratorModelResult } from './generator-types.js';

/** Prefix for --model values that route to OpenAI. */
export const OPENAI_PREFIX = 'openai';

/** Default OpenAI model ID when --model is just `openai` with no `:<id>` suffix. */
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

/** Type alias for the subset of the OpenAI client surface we depend on. Lets us
 *  inject mocks in tests without pulling in the full SDK. */
export type OpenAiClientLike = Pick<OpenAI, 'chat'>;

export interface OpenAiGeneratorModelConfig {
    /** OpenAI model ID (e.g. 'gpt-4o-mini', 'gpt-4o', 'gpt-5', 'o3-mini'). Default: gpt-4o-mini. */
    model?: string;
    /** API key. Defaults to `process.env.OPENAI_API_KEY`. */
    apiKey?: string;
    /** Override base URL (e.g. for Azure OpenAI or a proxy). Default: OpenAI's standard endpoint. */
    baseURL?: string;
    /** Per-call request timeout in ms. Default: undefined (SDK default). */
    timeout?: number;
    /** Pre-built client. When supplied, apiKey/baseURL/timeout above are ignored. Useful for tests. */
    client?: OpenAiClientLike;
}

/**
 * Returns true when `name` is the `openai` shorthand or a `openai:<model-id>`
 * specifier. Used by the CLI to dispatch --model values.
 */
export function isOpenAiSpec(name: string): boolean {
    return name === OPENAI_PREFIX || name.startsWith(`${OPENAI_PREFIX}:`);
}

/**
 * Parse an `openai` or `openai:<model-id>` spec into a model ID.
 * Throws on a `openai:` specifier with an empty model id.
 */
export function parseOpenAiSpec(name: string): { model: string } {
    if (name === OPENAI_PREFIX) return { model: OPENAI_DEFAULT_MODEL };
    if (!name.startsWith(`${OPENAI_PREFIX}:`)) {
        throw new Error(`Not an OpenAI spec: ${name}`);
    }
    const model = name.substring(OPENAI_PREFIX.length + 1).trim();
    if (model.length === 0) {
        throw new Error(`OpenAI spec missing model id after colon: '${name}'. Use 'openai' for the default or 'openai:gpt-4o' to specify a model.`);
    }
    return { model };
}

/**
 * GeneratorModel backed by an OpenAI Chat Completions request.
 *
 * Usage:
 * ```ts
 * const model = new OpenAiGeneratorModel({ model: 'gpt-4o' });
 * const result = await model.complete(systemPrompt, userMessage, { temperature: 0.7 });
 * ```
 */
export class OpenAiGeneratorModel implements GeneratorModel {
    private readonly _client: OpenAiClientLike;
    private readonly _model: string;

    constructor(config: OpenAiGeneratorModelConfig = {}) {
        if (config.client) {
            this._client = config.client;
        } else {
            const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
            if (!apiKey) {
                throw new Error(
                    'OpenAI API key not found. Set OPENAI_API_KEY in your environment or pass `apiKey` in OpenAiGeneratorModelConfig.',
                );
            }
            const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey };
            if (config.baseURL !== undefined) opts.baseURL = config.baseURL;
            if (config.timeout !== undefined) opts.timeout = config.timeout;
            this._client = new OpenAI(opts);
        }
        this._model = config.model ?? OPENAI_DEFAULT_MODEL;
    }

    /** Resolved model id this instance will call. */
    get model(): string {
        return this._model;
    }

    async complete(
        systemPrompt: string,
        userMessage: string,
        options?: GeneratorModelOptions,
    ): Promise<GeneratorModelResult> {
        const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
            model: this._model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
        };
        if (options?.temperature !== undefined) params.temperature = options.temperature;
        if (options?.maxTokens !== undefined) params.max_tokens = options.maxTokens;

        const response = await this._client.chat.completions.create(params);
        const text = response.choices[0]?.message?.content ?? '';
        const result: GeneratorModelResult = { text: text.trim() };
        if (response.usage) {
            result.inputTokens = response.usage.prompt_tokens;
            result.outputTokens = response.usage.completion_tokens;
        }
        return result;
    }
}
