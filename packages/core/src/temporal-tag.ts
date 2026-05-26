/**
 * Temporal embedding tag helpers.
 *
 * Prepend an `[as of YYYY-MM-DD]` line to indexed content so the memory's
 * date becomes a first-class signal in the embedding. Queries about
 * "current X" naturally weight toward later dates because the tag carries
 * temporal semantics into the vector space. Cheap (one extra short line
 * per chunk) but high-leverage for temporal-reasoning and contradiction-
 * resolution retrieval.
 *
 * Extracted to its own module so both the indexing path in
 * `MemoryService._indexAllFiles` and the dream-engine's just-created
 * wiki-page upserts can share the helper without circular imports.
 */

/**
 * Prepend `[as of YYYY-MM-DD]` to the content. Accepts an ISO date string
 * directly or any value `Date` can parse; invalid inputs return the
 * content untouched so we never corrupt a doc with a junk header.
 */
export function withTemporalTag(
    content: string,
    date: string | Date,
): string {
    const iso =
        typeof date === "string"
            ? /^\d{4}-\d{2}-\d{2}$/.test(date)
                ? date
                : tryIsoFromString(date)
            : tryIsoFromDate(date);
    if (!iso) return content;
    return `[as of ${iso}]\n\n${content}`;
}

function tryIsoFromString(s: string): string | null {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

function tryIsoFromDate(d: Date): string | null {
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}
