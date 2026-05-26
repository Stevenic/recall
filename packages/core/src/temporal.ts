/**
 * Temporal reference extraction from query text.
 *
 * Regex-first approach: extracts explicit dates, relative references,
 * and named periods. Resolves to a single `date_ref` for affinity scoring.
 *
 * Temporal affinity formula:
 *   temporal_affinity(i) = exp(-|date_i - date_ref| / σ)
 *
 * Where σ (default: 30 days) controls falloff width.
 */

export interface TemporalReference {
    date: Date;
    specificity: number; // Higher = more specific (full date > month > quarter > year)
}

/**
 * Extract temporal references from query text.
 * Returns the most specific reference found, or null if none detected.
 */
export function extractTemporalReference(
    query: string,
    now?: Date,
): Date | null {
    const refs = extractAllTemporalReferences(query, now);
    if (refs.length === 0) return null;
    // Most specific wins
    refs.sort((a, b) => b.specificity - a.specificity);
    return refs[0].date;
}

/**
 * Extract all temporal references from query text.
 */
export function extractAllTemporalReferences(
    query: string,
    now?: Date,
): TemporalReference[] {
    const refs: TemporalReference[] = [];
    const today = now ?? new Date();

    // Full date: "April 8, 2026" or "April 8 2026"
    const fullDateNamed =
        /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/gi;
    for (const match of query.matchAll(fullDateNamed)) {
        const month = monthNameToNumber(match[1]);
        const day = parseInt(match[2]);
        const year = parseInt(match[3]);
        if (month >= 0 && day >= 1 && day <= 31) {
            refs.push({ date: new Date(year, month, day), specificity: 4 });
        }
    }

    // Full date ISO: "2026-04-08"
    const fullDateISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
    for (const match of query.matchAll(fullDateISO)) {
        const year = parseInt(match[1]);
        const month = parseInt(match[2]) - 1;
        const day = parseInt(match[3]);
        refs.push({ date: new Date(year, month, day), specificity: 4 });
    }

    // Year-month: "March 2024" or "2024-03"
    const yearMonthNamed =
        /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/gi;
    for (const match of query.matchAll(yearMonthNamed)) {
        const month = monthNameToNumber(match[1]);
        const year = parseInt(match[2]);
        if (month >= 0) {
            refs.push({ date: new Date(year, month, 15), specificity: 3 });
        }
    }

    const yearMonthISO = /\b(\d{4})-(\d{2})\b/g;
    for (const match of query.matchAll(yearMonthISO)) {
        // Avoid matching full dates already captured
        const full = query.substring(match.index!, match.index! + 10);
        if (/^\d{4}-\d{2}-\d{2}/.test(full)) continue;
        const year = parseInt(match[1]);
        const month = parseInt(match[2]) - 1;
        if (month >= 0 && month <= 11) {
            refs.push({ date: new Date(year, month, 15), specificity: 3 });
        }
    }

    // Quarter: "Q3 2024" or "Q1 last year"
    const quarterPattern = /\bQ([1-4])\s+(\d{4})\b/gi;
    for (const match of query.matchAll(quarterPattern)) {
        const q = parseInt(match[1]);
        const year = parseInt(match[2]);
        // Midpoint of quarter
        const midMonth = (q - 1) * 3 + 1; // Q1→Feb, Q2→May, Q3→Aug, Q4→Nov
        refs.push({ date: new Date(year, midMonth, 15), specificity: 2 });
    }

    const quarterLastYear = /\bQ([1-4])\s+last\s+year\b/gi;
    for (const match of query.matchAll(quarterLastYear)) {
        const q = parseInt(match[1]);
        const year = today.getFullYear() - 1;
        const midMonth = (q - 1) * 3 + 1;
        refs.push({ date: new Date(year, midMonth, 15), specificity: 2 });
    }

    // Explicit year: "in 2019", "back in 2023", "from 2020"
    const explicitYear = /\b(?:in|back\s+in|from|during)\s+(\d{4})\b/gi;
    for (const match of query.matchAll(explicitYear)) {
        const year = parseInt(match[1]);
        if (year >= 1990 && year <= 2100) {
            refs.push({ date: new Date(year, 6, 1), specificity: 1 }); // July 1 midpoint
        }
    }

    // Bare year at word boundary (only if no other refs found yet and year looks plausible)
    if (refs.length === 0) {
        const bareYear = /\b(20[12]\d)\b/g;
        for (const match of query.matchAll(bareYear)) {
            const year = parseInt(match[1]);
            refs.push({ date: new Date(year, 6, 1), specificity: 1 });
        }
    }

    // Relative: "yesterday"
    if (/\byesterday\b/i.test(query)) {
        const d = new Date(today);
        d.setDate(d.getDate() - 1);
        refs.push({ date: d, specificity: 4 });
    }

    // Relative: "last week"
    if (/\blast\s+week\b/i.test(query)) {
        const d = new Date(today);
        d.setDate(d.getDate() - 7);
        refs.push({ date: d, specificity: 2 });
    }

    // Relative: "N weeks ago"
    const weeksAgo = /\b(\d+)\s+weeks?\s+ago\b/gi;
    for (const match of query.matchAll(weeksAgo)) {
        const n = parseInt(match[1]);
        const d = new Date(today);
        d.setDate(d.getDate() - n * 7);
        refs.push({ date: d, specificity: 2 });
    }

    // Relative: "last month"
    if (/\blast\s+month\b/i.test(query)) {
        const d = new Date(today);
        d.setMonth(d.getMonth() - 1);
        refs.push({ date: d, specificity: 2 });
    }

    // Relative: "N months ago"
    const monthsAgo = /\b(\d+)\s+months?\s+ago\b/gi;
    for (const match of query.matchAll(monthsAgo)) {
        const n = parseInt(match[1]);
        const d = new Date(today);
        d.setMonth(d.getMonth() - n);
        refs.push({ date: d, specificity: 2 });
    }

    // Relative: "last year"
    if (/\blast\s+year\b/i.test(query)) {
        const d = new Date(today);
        d.setFullYear(d.getFullYear() - 1);
        refs.push({ date: d, specificity: 1 });
    }

    // Named: "this week"
    if (/\bthis\s+week\b/i.test(query)) {
        refs.push({ date: new Date(today), specificity: 2 });
    }

    // Named: "this month"
    if (/\bthis\s+month\b/i.test(query)) {
        refs.push({ date: new Date(today), specificity: 2 });
    }

    return refs;
}

