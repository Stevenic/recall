/**
 * GeneratorModel implementation backed by Azure OpenAI / Azure Foundry.
 *
 * Uses the openai SDK's `AzureOpenAI` class. Authentication:
 *   - apiKey: `AZURE_OPENAI_API_KEY` (or pass `apiKey` in config)
 *   - endpoint: `<provider>:<deployment>;<endpoint>` model spec OR
 *     `AZURE_OPENAI_ENDPOINT` env var
 *   - apiVersion: `AZURE_OPENAI_API_VERSION` env var (default: 2024-10-21)
 *
 * Note: the "model" field in the spec is interpreted as the **deployment name**
 * configured in the Azure portal, which doubles as the model id in the API call.
 */

import { AzureOpenAI } from 'openai';
import type {
    GeneratorModel,
    GeneratorModelOptions,
    GeneratorModelResult,
} from './generator-types.js';

const DEFAULT_API_VERSION = '2024-10-21';

/**
 * Detect Azure OpenAI content-filter rejections (400 with code=content_filter
 * or innererror.code=ResponsibleAIPolicyViolation). The openai SDK throws
 * these as BadRequestError instances with a structured `error` payload.
 */
function isContentFilterError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { status?: number; code?: string; error?: { code?: string; innererror?: { code?: string } } };
    if (e.code === 'content_filter') return true;
    if (e.status === 400 && e.error?.code === 'content_filter') return true;
    if (e.error?.innererror?.code === 'ResponsibleAIPolicyViolation') return true;
    return false;
}

/** Subset of the Azure client surface we use; lets tests inject mocks. */
export type AzureOpenAiClientLike = Pick<AzureOpenAI, 'chat'>;

export interface AzureOpenAiGeneratorModelConfig {
    /** Azure OpenAI deployment name (configured in the Azure portal). */
    deployment: string;
    /** API key. Defaults to `process.env.AZURE_OPENAI_API_KEY`. */
    apiKey?: string;
    /** Resource endpoint (e.g., `https://my-resource.openai.azure.com`). */
    endpoint?: string;
    /** Azure OpenAI API version. Defaults to '2024-10-21'. */
    apiVersion?: string;
    /** Per-call request timeout in ms. */
    timeout?: number;
    /** Pre-built client. When supplied, apiKey/endpoint/apiVersion/timeout are ignored. */
    client?: AzureOpenAiClientLike;
}

/**
 * GeneratorModel backed by an Azure OpenAI chat completion request.
 */
export class AzureOpenAiGeneratorModel implements GeneratorModel {
    private readonly _client: AzureOpenAiClientLike;
    private readonly _deployment: string;

    constructor(config: AzureOpenAiGeneratorModelConfig) {
        if (!config.deployment || config.deployment.trim().length === 0) {
            throw new Error('AzureOpenAiGeneratorModel requires a `deployment` name.');
        }
        if (config.client) {
            this._client = config.client;
        } else {
            const apiKey = config.apiKey ?? process.env.AZURE_OPENAI_API_KEY;
            if (!apiKey) {
                throw new Error(
                    'Azure OpenAI API key not found. Set AZURE_OPENAI_API_KEY in your environment or pass `apiKey` in AzureOpenAiGeneratorModelConfig.',
                );
            }
            const endpoint = config.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
            if (!endpoint) {
                throw new Error(
                    'Azure OpenAI endpoint not found. Provide it via the model spec (`azure:<deployment>;<endpoint>`), the AZURE_OPENAI_ENDPOINT env var, or `endpoint` in the config.',
                );
            }
            const apiVersion = config.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? DEFAULT_API_VERSION;
            const opts: ConstructorParameters<typeof AzureOpenAI>[0] = {
                apiKey,
                endpoint,
                apiVersion,
                deployment: config.deployment,
                // Bench runs hit Azure quota windows; allow the SDK to ride
                // out 429s and transient 5xxs without bubbling to the harness.
                // The SDK's default is 2; 10 covers a 5-10 minute spike.
                maxRetries: 10,
            };
            if (config.timeout !== undefined) opts.timeout = config.timeout;
            this._client = new AzureOpenAI(opts);
        }
        this._deployment = config.deployment;
    }

    /** Resolved deployment name this instance will call. */
    get deployment(): string {
        return this._deployment;
    }

    async complete(
        systemPrompt: string,
        userMessage: string,
        options?: GeneratorModelOptions,
    ): Promise<GeneratorModelResult> {
        // The Azure OpenAI client is configured with `deployment`; the `model`
        // field still has to be sent but it's the deployment name.
        const params: Record<string, unknown> = {
            model: this._deployment,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
        };
        if (options?.temperature !== undefined) params.temperature = options.temperature;
        if (options?.maxTokens !== undefined) params.max_completion_tokens = options.maxTokens;

        let response: {
            choices: Array<{ message?: { content?: string | null } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
            response = (await this._client.chat.completions.create(
                params as unknown as Parameters<AzureOpenAiClientLike['chat']['completions']['create']>[0],
            )) as typeof response;
        } catch (err) {
            // Azure RAI sometimes flags benign benchmark prompts (parent care,
            // home incidents, etc.). Treat content_filter as "model refused to
            // answer" — return empty text and let the caller (judge or harness)
            // score it as a refusal. Anything else still throws.
            if (isContentFilterError(err)) {
                process.stderr.write(
                    `  [azure-gen] content filter triggered; returning empty response (${this._deployment})\n`,
                );
                return { text: '' };
            }
            throw err;
        }
        const text = response.choices[0]?.message?.content ?? '';
        const result: GeneratorModelResult = { text: text.trim() };
        if (response.usage) {
            if (typeof response.usage.prompt_tokens === 'number') {
                result.inputTokens = response.usage.prompt_tokens;
            }
            if (typeof response.usage.completion_tokens === 'number') {
                result.outputTokens = response.usage.completion_tokens;
            }
        }
        return result;
    }
}
