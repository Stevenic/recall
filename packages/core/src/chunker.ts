/**
 * Splits markdown documents into semantic chunks for index ingestion.
 * Chunks on heading boundaries, keeping each chunk under a token budget.
 *
 * NOTE: The hot-path chunking that runs when documents are upserted into
 * Vectra is handled by Vectra's own `TextSplitter` (token-aware, supports
 * overlap — see `defaults/vectra-index.ts` for the configured defaults).
 * This module is a public-API utility for external callers that want
 * heading-aware chunking without going through Vectra; the `overlap`
 * option is currently a no-op (chunks emit non-overlapping for the
 * heading-based path). Use Vectra's splitter via `VectraIndex` for
 * production indexing.
 */
export interface ChunkOptions {
    maxTokens?: number; // default: 512
    overlap?: number; // default: 0 (no-op in this implementation; see note above)
}

export interface Chunk {
    text: string;
    startLine: number;
    endLine: number;
}

const DEFAULT_MAX_TOKENS = 512;

// Lazy-cached gpt-tokenizer encoder. Falls back to chars/4 if the package
// isn't available at runtime (e.g., during a teardown path or a build that
// excluded it). This matches salience.ts's countTokens approach.
let encoder: ((text: string) => number[]) | null = null;
let encoderLoaded = false;

function estimateTokens(text: string): number {
    if (encoderLoaded && encoder) {
        try {
            return encoder(text).length;
        } catch {
            // Fall through to the heuristic below
        }
    }
    return Math.ceil(text.length / 4);
}

/**
 * One-time async warm-up for the gpt-tokenizer-backed token counter.
 * Calling this is optional — `chunkMarkdown` will use the chars/4 fallback
 * until/unless the encoder is loaded. The vast majority of consumers are
 * happy with the fallback for prose, but code-heavy or list-heavy text
 * benefits from the real tokenizer.
 */
export async function loadTokenEncoder(): Promise<void> {
    if (encoderLoaded) return;
    try {
        const { encode } = await import("gpt-tokenizer");
        encoder = encode;
    } catch {
        encoder = null;
    }
    encoderLoaded = true;
}

/**
 * Split markdown into chunks on heading boundaries.
 * Falls back to paragraph splitting if a section exceeds the token budget.
 */
export function chunkMarkdown(
    text: string,
    options?: ChunkOptions,
): Chunk[] {
    const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const lines = text.split("\n");
    const sections: { text: string; startLine: number; endLine: number }[] =
        [];

    let currentStart = 0;
    let currentLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Split on headings (# through ####)
        if (line.match(/^#{1,4}\s/) && currentLines.length > 0) {
            sections.push({
                text: currentLines.join("\n"),
                startLine: currentStart,
                endLine: i - 1,
            });
            currentStart = i;
            currentLines = [line];
        } else {
            currentLines.push(line);
        }
    }

    // Push final section
    if (currentLines.length > 0) {
        sections.push({
            text: currentLines.join("\n"),
            startLine: currentStart,
            endLine: lines.length - 1,
        });
    }

    // Now split any oversized sections by paragraph
    const chunks: Chunk[] = [];
    for (const section of sections) {
        if (estimateTokens(section.text) <= maxTokens) {
            const trimmed = section.text.trim();
            if (trimmed) {
                chunks.push({
                    text: trimmed,
                    startLine: section.startLine,
                    endLine: section.endLine,
                });
            }
            continue;
        }

        // Split oversized section by double-newline (paragraphs)
        const paragraphs = section.text.split(/\n\n+/);
        let accum = "";
        let accumStart = section.startLine;
        let lineOffset = section.startLine;

        for (const para of paragraphs) {
            const paraLines = para.split("\n").length;
            if (
                accum &&
                estimateTokens(accum + "\n\n" + para) > maxTokens
            ) {
                const trimmed = accum.trim();
                if (trimmed) {
                    chunks.push({
                        text: trimmed,
                        startLine: accumStart,
                        endLine: lineOffset - 1,
                    });
                }
                accum = para;
                accumStart = lineOffset;
            } else {
                accum = accum ? accum + "\n\n" + para : para;
            }
            lineOffset += paraLines + 1; // +1 for the blank line between paragraphs
        }

        if (accum.trim()) {
            chunks.push({
                text: accum.trim(),
                startLine: accumStart,
                endLine: section.endLine,
            });
        }
    }

    return chunks;
}