/**
 * Compute temporal affinity score.
 * Returns a multiplier (0, 1] — 1.0 when dates match, decays with distance.
 */
export function temporalAffinity(
    memoryDate: Date,
    referenceDate: Date,
    sigma: number = 30,
): number {
    const diffDays =
        Math.abs(memoryDate.getTime() - referenceDate.getTime()) /
        (1000 * 60 * 60 * 24);
    return Math.exp(-diffDays / sigma);
}

/**
 * Recency cue carried by a query — does it ask for the LATEST state, the
 * ORIGINAL state, or neither? Used by retrieval to apply asymmetric
 * recency boosts so queries about current values get the revised daily
 * and queries about prior values get the original.
 *
 * `null` is the safe default — most factual-recall questions don't have
 * an explicit cue and shouldn't get a recency tilt either way.
 */
export type RecencyCue = "latest" | "earliest" | null;

/**
 * Cheap regex extraction of recency cues. False positives are fine — the
 * downstream boost is small (~10-20%) and won't flip a confident match.
 * Misses are also fine — no boost is the default. The goal is to nudge
 * top-K when the agent or search would otherwise pick the wrong era.
 */
export function extractRecencyCue(query: string): RecencyCue {
    const q = query.toLowerCase();
    // "Latest" / "current" cues — questions asking about the present state
    if (
        /\b(?:latest|current|currently|now|as of (?:today|now)|at the end of|by the end of|stays? unchanged|kept (?:unchanged|the same)|recent(?:ly)?|today)\b/i.test(
            q,
        )
    ) {
        return "latest";
    }
    // "Original" / "initial" / "first" cues — questions about the
    // original or earliest state, before any revision.
    if (
        /\b(?:original(?:ly)?|initial(?:ly)?|first (?:proposed|recorded|noted|established|set|captured)|at (?:first|the start|onset|kickoff)|kickoff|opening|inception|before .* (?:was|were) revised|earliest)\b/i.test(
            q,
        )
    ) {
        return "earliest";
    }
    return null;
}

/**
 * Apply a recency boost based on the query's cue. Returns a multiplier
 * in [0.85, 1.25] so the effect is meaningful but doesn't dominate the
 * embedding/BM25 signal. Uses the spread between the corpus's earliest
 * and latest dailies as the normalization window — a memory at the
 * latest edge gets +25% under a "latest" cue and -15% under an
 * "earliest" cue; vice-versa at the earliest edge.
 *
 * `null` cue → identity multiplier (1.0).
 */
export function recencyBoost(
    memoryDate: Date,
    cue: RecencyCue,
    spanStart: Date,
    spanEnd: Date,
): number {
    if (cue === null) return 1.0;
    const totalMs = spanEnd.getTime() - spanStart.getTime();
    if (totalMs <= 0) return 1.0;
    // 0 = at spanStart, 1 = at spanEnd
    const t = Math.max(
        0,
        Math.min(1, (memoryDate.getTime() - spanStart.getTime()) / totalMs),
    );
    if (cue === "latest") {
        // Multiplier interpolates 0.85 (earliest) → 1.25 (latest)
        return 0.85 + 0.4 * t;
    }
    // cue === "earliest"
    return 1.25 - 0.4 * t;
}

/**
 * Extract a date from a memory URI or period string.
 * Returns null if no date can be inferred.
 */
export function extractDateFromUri(uri: string): Date | null {
    // Daily: memory/2026-04-08.md or just 2026-04-08
    const dailyMatch = uri.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (dailyMatch) {
        return new Date(
            parseInt(dailyMatch[1]),
            parseInt(dailyMatch[2]) - 1,
            parseInt(dailyMatch[3]),
        );
    }

    // Weekly: weekly/2026-W15 — approximate to Thursday of that week
    const weeklyMatch = uri.match(/(\d{4})-W(\d{2})/);
    if (weeklyMatch) {
        const year = parseInt(weeklyMatch[1]);
        const weekNum = parseInt(weeklyMatch[2]);
        const jan4 = new Date(year, 0, 4);
        const dayOfWeek = jan4.getDay() || 7;
        const monday = new Date(jan4);
        monday.setDate(jan4.getDate() - dayOfWeek + 1 + (weekNum - 1) * 7);
        const thursday = new Date(monday);
        thursday.setDate(monday.getDate() + 3);
        return thursday;
    }

    // Monthly: monthly/2026-04 — midpoint
    const monthlyMatch = uri.match(/(\d{4})-(\d{2})(?!-\d)/);
    if (monthlyMatch) {
        return new Date(
            parseInt(monthlyMatch[1]),
            parseInt(monthlyMatch[2]) - 1,
            15,
        );
    }

    return null;
}

function monthNameToNumber(name: string): number {
    const months: Record<string, number> = {
        january: 0,
        february: 1,
        march: 2,
        april: 3,
        may: 4,
        june: 5,
        july: 6,
        august: 7,
        september: 8,
        october: 9,
        november: 10,
        december: 11,
    };
    return months[name.toLowerCase()] ?? -1;
}
