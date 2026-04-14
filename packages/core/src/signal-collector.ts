/**
 * Signal Collector — Phase 1 of dreaming.
 *
 * Gathers recall signals from search logs, identifies entity clusters,
 * detects stale typed memories, and flags wisdom drift. Produces a scored
 * list of dream candidates for the synthesis pipeline.
 */

import type { MemoryFiles } from "./files.js";
import type { SearchLogger } from "./search-logger.js";
import type { SearchLogEntry, DreamCandidate, DreamScoringWeights } from "./dreaming-config.js";
import { DEFAULT_SCORING_WEIGHTS, DEFAULT_SIGNAL_WINDOW_DAYS, DEFAULT_STALENESS_THRESHOLD_DAYS } from "./dreaming-config.js";

export interface SignalCollectorConfig {
    signalWindowDays?: number;
    stalenessThresholdDays?: number;
    scoringWeights?: Partial<DreamScoringWeights>;
    /** Entity must appear in this many days to be a cluster candidate (default: 3) */
    entityMinDays?: number;
    /** Min score for null-query detection (default: 0.3) */
    nullQueryScoreThreshold?: number;
}

/**
 * Collect signals and produce scored dream candidates.
 */
export async function collectSignals(
    files: MemoryFiles,
    logger: SearchLogger,
    config?: SignalCollectorConfig,
): Promise<DreamCandidate[]> {
    const windowDays = config?.signalWindowDays ?? DEFAULT_SIGNAL_WINDOW_DAYS;
    const stalenessThreshold = config?.stalenessThresholdDays ?? DEFAULT_STALENESS_THRESHOLD_DAYS;
    const weights = { ...DEFAULT_SCORING_WEIGHTS, ...config?.scoringWeights };

    // Read search log for the signal window
    const entries = await logger.readLogWindow(windowDays);

    // Gather signals in parallel
    const [
        hitFreqCandidates,
        gapCandidates,
        entityCandidates,
        stalenessCandidates,
        wisdomCandidates,
    ] = await Promise.all([
        collectHitFrequencySignals(entries),
        collectGapSignals(entries, config?.nullQueryScoreThreshold ?? 0.3),
        collectEntitySignals(files, windowDays, config?.entityMinDays ?? 3),
        collectStalenessSignals(files, stalenessThreshold),
        collectWisdomDriftSignals(files, entries),
    ]);

    // Combine and score all candidates
    const allCandidates: DreamCandidate[] = [];

    for (const c of hitFreqCandidates) {
        allCandidates.push({
            ...c,
            score: c.score * weights.hitFrequency,
        });
    }
    for (const c of gapCandidates) {
        allCandidates.push({
            ...c,
            score: c.score * weights.gapSignal,
        });
    }
    for (const c of entityCandidates) {
        allCandidates.push({
            ...c,
            score: c.score * weights.entityFrequency,
        });
    }
    for (const c of stalenessCandidates) {
        allCandidates.push({
            ...c,
            score: c.score * weights.staleness,
        });
    }
    for (const c of wisdomCandidates) {
        allCandidates.push({
            ...c,
            score: c.score * weights.queryDiversity,
        });
    }

    // Sort by score descending
    allCandidates.sort((a, b) => b.score - a.score);

    return allCandidates;
}

// ─── Hit Frequency Signals ───────────────────────────────

/**
 * Identify memories that appear frequently in search results
 * and with diverse queries (cross-cutting).
 */
export async function collectHitFrequencySignals(
    entries: SearchLogEntry[],
): Promise<DreamCandidate[]> {
    if (entries.length === 0) return [];

    // Count hit frequency and unique queries per URI
    const hitCount = new Map<string, number>();
    const queryDiversity = new Map<string, Set<string>>();

    for (const entry of entries) {
        for (const uri of entry.results) {
            hitCount.set(uri, (hitCount.get(uri) ?? 0) + 1);
            if (!queryDiversity.has(uri)) queryDiversity.set(uri, new Set());
            queryDiversity.get(uri)!.add(entry.query);
        }
    }

    // Normalize and create candidates
    const maxHits = Math.max(...hitCount.values(), 1);
    const maxDiversity = Math.max(
        ...[...queryDiversity.values()].map((s) => s.size),
        1,
    );

    const candidates: DreamCandidate[] = [];
    for (const [uri, hits] of hitCount) {
        const diversity = queryDiversity.get(uri)?.size ?? 0;
        const normalizedHits = hits / maxHits;
        const normalizedDiversity = diversity / maxDiversity;

        // Combined score: weighted average of frequency and diversity
        const score = 0.5 * normalizedHits + 0.5 * normalizedDiversity;

        if (score > 0.2) {
            candidates.push({
                type: "high_frequency",
                score,
                uris: [uri],
                description: `Recalled ${hits} times across ${diversity} distinct queries`,
            });
        }
    }

    return candidates.sort((a, b) => b.score - a.score);
}

