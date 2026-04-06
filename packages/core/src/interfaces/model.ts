/**
 * Abstraction for LLM-powered operations (compaction, wisdom distillation, query expansion).
 */
export interface CompleteOptions {
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
}

export interface CompletionResult {
    text: string;
    inputTokens?: number;
    outputTokens?: number;
    error?: CompletionError;
}

export interface CompletionError {
    code: string;
    message: string;
    retryable?: boolean;
    retryAfterMs?: number;
}

export interface MemoryModel {
    complete(
        prompt: string,
        options?: CompleteOptions,
    ): Promise<CompletionResult>;
}
