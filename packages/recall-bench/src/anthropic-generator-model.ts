/**
 * GeneratorModel implementation backed by the Anthropic Messages API.
 *
 * Authentication: reads `ANTHROPIC_API_KEY` from the environment by default,
 * or pass `apiKey` in the config. Custom endpoint via `baseURL`.
 *
 * Used by the CLI when --model (or a profile model spec) is
 * `anthropic:<model-id>` — e.g., `anthropic:claude-sonnet-4-6`,
 * `anthropic:claude-opus-4-7`.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
    GeneratorModel,
    GeneratorModelOptions,
    GeneratorModelResult,
} from './generator-types.js';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 4096;

/** Subset of the Anthropic client surface we depend on; lets tests inject mocks. */
export type AnthropicClientLike = Pick<Anthropic, 'messages'>;

export interface AnthropicGeneratorModelConfig {
    /** Anthropic model id (e.g. 'claude-sonnet-4-6', 'claude-opus-4-7'). Default: claude-sonnet-4-6. */
    model?: string;
    /** API key. Defaults to `process.env.ANTHROPIC_API_KEY`. */
    apiKey?: string;
    /** Override base URL (e.g., for Bedrock-fronted proxies). */
    baseURL?: string;
    /** Per-call request timeout in ms. */
    timeout?: number;
    /** Pre-built client. When supplied, apiKey/baseURL/timeout above are ignored. */
    client?: AnthropicClientLike;
}

/**
 * GeneratorModel backed by an Anthropic Messages API request.
 */
export class AnthropicGeneratorModel implements GeneratorModel {
    private readonly _client: AnthropicClientLike;
    private readonly _model: string;

    constructor(config: AnthropicGeneratorModelConfig = {}) {
        if (config.client) {
            this._client = config.client;
        } else {
            const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
            if (!apiKey) {
                throw new Error(
                    'Anthropic API key not found. Set ANTHROPIC_API_KEY in your environment or pass `apiKey` in AnthropicGeneratorModelConfig.',
                );
            }
            const opts: ConstructorParameters<typeof Anthropic>[0] = { apiKey };
            if (config.baseURL !== undefined) opts.baseURL = config.baseURL;
            if (config.timeout !== undefined) opts.timeout = config.timeout;
            this._client = new Anthropic(opts);
        }
        this._model = config.model ?? ANTHROPIC_DEFAULT_MODEL;
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
        const params: Anthropic.MessageCreateParamsNonStreaming = {
            model: this._model,
            max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
        };
        if (options?.temperature !== undefined) params.temperature = options.temperature;

        const response = await this._client.messages.create(params);
        const text = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('')
            .trim();

        const result: GeneratorModelResult = { text };
        if (response.usage) {
            result.inputTokens = response.usage.input_tokens;
            result.outputTokens = response.usage.output_tokens;
        }
        return result;
    }
}