// ─── Gap Signals ─────────────────────────────────────────

/**
 * Identify queries that consistently return poor or no results.
 */
export async function collectGapSignals(
    entries: SearchLogEntry[],
    nullScoreThreshold: number,
): Promise<DreamCandidate[]> {
    if (entries.length === 0) return [];

    // Group queries by normalized text
    const queryGroups = new Map<string, { count: number; lastTs: string; avgBestScore: number }>();

    for (const entry of entries) {
        const key = entry.query.toLowerCase().trim();
        const bestScore = entry.scores.length > 0 ? Math.max(...entry.scores) : 0;
        const existing = queryGroups.get(key);

        if (existing) {
            existing.count++;
            existing.lastTs = entry.ts > existing.lastTs ? entry.ts : existing.lastTs;
            existing.avgBestScore =
                (existing.avgBestScore * (existing.count - 1) + bestScore) / existing.count;
        } else {
            queryGroups.set(key, { count: 1, lastTs: entry.ts, avgBestScore: bestScore });
        }
    }

    const candidates: DreamCandidate[] = [];
    for (const [query, stats] of queryGroups) {
        // Null query: returned 0 results or very low scores
        if (stats.avgBestScore < nullScoreThreshold && stats.count >= 2) {
            const score = Math.min(1.0, stats.count / 5) * (1 - stats.avgBestScore);
            candidates.push({
                type: "null_query",
                score,
                uris: [],
                description: `Query "${query}" returned poor results ${stats.count} times (avg best score: ${stats.avgBestScore.toFixed(2)})`,
            });
        }
    }

    return candidates.sort((a, b) => b.score - a.score);
}

// ─── Entity Frequency Signals ────────────────────────────

/**
 * Scan recent dailies for recurring entities that lack typed memories.
 */
export async function collectEntitySignals(
    files: MemoryFiles,
    windowDays: number,
    minDays: number,
): Promise<DreamCandidate[]> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - windowDays);
    const cutoffStr = cutoffDate.toISOString().split("T")[0];

    const dailies = await files.listDailies({ after: cutoffStr });
    if (dailies.length === 0) return [];

    // Extract entities from each day and count occurrences across days
    const entityDays = new Map<string, Set<string>>();

    for (const date of dailies) {
        const content = await files.readDaily(date);
        if (!content) continue;

        // Use lightweight regex extraction (skip NER to keep dreaming fast)
        const entities = extractEntitiesLightweight(content);
        for (const entity of entities) {
            if (!entityDays.has(entity)) entityDays.set(entity, new Set());
            entityDays.get(entity)!.add(date);
        }
    }

    // Get existing typed memories to filter out already-covered entities
    const typedMemories = await files.listTypedMemories();
    const typedNames = new Set(
        typedMemories.map((f) =>
            f.replace(/\.md$/, "").replace(/^[a-z]+_/, "").toLowerCase(),
        ),
    );

    const candidates: DreamCandidate[] = [];
    for (const [entity, days] of entityDays) {
        if (days.size < minDays) continue;
        // Skip if a typed memory already covers this entity
        if (typedNames.has(entity.toLowerCase())) continue;

        const score = Math.min(1.0, days.size / (minDays * 3));
        candidates.push({
            type: "entity_cluster",
            score,
            uris: [...days].map((d) => `memory/${d}.md`),
            description: `Entity "${entity}" appears in ${days.size} daily logs without a typed memory`,
        });
    }

    return candidates.sort((a, b) => b.score - a.score);
}

// ─── Staleness Signals ───────────────────────────────────

/**
 * Flag typed memories with type: project or type: reference that are older
 * than the staleness threshold.
 */
