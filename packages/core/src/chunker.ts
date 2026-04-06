/**
 * Splits markdown documents into semantic chunks for index ingestion.
 * Chunks on heading boundaries, keeping each chunk under a token budget.
 */
export interface ChunkOptions {
    maxTokens?: number; // default: 512
    overlap?: number; // default: 0
}

export interface Chunk {
    text: string;
    startLine: number;
    endLine: number;
}

const DEFAULT_MAX_TOKENS = 512;

// Rough token estimate: ~4 chars per token for English text
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
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
