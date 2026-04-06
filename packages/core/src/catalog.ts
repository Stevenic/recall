import matter from "gray-matter";
import type { SearchResult, DocumentMetadata } from "./interfaces/index.js";

/**
 * Catalog entry parsed from frontmatter of a typed memory file.
 */
export interface CatalogEntry {
    uri: string;
    name: string;
    description: string;
    type: string;
    metadata: DocumentMetadata;
}

/**
 * Parse frontmatter from a memory file into a catalog entry.
 */
export function parseCatalogEntry(
    uri: string,
    content: string,
): CatalogEntry | null {
    try {
        const { data } = matter(content);
        if (!data.name || !data.type) return null;
        return {
            uri,
            name: data.name as string,
            description: (data.description as string) ?? "",
            type: data.type as string,
            metadata: {
                contentType: "typed_memory",
                ...data,
            },
        };
    } catch {
        return null;
    }
}

/**
 * Score a catalog entry against a query using simple keyword overlap.
 * Returns 0 if no match, otherwise a score between 0 and 1.
 */
export function scoreCatalogEntry(
    entry: CatalogEntry,
    query: string,
): number {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return 0;

    const entryText = `${entry.name} ${entry.description} ${entry.type}`;
    const entryTerms = new Set(tokenize(entryText));

    let matches = 0;
    for (const term of queryTerms) {
        if (entryTerms.has(term)) {
            matches++;
        }
    }

    return matches / queryTerms.length;
}

/**
 * Match typed memory files against a query by frontmatter keyword overlap.
 * Returns results sorted by score (descending).
 */
export function matchCatalog(
    entries: CatalogEntry[],
    query: string,
    maxResults: number = 5,
): SearchResult[] {
    const scored = entries
        .map((entry) => ({
            entry,
            score: scoreCatalogEntry(entry, query),
        }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

    return scored.map((s) => ({
        uri: s.entry.uri,
        text: "", // Will be filled by the caller with actual content
        score: s.score,
        metadata: s.entry.metadata,
    }));
}

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^\w\s-]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1);
}