export async function collectStalenessSignals(
    files: MemoryFiles,
    thresholdDays: number,
): Promise<DreamCandidate[]> {
    const typedMemories = await files.listTypedMemories();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - thresholdDays);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    const candidates: DreamCandidate[] = [];

    for (const filename of typedMemories) {
        const content = await files.readTypedMemory(filename);
        if (!content) continue;

        const { data } = files.parseFrontmatter(content);
        const memType = data.type;

        // Only flag project and reference memories for staleness
        if (memType !== "project" && memType !== "reference") continue;

        // Look for a date in frontmatter or infer from content
        const rawDate = data.date ?? data.created ?? extractDateFromContent(content);
        if (!rawDate) continue;

        // gray-matter parses dates as Date objects — normalize to string
        const memDate = rawDate instanceof Date
            ? rawDate.toISOString().split("T")[0]
            : String(rawDate);

        if (memDate < cutoffStr) {
            const daysOld = Math.floor(
                (Date.now() - new Date(memDate).getTime()) / (1000 * 60 * 60 * 24),
            );
            const score = Math.min(1.0, daysOld / (thresholdDays * 2));
            candidates.push({
                type: "stale_memory",
                score,
                uris: [`memory/${filename}`],
                description: `${memType} memory "${data.name ?? filename}" is ${daysOld} days old (threshold: ${thresholdDays})`,
            });
        }
    }

    return candidates.sort((a, b) => b.score - a.score);
}

// ─── Wisdom Drift Signals ────────────────────────────────

/**
 * Compare WISDOM.md entries against recent search activity.
 * Flag wisdom entries that are heavily searched but with no matching results,
 * or entries that aren't referenced at all.
 */
export async function collectWisdomDriftSignals(
    files: MemoryFiles,
    entries: SearchLogEntry[],
): Promise<DreamCandidate[]> {
    const wisdom = await files.readWisdom();
    if (!wisdom) return [];

    // Parse wisdom entries (sections starting with **)
    const wisdomEntries = parseWisdomEntries(wisdom);
    if (wisdomEntries.length === 0) return [];

    // Build set of all queries for simple keyword matching
    const allQueries = entries.map((e) => e.query.toLowerCase());

    const candidates: DreamCandidate[] = [];

    for (const entry of wisdomEntries) {
        const keywords = extractKeywords(entry.title + " " + entry.body);

        // Check if any recent queries relate to this wisdom entry
        let matchingQueries = 0;
        for (const query of allQueries) {
            const queryWords = query.split(/\s+/);
            const overlap = keywords.filter((k) => queryWords.includes(k));
            if (overlap.length >= 2) matchingQueries++;
        }

        // Wisdom entries that are never searched may be outdated
        if (matchingQueries === 0 && entries.length > 10) {
            candidates.push({
                type: "wisdom_drift",
                score: 0.5,
                uris: ["WISDOM.md"],
                description: `Wisdom entry "${entry.title}" has no related search activity in ${entries.length} recent queries`,
            });
        }
    }

    return candidates;
}

// ─── Lightweight Entity Extraction ───────────────────────

const CAMEL_CASE = /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;
const KEBAB_CASE = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}\b/g;

/**
 * Fast entity extraction without NER model — just regex patterns.
 */
export function extractEntitiesLightweight(text: string): string[] {
    const entities = new Set<string>();

    for (const match of text.matchAll(CAMEL_CASE)) {
        entities.add(match[0].toLowerCase());
    }
    for (const match of text.matchAll(KEBAB_CASE)) {
        entities.add(match[0].toLowerCase());
    }

    // @mentions
    for (const match of text.matchAll(/@(\w+)/g)) {
        entities.add(match[1].toLowerCase());
    }

    return [...entities];
}

// ─── Helpers ─────────────────────────────────────────────

function extractDateFromContent(content: string): string | null {
    const match = content.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    return match ? match[1] : null;
}

interface WisdomEntry {
    title: string;
    body: string;
}

function parseWisdomEntries(wisdom: string): WisdomEntry[] {
    const entries: WisdomEntry[] = [];
    const lines = wisdom.split("\n");
    let current: WisdomEntry | null = null;

    for (const line of lines) {
        const boldMatch = line.match(/^\*\*(.+?)\*\*/);
        if (boldMatch) {
            if (current) entries.push(current);
            current = { title: boldMatch[1], body: "" };
        } else if (current) {
            current.body += line + "\n";
        }
    }
    if (current) entries.push(current);

    return entries;
}

function extractKeywords(text: string): string[] {
    const stopWords = new Set([
        "the", "a", "an", "is", "are", "was", "were", "be", "been",
        "being", "have", "has", "had", "do", "does", "did", "will",
        "would", "could", "should", "may", "might", "can", "shall",
        "to", "of", "in", "for", "on", "with", "at", "by", "from",
        "as", "into", "through", "during", "before", "after", "and",
        "but", "or", "nor", "not", "no", "so", "if", "then", "that",
        "this", "it", "its", "all", "each", "every", "both", "few",
        "more", "most", "other", "some", "such", "only", "own",
        "same", "than", "too", "very",
    ]);

    return text
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !stopWords.has(w));
}
