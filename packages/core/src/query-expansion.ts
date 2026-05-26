/**
 * Generate query variations for multi-query fusion search.
 * Uses simple keyword extraction and rephrasing — no LLM needed.
 */

/**
 * Heuristic decomposition for multi-fact questions.
 *
 * Questions of the form "what was X, and what was Y" or "what X did
 * Jordan record, and what was the Y" pack two distinct facts into one
 * query string. Bi-encoder retrieval typically finds hits for one of
 * them and misses the other — the partial-completeness failure cluster
 * we keep seeing. Decomposing into per-fact sub-queries lets retrieval
 * cover both topics independently.
 *
 * Returns 2+ sub-queries when the input clearly contains multiple
 * asks; returns `null` when the question reads as a single ask (no
 * splitting needed). Pure regex — false positives stay rare because
 * we require both halves to contain a wh-word or interrogative anchor.
 *
 * Examples that split:
 *   - "What was X and what was Y?"
 *   - "What X did Jordan record, and what was the leverage ceiling?"
 *   - "What two board meetings were planned, and what were their dates?"
 *
 * Examples that don't:
 *   - "What was the working valuation range?"
 *   - "How did X evolve?"
 *   - "What did Alex say about his Chicago trip across the family updates?"
 *     (one ask — "across" isn't a multi-fact conjunction)
 */
export function decomposeQuery(query: string): string[] | null {
    // Split candidates: " and what " / ", and what " / "; what " /
    // ", what " — each must be followed by something that smells like a
    // sub-question (wh-word, was/were/did/is/are, or a determiner).
    const splitRegex =
        /\s*(?:,\s*and|\s+and|;|,)\s+(?=(?:what|which|who|when|how|why|where|was|were|did|do|does|is|are|the)\b)/i;
    const parts = query.split(splitRegex).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    // Require at least 2 parts that look like full sub-questions
    // (>= 4 words). Otherwise we'd over-split things like "X, Y, and Z"
    // lists into a query per item.
    const subs = parts.filter((p) => p.split(/\s+/).length >= 4);
    if (subs.length < 2) return null;
    // Cap at 3 to keep parallel cost bounded.
    return subs.slice(0, 3);
}

/**
 * Generate 1-3 query variations from the input.
 */
export function expandQuery(query: string): string[] {
    const queries = [query];

    // Variation 1: extract key terms (remove stop words)
    const keywords = extractKeywords(query);
    if (keywords.length >= 2) {
        const keywordQuery = keywords.join(" ");
        if (keywordQuery !== query.toLowerCase()) {
            queries.push(keywordQuery);
        }
    }

    // Variation 2: noun-phrase style (first 4 keywords)
    if (keywords.length > 3) {
        queries.push(keywords.slice(0, 4).join(" "));
    }

    return queries;
}

const STOP_WORDS = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above",
    "below", "between", "out", "off", "over", "under", "again",
    "further", "then", "once", "here", "there", "when", "where", "why",
    "how", "all", "both", "each", "few", "more", "most", "other",
    "some", "such", "no", "nor", "not", "only", "own", "same", "so",
    "than", "too", "very", "just", "because", "but", "and", "or", "if",
    "while", "about", "what", "which", "who", "whom", "this", "that",
    "these", "those", "am", "it", "its", "my", "we", "our", "your",
    "his", "her", "they", "them", "their", "i", "me", "he", "she",
    "up", "down",
]);

function extractKeywords(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^\w\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}
