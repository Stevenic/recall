/**
 * Generate query variations for multi-query fusion search.
 * Uses simple keyword extraction and rephrasing — no LLM needed.
 */

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
