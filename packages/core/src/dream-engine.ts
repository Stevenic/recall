/**
 * DreamEngine — Asynchronous knowledge synthesis.
 *
 * Three-phase pipeline:
 *   Phase 1 (Gather)  — Collect signals from search logs, entity scans,
 *                        staleness checks, and wisdom drift
 *   Phase 2 (Analyze) — Use the LLM to examine candidates and produce
 *                        insights, promotions, contradictions
 *   Phase 3 (Write)   — Persist results without modifying existing files
 */

import * as path from "path";
import type { MemoryFiles } from "./files.js";
import type { MemoryIndex } from "./interfaces/index.js";
import type { MemoryModel } from "./interfaces/model.js";
import type { FileStorage } from "./interfaces/storage.js";
import { SearchLogger } from "./search-logger.js";
import { collectSignals } from "./signal-collector.js";
import type { WikiEngine } from "./wiki-engine.js";
import type { SourceContribution, WikiPage, WikiTarget } from "./wiki-types.js";
import { withTemporalTag } from "./temporal-tag.js";
import type {
    DreamingConfig,
    DreamCandidate,
    DreamOptions,
    DreamResult,
    DreamStatus,
    AnalysisResult,
    AnalysisTemplates,
    DreamWikiOp,
    DreamWikiUpdate,
} from "./dreaming-config.js";
import {
    DEFAULT_DREAM_ANALYZE_CONCURRENCY,
    DEFAULT_MAX_CANDIDATES,
    DEFAULT_SIGNAL_WINDOW_DAYS,
    DEFAULT_STALENESS_THRESHOLD_DAYS,
    DEFAULT_WIKI_DEDUP_THRESHOLD,
    DEFAULT_MAX_ENTITY_RENAMES_PER_SESSION,
    DEFAULT_ENTITY_RENAME_OVERLAP,
    DEFAULT_WISDOM_MAX_ENTRIES,
    DEFAULT_WISDOM_MAX_CHARS,
} from "./dreaming-config.js";

export interface DreamEngineDeps {
    /** Optional wiki engine. When provided and config.writeToWiki is true
     * (default), analysis results are applied as wiki page operations. */
    wiki?: WikiEngine;
}

export class DreamEngine {
    private readonly _files: MemoryFiles;
    private readonly _index: MemoryIndex;
    private readonly _model: MemoryModel;
    private readonly _storage: FileStorage;
    private readonly _logger: SearchLogger;
    private readonly _config: DreamingConfig;
    private readonly _wiki: WikiEngine | undefined;
    /**
     * Per-slug serialization for the wiki apply path. Concurrent analyze
     * workers can race on shared wiki state when they touch the same
     * slug: worker A's `_findDedupTarget` read can predate worker B's
     * write, both then perform overlapping merges, and one's body
     * clobbers the other. We lock per slug so ops on the same wiki page
     * serialize while ops on different pages parallelize freely. Map
     * entries are removed eagerly once the lock chain drains so the map
     * doesn't grow without bound.
     */
    private readonly _slugLocks = new Map<string, Promise<void>>();
    /**
     * Per-session counter for the entity-rename detector. Reset at the
     * start of every `dream()` call. Bounds LLM cost: at most
     * `DEFAULT_MAX_ENTITY_RENAMES_PER_SESSION` verifier calls per pass.
     */
    private _entityRenameVerifications = 0;
    /**
     * Per-session memo of candidate page pairs already judged by the
     * entity-rename verifier. Keyed by `"${slugA}|${slugB}"` with
     * lexicographically sorted slugs so order doesn't matter. Reset at
     * the start of every `dream()` call. Avoids re-verifying the same
     * pair as a write touches each page in turn.
     */
    private readonly _entityRenameSeen = new Set<string>();

    constructor(
        files: MemoryFiles,
        index: MemoryIndex,
        model: MemoryModel,
        storage: FileStorage,
        logger: SearchLogger,
        config?: DreamingConfig,
        deps?: DreamEngineDeps,
    ) {
        this._files = files;
        this._index = index;
        this._model = model;
        this._storage = storage;
        this._logger = logger;
        this._config = config ?? {};
        this._wiki = deps?.wiki;
    }

    /** True when the engine should route output through the wiki layer. */
    private _wikiActive(skipWiki?: boolean): boolean {
        if (skipWiki) return false;
        if (!this._wiki?.enabled) return false;
        // Default to writing to wiki when a wiki engine is wired and enabled.
        return this._config.writeToWiki !== false;
    }

    // ─── Full Session ────────────────────────────────────

    /**
     * Run a full dreaming session (all three phases).
     */
    async dream(options?: DreamOptions): Promise<DreamResult> {
        const phases = options?.phases ?? ["gather", "analyze", "write"];
        const maxCandidates = options?.maxCandidates ?? this._config.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
        const dryRun = options?.dryRun ?? false;
        // Fresh per-session state for the entity-rename detector.
        this._entityRenameVerifications = 0;
        this._entityRenameSeen.clear();

        let candidates: DreamCandidate[] = [];
        let analysisResults: AnalysisResult[] = [];

        // Phase 1: Gather
        if (phases.includes("gather")) {
            candidates = await this.gatherSignals();
        } else {
            // Load carry-over candidates
            const raw = await this._logger.readCandidates();
            candidates = raw as DreamCandidate[];
        }

        // Cap candidates
        const toAnalyze = candidates.slice(0, maxCandidates);
        const overflow = candidates.slice(maxCandidates);

        if (dryRun) {
            return {
                insights: [],
                promotions: [],
                contradictions: [],
                gaps: toAnalyze.filter((c) => c.type === "null_query").map((c) => ({
                    query: c.description,
                    frequency: 0,
                    lastQueried: "",
                })),
                wikiUpdates: [],
                candidatesExamined: 0,
                candidatesTotal: toAnalyze.length,
                modelCalls: 0,
                inputTokens: 0,
                outputTokens: 0,
            };
        }

        // Phase 2: Analyze
        if (phases.includes("analyze")) {
            analysisResults = await this.analyze(toAnalyze);
        }

        // Phase 3: Write
        let result: DreamResult;
        if (phases.includes("write")) {
            result = await this.writeResults(
                analysisResults,
                toAnalyze.length,
                { skipWiki: options?.skipWiki === true },
            );
        } else {
            result = aggregateResults(analysisResults, toAnalyze.length);
        }

        // Phase 4: Wisdom distillation. Read current WISDOM.md, propose
        // patches based on this dream's insights + wiki changes, write
        // back. Best-effort; failures don't invalidate the rest of the
        // pass. Skipped when no wiki engine is wired (the LLM has too
        // little to draw on without a wiki state to summarize).
        const wisdomEnabled =
            this._config.wisdom?.enabled !== false && this._wikiActive(options?.skipWiki);
        if (wisdomEnabled && phases.includes("write")) {
            try {
                await this._distillWisdom(result);
            } catch {
                // Best-effort: never fail the pass on a wisdom-distill error.
            }
        }

        // Persist carry-over candidates and state
        await this._logger.writeCandidates(overflow);
        await this._logger.writeState({
            lastRun: new Date().toISOString(),
            lastCandidatesExamined: result.candidatesExamined,
            lastInsightsGenerated: result.insights.length,
        });

        return result;
    }

    // ─── Phase 1: Gather Signals ─────────────────────────

    async gatherSignals(): Promise<DreamCandidate[]> {
        // Rotate log first
        await this._logger.rotateLog();

        return collectSignals(this._files, this._logger, {
            signalWindowDays: this._config.signalWindowDays ?? DEFAULT_SIGNAL_WINDOW_DAYS,
            stalenessThresholdDays: this._config.stalenessThresholdDays ?? DEFAULT_STALENESS_THRESHOLD_DAYS,
            scoringWeights: this._config.scoringWeights,
        });
    }

    // ─── Phase 2: Analyze Candidates ─────────────────────

    async analyze(candidates: DreamCandidate[]): Promise<AnalysisResult[]> {
        const templates = this._getTemplates();
        const concurrency = this._config.analyzeConcurrency ?? DEFAULT_DREAM_ANALYZE_CONCURRENCY;
        // Pre-allocate so results stay in candidate order (matters for
        // downstream merging + diary writes).
        const results: AnalysisResult[] = new Array(candidates.length);
        const emptyFor = (candidate: DreamCandidate): AnalysisResult => ({
            candidate,
            insights: [],
            promotions: [],
            contradictions: [],
            gaps: [],
            wikiOps: [],
            modelCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
        });
        // Worker-pool concurrency: K workers each pull from a shared
        // index. Each analyze call is one LLM round-trip + a few file
        // reads; with 20 candidates × ~5-15s each, sequential burns
        // 100-300s per dream pass while K=4 cuts to 25-75s. Errors are
        // swallowed per-candidate so a single bad analysis can't drop
        // the whole pass.
        let next = 0;
        await Promise.all(
            Array.from({ length: Math.max(1, concurrency) }, async () => {
                while (true) {
                    const idx = next++;
                    if (idx >= candidates.length) return;
                    try {
                        results[idx] = await this._analyzeCandidate(
                            candidates[idx],
                            templates,
                        );
                    } catch {
                        results[idx] = emptyFor(candidates[idx]);
                    }
                }
            }),
        );
        return results;
    }

    // ─── Phase 3: Write Results ──────────────────────────

    async writeResults(
        analysisResults: AnalysisResult[],
        totalCandidates: number,
        opts?: { skipWiki?: boolean },
    ): Promise<DreamResult> {
        const result = aggregateResults(analysisResults, totalCandidates);
        const today = new Date().toISOString().split("T")[0];
        const wikiActive = this._wikiActive(opts?.skipWiki);

        // Ensure output directories exist
        await this._ensureOutputDirs();

        // Phase D: apply wiki ops first so subsequent legacy writes can be
        // skipped when the wiki absorbs the same content.
        if (wikiActive && this._wiki) {
            const allOps: DreamWikiOp[] = [];
            for (const ar of analysisResults) {
                for (const op of ar.wikiOps) allOps.push(op);
            }
            for (const op of allOps) {
                const update = await this._applyWikiOp(op);
                result.wikiUpdates.push(update);
            }
        }

        // Write insight files
        for (const insight of result.insights) {
            const slug = insight.theme
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "");
            const filename = `${today}-${slug}.md`;
            const filePath = path.join(
                this._files.root,
                "memory",
                "dreams",
                "insights",
                filename,
            );

            const frontmatter = [
                "---",
                "type: insight",
                `date: ${today}`,
                `theme: ${insight.theme}`,
                "sources:",
                ...insight.sources.map((s) => `  - ${s}`),
                `confidence: ${insight.confidence}`,
                "---",
            ].join("\n");

            // Insight body was stored in the file field temporarily during analysis
            const body = insight.file;
            await this._storage.upsertFile(filePath, `${frontmatter}\n\n${body}\n`);

            // Update the file field to the actual path
            insight.file = `memory/dreams/insights/${filename}`;

            // Index the insight
            await this._index.upsertDocument(
                `memory/dreams/insights/${filename}`,
                body,
                { contentType: "insight" },
            );
        }

        // Write promoted typed memories (dedup against existing)
        const existingTyped = new Set(await this._files.listTypedMemories());
        const writtenPromotions: string[] = [];
        for (const analysisResult of analysisResults) {
            for (const promo of analysisResult.promotions) {
                if (!existingTyped.has(promo.filename)) {
                    await this._files.writeTypedMemory(promo.filename, promo.content);
                    writtenPromotions.push(promo.filename);
                    existingTyped.add(promo.filename);
                }
            }
        }
        result.promotions = writtenPromotions;

        // Write contradiction file (if any)
        if (result.contradictions.length > 0) {
            const contradictionPath = path.join(
                this._files.root,
                "memory",
                "dreams",
                "contradictions",
                `${today}.md`,
            );

            const lines = [
                "---",
                "type: contradiction",
                `date: ${today}`,
                "---",
                "",
                "## Contradictions Detected",
                "",
            ];
            for (const c of result.contradictions) {
                lines.push(`### ${c.wisdomEntry}`);
                lines.push(`**Evidence:** ${c.evidence.join(", ")}`);
                lines.push("");
                lines.push(`**Recommendation:** ${c.recommendation}`);
                lines.push("");
            }
            await this._storage.upsertFile(contradictionPath, lines.join("\n") + "\n");

            await this._index.upsertDocument(
                `memory/dreams/contradictions/${today}.md`,
                lines.join("\n"),
                { contentType: "contradiction" },
            );
        }

        // Append to DREAMS.md diary
        await this._writeDiaryEntry(result, today);

        return result;
    }

    // ─── Status ──────────────────────────────────────────

    async status(): Promise<DreamStatus> {
        const state = await this._logger.readState();
        const entries = await this._logger.readLog();
        const carryOver = await this._logger.readCandidates();

        return {
            lastRun: state.lastRun as string | undefined,
            pendingCandidates: (carryOver as unknown[]).length,
            searchLogEntries: entries.length,
            searchLogOldest: entries.length > 0 ? entries[0].ts : undefined,
        };
    }

    // ─── Internals ───────────────────────────────────────

    private async _analyzeCandidate(
        candidate: DreamCandidate,
        templates: AnalysisTemplates,
    ): Promise<AnalysisResult> {
        const result: AnalysisResult = {
            candidate,
            insights: [],
            promotions: [],
            contradictions: [],
            gaps: [],
            wikiOps: [],
            modelCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
        };

        // Load context for the candidate
        const context = await this._loadCandidateContext(candidate);
        if (!context) return result;

        // Choose analysis template based on candidate type
        let systemPrompt: string;
        switch (candidate.type) {
            case "high_frequency":
            case "entity_cluster":
                systemPrompt = templates.crossReference;
                break;
            case "temporal_gap":
                systemPrompt = templates.gapAnalysis;
                break;
            case "wisdom_drift":
            case "supersession_signal":
                // Supersession candidates share the contradiction template —
                // both ask the model to compare a new claim against existing
                // state and decide whether something has changed. The
                // template is extended to handle the wiki-as-current-truth
                // framing and emit `supersedes`-bearing wiki_ops when the
                // daily overrides a wiki claim.
                systemPrompt = templates.contradictionDetection;
                break;
            case "stale_memory":
                systemPrompt = templates.typedMemoryExtraction;
                break;
            case "null_query":
                systemPrompt = templates.gapAnalysis;
                break;
            default:
                systemPrompt = templates.themeSynthesis;
        }

        const completion = await this._model.complete(context, {
            systemPrompt,
            temperature: 0.3,
        });
        result.modelCalls++;
        result.inputTokens += completion.inputTokens ?? 0;
        result.outputTokens += completion.outputTokens ?? 0;

        if (completion.error || !completion.text.trim()) return result;

        // Parse the LLM output
        this._parseAnalysisOutput(completion.text, candidate, result);

        return result;
    }

    private async _loadCandidateContext(
        candidate: DreamCandidate,
    ): Promise<string | null> {
        const parts: string[] = [];

        // Load URIs referenced by the candidate
        for (const uri of candidate.uris) {
            const content = await this._loadUri(uri);
            if (content) {
                parts.push(`## ${uri}\n\n${content}`);
            }
        }

        // For wisdom drift, also include WISDOM.md
        if (candidate.type === "wisdom_drift") {
            const wisdom = await this._files.readWisdom();
            if (wisdom) parts.push(`## WISDOM.md\n\n${wisdom}`);
        }

        // For null queries, include the query text
        if (candidate.type === "null_query") {
            parts.push(`## Query\n\n${candidate.description}`);
        }

        // For supersession signals, also include the top wiki pages that
        // semantically match the daily's content. This is what lets the
        // analyzer detect "this daily contradicts the wiki" — without the
        // wiki context, the model can't tell whether a fact has actually
        // changed or is just being re-stated. Best-effort: if the wiki
        // layer is disabled or the index isn't ready, fall through.
        if (candidate.type === "supersession_signal" && this._wiki?.enabled) {
            const dailyContent = parts[0] ?? candidate.description;
            try {
                const wikiHits = await this._index.query(dailyContent, {
                    maxResults: 4,
                    filter: { contentType: "wiki" },
                });
                if (wikiHits.length > 0) {
                    parts.push(
                        "## Current wiki state (candidates for supersession)\n\n" +
                            wikiHits
                                .map(
                                    (h) =>
                                        `### ${h.uri}\n${(h.text ?? "").trim()}`,
                                )
                                .join("\n\n"),
                    );
                }
            } catch {
                // Wiki search failed (e.g. index not ready) — proceed without.
            }
        }

        // For candidate types that can emit wiki_ops (cross-reference,
        // entity-cluster, theme synthesis, typed-memory extraction), include
        // the top existing wiki pages on related topics so the LLM can
        // prefer UPDATE over CREATE. Without this, dreaming creates a fresh
        // page each time it encounters the same topic with new facts —
        // resulting in 7 Condor pages by day 30 of the EA bench. The
        // supersession_signal branch already does this above; this block
        // generalizes it to the other create-emitting templates.
        const createEmittingTypes = new Set<typeof candidate.type>([
            "high_frequency",
            "entity_cluster",
            "stale_memory",
            "wisdom_drift",
        ]);
        if (
            createEmittingTypes.has(candidate.type) &&
            this._wiki?.enabled
        ) {
            try {
                const probe = candidate.description || parts[0] || "";
                const wikiHits = await this._index.query(probe, {
                    maxResults: 4,
                    filter: { contentType: "wiki" },
                });
                if (wikiHits.length > 0) {
                    parts.push(
                        "## Existing wiki pages on related topics " +
                            "(prefer UPDATE over CREATE — use the existing slug " +
                            "rather than emitting a duplicate page on the same topic)\n\n" +
                            wikiHits
                                .map(
                                    (h) =>
                                        `### ${h.uri}\n${(h.text ?? "").trim().slice(0, 600)}`,
                                )
                                .join("\n\n"),
                    );
                }
            } catch {
                // Wiki search failed — proceed without context (apply-time
                // dedup is the safety net).
            }
        }

        if (parts.length === 0) return null;
        return parts.join("\n\n---\n\n");
    }

    private async _loadUri(uri: string): Promise<string | null> {
        // Parse URI format: memory/YYYY-MM-DD.md, memory/weekly/YYYY-WNN.md, etc.
        if (uri.startsWith("memory/weekly/")) {
            const week = uri.replace("memory/weekly/", "").replace(".md", "");
            return this._files.readWeekly(week);
        }
        if (uri.startsWith("memory/monthly/")) {
            const month = uri.replace("memory/monthly/", "").replace(".md", "");
            return this._files.readMonthly(month);
        }
        if (uri === "WISDOM.md") {
            return this._files.readWisdom();
        }
        if (uri.startsWith("memory/")) {
            const filename = uri.replace("memory/", "");
            // Daily log
            const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
            if (dateMatch) {
                return this._files.readDaily(dateMatch[1]);
            }
            // Typed memory
            return this._files.readTypedMemory(filename);
        }
        return null;
    }

    /**
     * Parse LLM analysis output into structured results.
     *
     * The LLM is instructed to output JSON with insights, promotions,
     * contradictions, and gaps sections.
     */
    private _parseAnalysisOutput(
        text: string,
        candidate: DreamCandidate,
        result: AnalysisResult,
    ): void {
        // Try JSON parse first
        try {
            // Strip markdown fences if present
            const cleaned = text.replace(/^```json?\s*/m, "").replace(/\s*```\s*$/m, "");
            const parsed = JSON.parse(cleaned);

            if (Array.isArray(parsed.insights)) {
                for (const insight of parsed.insights) {
                    result.insights.push({
                        file: insight.body ?? insight.text ?? "",
                        theme: insight.theme ?? candidate.description.substring(0, 50),
                        sources: insight.sources ?? candidate.uris,
                        confidence: insight.confidence ?? "medium",
                    });
                }
            }

            if (Array.isArray(parsed.promotions)) {
                for (const promo of parsed.promotions) {
                    if (promo.filename && promo.content) {
                        result.promotions.push(promo);
                    }
                }
            }

            if (Array.isArray(parsed.contradictions)) {
                for (const c of parsed.contradictions) {
                    result.contradictions.push({
                        wisdomEntry: c.wisdomEntry ?? c.entry ?? "",
                        evidence: c.evidence ?? [],
                        recommendation: c.recommendation ?? "",
                    });
                }
            }

            if (Array.isArray(parsed.gaps)) {
                for (const g of parsed.gaps) {
                    result.gaps.push({
                        query: g.query ?? "",
                        frequency: g.frequency ?? 0,
                        lastQueried: g.lastQueried ?? "",
                    });
                }
            }

            // Phase D: harvest wiki_ops if the model produced any. Tolerate
            // missing/malformed entries; the per-op validation happens in
            // _applyWikiOp where rejection is part of the report.
            const wikiOps = parsed.wiki_ops ?? parsed.wikiOps;
            if (Array.isArray(wikiOps)) {
                for (const raw of wikiOps) {
                    const op = coerceWikiOp(raw, candidate);
                    if (op) result.wikiOps.push(op);
                }
            }

            return;
        } catch {
            // Not JSON — treat as a freeform insight
        }

        // Fallback: treat the whole output as a single insight
        if (text.trim().length > 20) {
            result.insights.push({
                file: text.trim(),
                theme: candidate.description.substring(0, 60).replace(/[^a-zA-Z0-9\s-]/g, ""),
                sources: candidate.uris,
                confidence: "low",
            });
        }
    }

    private async _ensureOutputDirs(): Promise<void> {
        const dreamsDir = path.join(this._files.root, "memory", "dreams");
        const insightsDir = path.join(dreamsDir, "insights");
        const contradictionsDir = path.join(dreamsDir, "contradictions");

        for (const dir of [dreamsDir, insightsDir, contradictionsDir]) {
            if (!(await this._storage.pathExists(dir))) {
                await this._storage.createFolder(dir);
            }
        }
    }

    private async _writeDiaryEntry(
        result: DreamResult,
        today: string,
    ): Promise<void> {
        const diaryPath = path.join(this._files.root, "DREAMS.md");

        const entry = [
            `## ${today}`,
            "",
            `**Candidates examined:** ${result.candidatesExamined} of ${result.candidatesTotal}`,
            `**LLM calls:** ${result.modelCalls}`,
            "",
        ];

        if (result.insights.length > 0) {
            entry.push("### Insights Generated");
            for (const i of result.insights) {
                entry.push(`- **${i.theme}** — ${i.sources.length} source memories (${i.confidence} confidence)`);
            }
            entry.push("");
        }

        if (result.promotions.length > 0) {
            entry.push("### Promotions");
            for (const p of result.promotions) {
                entry.push(`- \`${p}\``);
            }
            entry.push("");
        }

        if (result.contradictions.length > 0) {
            entry.push("### Contradictions");
            for (const c of result.contradictions) {
                entry.push(`- ${c.wisdomEntry}: ${c.recommendation}`);
            }
            entry.push("");
        }

        if (result.gaps.length > 0) {
            entry.push("### Gaps Identified");
            for (const g of result.gaps) {
                entry.push(`- "${g.query}" — ${g.frequency} queries with poor results`);
            }
            entry.push("");
        }

        if (result.wikiUpdates.length > 0) {
            const succeeded = result.wikiUpdates.filter((u) => u.ok);
            const failed = result.wikiUpdates.filter((u) => !u.ok);
            entry.push(
                `### Wiki Updates (${succeeded.length}${failed.length > 0 ? `, ${failed.length} failed` : ""})`,
            );
            for (const u of succeeded) {
                entry.push(`- [[${u.slug}]] — ${u.op}: ${u.detail}`);
            }
            for (const u of failed) {
                entry.push(`- ⚠️ [[${u.slug}]] — ${u.op} failed: ${u.detail}`);
            }
            entry.push("");
        }

        entry.push("---", "");

        const entryText = entry.join("\n");

        // Append to existing diary or create new
        if (await this._storage.pathExists(diaryPath)) {
            const existing = await this._storage.readFile(diaryPath);
            const updated = existing.toString("utf-8").trimEnd() + "\n\n" + entryText;
            await this._storage.upsertFile(diaryPath, updated);
        } else {
            await this._storage.upsertFile(
                diaryPath,
                "# Dream Diary\n\n" + entryText,
            );
        }
    }

    private _getTemplates(): AnalysisTemplates {
        return {
            crossReference: this._config.analysisTemplates?.crossReference ?? CROSS_REFERENCE_TEMPLATE,
            gapAnalysis: this._config.analysisTemplates?.gapAnalysis ?? GAP_ANALYSIS_TEMPLATE,
            contradictionDetection: this._config.analysisTemplates?.contradictionDetection ?? CONTRADICTION_TEMPLATE,
            typedMemoryExtraction: this._config.analysisTemplates?.typedMemoryExtraction ?? TYPED_MEMORY_TEMPLATE,
            themeSynthesis: this._config.analysisTemplates?.themeSynthesis ?? THEME_SYNTHESIS_TEMPLATE,
            entityRename: this._config.analysisTemplates?.entityRename ?? ENTITY_RENAME_TEMPLATE,
            wisdomDistillation:
                this._config.analysisTemplates?.wisdomDistillation ??
                WISDOM_DISTILLATION_TEMPLATE,
        };
    }

    /**
     * Merge new content into an existing wiki page's body, detecting which
     * existing claims are superseded by the new content. Returns the
     * rewritten body plus a list of `SupersedesEntry`-shaped records for
     * each replaced claim.
     *
     * The merge step is what unlocks supersession in the dedup path.
     * Without it, dedup just appends new paragraphs to the existing body —
     * the page accumulates contradictory claims and the agent grabs the
     * first paragraph it sees (typically the older one). With it, when
     * day-14 revises a synergy value from $18M to $28M, the wiki body is
     * rewritten so the page's claim is $28M and the prior $18M claim is
     * recorded in `supersedes:` for traceability.
     *
     * Falls back to a plain append when the LLM response is unparseable
     * or absent, so a flaky completion never drops the new content.
     */
    private async _mergeWithSupersession(
        existing: WikiPage,
        newBody: string,
        newSource: string,
    ): Promise<{
        mode: "replace" | "append" | "merge";
        body: string;
        supersedes: { source: string; fact: string }[];
    }> {
        const prompt = MERGE_PROMPT_TEMPLATE
            .replace("{{EXISTING_BODY}}", existing.body.trim())
            .replace("{{NEW_BODY}}", newBody.trim())
            .replace("{{NEW_SOURCE}}", newSource)
            .replace("{{PAGE_NAME}}", existing.name);
        const fallback = (): {
            mode: "append";
            body: string;
            supersedes: { source: string; fact: string }[];
        } => {
            const sep = existing.body.endsWith("\n\n") ? "" : "\n\n";
            return {
                mode: "append",
                body: existing.body.replace(/\s+$/, "") +
                    sep +
                    newBody.trim() +
                    "\n",
                supersedes: [],
            };
        };
        let completion;
        try {
            completion = await this._model.complete(prompt, {
                systemPrompt:
                    "You are a wiki-merge engine. Output JSON only — no prose.",
                temperature: 0,
            });
        } catch {
            return fallback();
        }
        if (completion.error || !completion.text.trim()) return fallback();
        const cleaned = completion.text
            .replace(/^```json?\s*/m, "")
            .replace(/\s*```\s*$/m, "")
            .trim();
        let parsed: unknown;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            return fallback();
        }
        if (!parsed || typeof parsed !== "object") return fallback();
        const p = parsed as {
            mode?: unknown;
            body?: unknown;
            supersedes?: unknown;
        };
        const mode =
            p.mode === "replace" || p.mode === "append" || p.mode === "merge"
                ? (p.mode as "replace" | "append" | "merge")
                : "append";
        const body =
            typeof p.body === "string" && p.body.trim().length > 0
                ? p.body
                : fallback().body;
        const supersedes: { source: string; fact: string }[] = [];
        if (Array.isArray(p.supersedes)) {
            for (const raw of p.supersedes) {
                if (!raw || typeof raw !== "object") continue;
                const r = raw as { fact?: unknown; source?: unknown };
                const fact = typeof r.fact === "string" ? r.fact.trim() : "";
                // Default the source to the existing page's earliest
                // source — that's where the old claim lived. The model
                // can override per entry.
                const source =
                    typeof r.source === "string" && r.source.trim().length > 0
                        ? r.source.trim()
                        : (existing.sources[0]?.uri ?? "");
                if (fact && source) supersedes.push({ source, fact });
            }
        }
        return { mode, body, supersedes };
    }

    /**
     * Upsert a wiki page into the index immediately after it's written.
     *
     * Without this, pages created earlier in the same dream session aren't
     * visible to `_findDedupTarget` until the next `service.sync()`. That
     * defeats dedup: when day-N dreaming creates `condor-synergy-case` and
     * then later proposes `condor-valuation-frame`, the second create
     * can't see the first one to dedup against. Mirrors the temporal-tag
     * + metadata shape used by `MemoryService._indexWikiPages` so search
     * results are consistent regardless of which path indexed the page.
     */
    private async _upsertWikiPageInIndex(
        page: WikiPage,
        target: WikiTarget,
    ): Promise<void> {
        const slug = page.slug;
        const uri =
            target === "private"
                ? `memory/wiki/${slug}.md`
                : `memory/wiki/${target}/${slug}.md`;
        const embeddedText = withTemporalTag(
            [`# ${page.name}`, page.description, "", page.body.trim()]
                .filter((line) => line.length > 0 || line === "")
                .join("\n"),
            page.updated,
        );
        try {
            await this._index.upsertDocument(uri, embeddedText, {
                contentType: "wiki",
                period: page.updated,
                wikiCategory: page.category,
                wikiSlug: page.slug,
                wikiTarget: String(target),
                wikiSources: page.sources.length,
                // Mirror the service-level _indexWikiPages metadata so
                // either indexing path produces compatible metadata for
                // the search scorer's grounding penalty.
                wikiUnverified: page.grounding?.unverified.length ?? 0,
                wikiStale: page.grounding?.stale.length ?? 0,
            });
        } catch {
            // Indexing failures are non-fatal; the next service.sync() will
            // pick up the page. Worst case we miss one dedup opportunity.
        }
    }

    /**
     * Decide whether a `create` op should be transparently converted to an
     * `update` against an existing topically-overlapping wiki page.
     *
     * Uses pure-semantic retrieval (BM25 disabled) so the score is a
     * normalized cosine similarity in [0, 1]; the configured threshold
     * (`wikiDedupThreshold`, default 0.8) controls how aggressive the
     * dedup is. Returns null when no candidate clears the threshold or
     * when wiki search fails — the caller proceeds with a plain create.
     *
     * Probe text combines name + description + a body excerpt to
     * approximate the page's overall topic signature.
     */
    private async _findDedupTarget(
        op: Extract<DreamWikiOp, { op: "create" }>,
    ): Promise<{ slug: string; score: number } | null> {
        if (!this._wiki) return null;
        const threshold =
            this._config.wikiDedupThreshold ?? DEFAULT_WIKI_DEDUP_THRESHOLD;
        const probe = [
            op.name,
            op.description,
            op.body.slice(0, 600),
        ]
            .filter((s) => s && s.trim().length > 0)
            .join("\n\n");
        if (!probe.trim()) return null;
        const selfUri = `memory/wiki/${op.slug}.md`;
        try {
            const hits = await this._index.query(probe, {
                maxResults: 3,
                filter: { contentType: "wiki" },
                // Semantic-only: scores are normalized cosine similarity
                // in [0, 1] so the threshold is meaningful. The hybrid
                // path adds BM25 hits with un-normalized scores, which
                // makes thresholding unreliable.
                enableBM25: false,
            });
            for (const hit of hits) {
                if (hit.uri === selfUri) continue;
                if (!hit.uri.startsWith("memory/wiki/")) continue;
                if (hit.score >= threshold) {
                    const slug = hit.uri
                        .replace(/^memory\/wiki\//, "")
                        .replace(/\.md$/, "");
                    return { slug, score: hit.score };
                }
                // Hits are sorted desc by score; once we see a sub-
                // threshold hit, none of the rest will clear either.
                break;
            }
        } catch {
            // Index not ready or query failed — fall through to create.
        }
        return null;
    }

    /**
     * Apply a single wiki op against the bound WikiEngine. Errors are caught
     * and surfaced in the returned `DreamWikiUpdate` so a malformed model
     * response can't fail the whole session.
     *
     * After a successful op, immediately upserts the affected wiki page
     * into the index so subsequent dedup checks within the same dream
     * session can find it. Without this, the dedup runs against a stale
     * index and creates duplicate pages.
     */
    /**
     * Acquire a per-slug lock, run `fn`, then release. The lock is a
     * promise chain — each acquirer awaits the prior one and replaces
     * the tail. When the chain drains (no waiters), we drop the map
     * entry. Safe for nested ops on the same slug from a single async
     * task since each acquire pushes a new tail (this isn't a reentrant
     * mutex; don't nest the same slug inside itself).
     */
    private async _withSlugLock<T>(
        slug: string,
        fn: () => Promise<T>,
    ): Promise<T> {
        const prev = this._slugLocks.get(slug) ?? Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>((r) => {
            release = r;
        });
        // Tail this acquirer's release onto the chain so the next
        // waiter unblocks when we finish.
        const chained = prev.then(() => next);
        this._slugLocks.set(slug, chained);
        try {
            await prev;
            return await fn();
        } finally {
            release();
            // Drain the map entry once we're the tail and there are no
            // more pending waiters. The check is best-effort — if a new
            // acquirer slips in between the get + delete, the map will
            // still be correct since they're now writing their own tail.
            if (this._slugLocks.get(slug) === chained) {
                this._slugLocks.delete(slug);
            }
        }
    }

    private async _applyWikiOp(op: DreamWikiOp): Promise<DreamWikiUpdate> {
        // Resolve the effective slug BEFORE locking so we lock the right
        // one. For create ops the effective slug might be a dedup
        // target's slug (a different page that already exists); for
        // update / contradict it's just op.slug. We do the read-only
        // dedup probe outside the lock — it may race with parallel
        // writers, but the lock-then-recompute inside `_executeWikiOp`
        // converges to the right page.
        let effectiveSlug = op.slug;
        if (op.op === "create" && this._wiki) {
            try {
                const dedupTarget = await this._findDedupTarget(op);
                if (dedupTarget) effectiveSlug = dedupTarget.slug;
            } catch {
                // Index not ready or query failed — fall through with
                // the original op.slug; the inner path will retry.
            }
        }
        return this._withSlugLock(effectiveSlug, () =>
            this._applyWikiOpLocked(op),
        );
    }

    private async _applyWikiOpLocked(op: DreamWikiOp): Promise<DreamWikiUpdate> {
        const update = await this._executeWikiOp(op);
        if (update.ok && this._wiki) {
            // Grounding verification is parked. The verifier costs ~1
            // LLM call per wiki write (so ~30/checkpoint for a typical
            // dream pass) but the downstream penalty in SearchService
            // is currently no-op, so we're paying without benefit. The
            // method `_verifyGrounding` is still defined and the
            // `grounding` frontmatter shape is still parsed — turn this
            // call back on once the penalty is recalibrated.
            //
            // try { await this._verifyGrounding(update.slug, "private"); } catch { ... }
            const page = await this._wiki.read(update.slug, "private");
            if (page) {
                await this._upsertWikiPageInIndex(page, "private");
                // Maintain a trajectory companion page when this page
                // accumulates ≥2 supersession records. Synthesis-flavored
                // questions ("how did X evolve") then have a dedicated
                // chronological page to retrieve instead of needing the
                // agent to stitch a timeline by hand. Best-effort: a
                // failure here doesn't invalidate the underlying write.
                try {
                    await this._maintainTrajectoryPage(page, "private");
                } catch {
                    // Trajectory generation is purely additive; skip on error.
                }
                // Entity-rename detection. Looks for OTHER wiki pages whose
                // sources overlap heavily with this one but whose names
                // don't share a dominant proper noun — the "Northstar
                // Components → Northstar Gridworks" rename case that
                // merge-with-supersession can't catch because the two pages
                // live separately. Gated to ≥3 sources + a per-session cap
                // so the LLM cost stays bounded. Best-effort: never
                // invalidates the underlying write.
                try {
                    await this._detectAndApplyEntityRename(page, "private");
                } catch {
                    // Rename detection is best-effort; never block the write.
                }
            }
        }
        return update;
    }

    /**
     * Generate or refresh the trajectory companion for a wiki page that
     * has been revised at least twice. The companion page collects each
     * supersession entry in chronological order so retrieval of "how did
     * X change over time" questions lands on a single page that already
     * has the answer.
     *
     * Trigger is purely structural — `supersedes.length >= 2` — so this
     * applies equally to any topic that accumulates revisions, not just
     * the EA corpus's Condor pages. Trajectory pages never themselves
     * trigger trajectory companions (the slug-suffix gates that).
     */
    private async _maintainTrajectoryPage(
        sourcePage: WikiPage,
        target: WikiTarget,
    ): Promise<void> {
        if (!this._wiki) return;
        // Trajectory pages must not bootstrap recursively. Skip when the
        // page is itself a trajectory companion.
        if (/-trajectory$/.test(sourcePage.slug)) return;
        if (!sourcePage.supersedes || sourcePage.supersedes.length < 2) return;
        const trajectorySlug = `${sourcePage.slug}-trajectory`;
        const body = renderTrajectoryBody(sourcePage, trajectorySlug);
        const sources = collectTrajectorySources(sourcePage);
        const existing = await this._wiki.read(trajectorySlug, target);
        let written: WikiPage;
        if (existing) {
            written = {
                ...existing,
                body: ensureTrailingNewline(body),
                sources,
                related: existing.related.includes(sourcePage.slug)
                    ? existing.related
                    : [...existing.related, sourcePage.slug],
                updated: todayIso(),
            };
        } else {
            written = {
                slug: trajectorySlug,
                name: `${sourcePage.name} — trajectory`,
                description: `Chronological evolution of ${sourcePage.name}'s claims. See [[${sourcePage.slug}]] for the current state.`,
                category: "reference",
                created: todayIso(),
                updated: todayIso(),
                sources,
                related: [sourcePage.slug],
                confidence: "high",
                body: ensureTrailingNewline(body),
            };
        }
        await this._wiki.write(written, target);
        await this._upsertWikiPageInIndex(written, target);
        // Cross-link from the source page back to its trajectory.
        if (!sourcePage.related.includes(trajectorySlug)) {
            const linked: WikiPage = {
                ...sourcePage,
                related: [...sourcePage.related, trajectorySlug],
            };
            await this._wiki.write(linked, target);
            await this._upsertWikiPageInIndex(linked, target);
        }
    }

    /**
     * Detect that this wiki page and another existing page describe the
     * same underlying entity that has been renamed. The structural
     * pre-filter is intentionally light — both pages need ≥3 cited
     * sources and a source-set Jaccard ≥ `DEFAULT_ENTITY_RENAME_OVERLAP`.
     * A "names must diverge" pre-filter was tempting but would miss the
     * canonical case ("Northstar Components" → "Northstar Gridworks"
     * share "Northstar"), so the LLM verifier carries the load with a
     * bias-toward-false prompt.
     *
     * Per-session caps and a per-pair memo bound LLM cost. When the
     * verifier returns `same: true`, the page with the LATER most-recent
     * source is treated as canonical; the older page is converted to a
     * redirect stub and a `supersedes` entry is appended to the canonical
     * page noting the rename.
     */
    private async _detectAndApplyEntityRename(
        page: WikiPage,
        target: WikiTarget,
    ): Promise<void> {
        if (!this._wiki) return;
        if (this._entityRenameVerifications >= DEFAULT_MAX_ENTITY_RENAMES_PER_SESSION) {
            return;
        }
        if (page.redirectTo) return; // already a redirect — nothing to merge
        if (/-trajectory$/.test(page.slug)) return; // trajectory companions don't rename
        if ((page.sources ?? []).length < 3) return;

        // Build the candidate pool: pages other than `page` that share
        // enough source URIs.
        const pageSources = new Set(page.sources.map((s) => s.uri));
        const otherSlugs = await this._wiki.list(target);
        const candidates: {
            other: WikiPage;
            jaccard: number;
            sharedSources: number;
        }[] = [];
        for (const slug of otherSlugs) {
            if (slug === page.slug) continue;
            if (/-trajectory$/.test(slug)) continue;
            const other = await this._wiki.read(slug, target);
            if (!other) continue;
            if (other.redirectTo) continue;
            if ((other.sources ?? []).length < 3) continue;
            // Source-set Jaccard (by URI only — range/summary don't affect identity).
            const otherSources = new Set(other.sources.map((s) => s.uri));
            let intersect = 0;
            for (const s of pageSources) {
                if (otherSources.has(s)) intersect++;
            }
            const unionSize = pageSources.size + otherSources.size - intersect;
            if (unionSize === 0) continue;
            const jaccard = intersect / unionSize;
            if (jaccard < DEFAULT_ENTITY_RENAME_OVERLAP) continue;
            // Memoize per session so a repeated write to either page
            // doesn't re-verify the same pair.
            const memoKey = pairKey(page.slug, other.slug);
            if (this._entityRenameSeen.has(memoKey)) continue;
            candidates.push({ other, jaccard, sharedSources: intersect });
        }
        if (candidates.length === 0) return;
        // Take the highest-overlap candidate first. False positives at the
        // top of the list are the most damaging because they trigger an
        // actual page redirect; if the verifier rejects, we still cap the
        // session via the counter so the next write can try a different
        // pair next round.
        candidates.sort((a, b) => b.jaccard - a.jaccard);
        const best = candidates[0];
        const memoKey = pairKey(page.slug, best.other.slug);
        this._entityRenameSeen.add(memoKey);
        this._entityRenameVerifications++;

        const templates = this._getTemplates();
        const prompt = templates.entityRename
            .replace("{{PAGE_A_NAME}}", page.name)
            .replace("{{PAGE_A_SLUG}}", page.slug)
            .replace("{{PAGE_A_DESCRIPTION}}", page.description)
            .replace("{{PAGE_A_BODY_HEAD}}", page.body.split("\n").slice(0, 20).join("\n"))
            .replace("{{PAGE_A_SOURCES}}", page.sources.map((s) => s.uri).join("\n"))
            .replace("{{PAGE_B_NAME}}", best.other.name)
            .replace("{{PAGE_B_SLUG}}", best.other.slug)
            .replace("{{PAGE_B_DESCRIPTION}}", best.other.description)
            .replace("{{PAGE_B_BODY_HEAD}}", best.other.body.split("\n").slice(0, 20).join("\n"))
            .replace("{{PAGE_B_SOURCES}}", best.other.sources.map((s) => s.uri).join("\n"))
            .replace("{{JACCARD}}", best.jaccard.toFixed(2))
            .replace("{{SHARED_SOURCES}}", String(best.sharedSources));

        let completion;
        try {
            completion = await this._model.complete(prompt, {
                systemPrompt:
                    "You decide whether two wiki pages describe the same entity that has been renamed. Output JSON only — no prose.",
                temperature: 0,
            });
        } catch {
            return;
        }
        if (completion.error || !completion.text.trim()) return;
        const cleaned = completion.text
            .replace(/^```json?\s*/m, "")
            .replace(/\s*```\s*$/m, "")
            .trim();
        let parsed: unknown;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            return;
        }
        if (!parsed || typeof parsed !== "object") return;
        const r = parsed as {
            same?: unknown;
            canonical_slug?: unknown;
            old_name?: unknown;
            confidence?: unknown;
        };
        if (r.same !== true) return;
        // Pick canonical: prefer the LLM's choice when it matches one of
        // the two slugs; otherwise fall back to "page with the latest
        // dated source".
        let canonicalSlug: string;
        if (
            typeof r.canonical_slug === "string" &&
            (r.canonical_slug === page.slug || r.canonical_slug === best.other.slug)
        ) {
            canonicalSlug = r.canonical_slug;
        } else {
            canonicalSlug = pickCanonicalByLatestSource(page, best.other);
        }
        const obsoletePage =
            canonicalSlug === page.slug ? best.other : page;
        const canonicalPage =
            canonicalSlug === page.slug ? page : best.other;
        // Apply the rename:
        //   1. Convert obsoletePage to a redirect stub: clear body, set
        //      redirectTo, advance updated.
        //   2. MERGE the obsolete page's `sources` into the canonical
        //      page's `sources`. The canonical now owns the full
        //      contributor set across both names. This is what makes the
        //      wiki-anchored `memory_timeline` walk usable across
        //      renames — without it, the dailies that fed the old name
        //      get orphaned when their original page becomes a stub.
        //   3. Append a supersedes entry on the canonical capturing the
        //      old name as a renamed entity (uses the obsolete page's
        //      slug as a wiki: URI so traceability remains).
        const oldName =
            typeof r.old_name === "string" && r.old_name.trim().length > 0
                ? r.old_name.trim()
                : obsoletePage.name;
        try {
            const redirected: WikiPage = {
                ...obsoletePage,
                body: ensureTrailingNewline(
                    `This page has been merged into [[${canonicalSlug}]] as the result of an entity rename.\n\nPreviously known as: ${oldName}`,
                ),
                redirectTo: canonicalSlug,
                updated: todayIso(),
            };
            await this._wiki.write(redirected, target);
            await this._upsertWikiPageInIndex(redirected, target);

            // Source merge: union canonical's existing sources with the
            // obsolete page's sources (deduped by URI, original order
            // preserved). Range/summary from the canonical entry wins
            // when both pages cite the same URI.
            const mergedSources = [...canonicalPage.sources];
            const knownUris = new Set(mergedSources.map((s) => s.uri));
            for (const src of obsoletePage.sources) {
                if (!knownUris.has(src.uri)) {
                    mergedSources.push(src);
                    knownUris.add(src.uri);
                }
            }
            if (mergedSources.length > canonicalPage.sources.length) {
                const canonicalWithSources: WikiPage = {
                    ...canonicalPage,
                    sources: mergedSources,
                    updated: todayIso(),
                };
                await this._wiki.write(canonicalWithSources, target);
            }

            await this._wiki.recordSupersession(
                canonicalSlug,
                {
                    source: `wiki:${obsoletePage.slug}`,
                    fact: `Previously known as "${oldName}" (entity renamed)`,
                    supersededOn: todayIso(),
                },
                target,
            );
            // Re-index the canonical so the new sources + supersedes entry are searchable.
            const refreshedCanonical = await this._wiki.read(canonicalSlug, target);
            if (refreshedCanonical) {
                await this._upsertWikiPageInIndex(refreshedCanonical, target);
            }
        } catch {
            // Best-effort: leave state alone if anything fails.
        }
    }

    /**
     * Distill / patch WISDOM.md at the end of a dream session. Reads the
     * current wisdom file, the dream's recent activity (new insights,
     * contradictions, wiki updates), and an MRU rollup of wiki-page hits
     * from the search log. The LLM proposes a JSON list of `add` /
     * `update` / `remove` patches (or `keep_all` when nothing has
     * materially changed) against the current entries. The result is an
     * always-loadable pointer table the agent's host can pre-stuff into
     * its context on every turn.
     *
     * Best-effort: the caller catches errors. Hard caps (entry count,
     * char count) are enforced post-LLM in case the model overshoots.
     */
    private async _distillWisdom(result: DreamResult): Promise<void> {
        const cfg = this._config.wisdom ?? {};
        const maxEntries = cfg.maxEntries ?? DEFAULT_WISDOM_MAX_ENTRIES;
        const maxChars = cfg.maxChars ?? DEFAULT_WISDOM_MAX_CHARS;

        // Parse current wisdom.
        const existing = (await this._files.readWisdom()) ?? "";
        const currentEntries = parseWisdomEntries(existing);

        // MRU rollup over the dreaming signal window.
        const windowDays =
            this._config.signalWindowDays ?? DEFAULT_SIGNAL_WINDOW_DAYS;
        let mru: Array<{
            slug: string;
            hits: number;
            bestScore: number;
            lastHit: string;
            uniqueQueries: number;
        }> = [];
        try {
            mru = await this._logger.getWikiPageHitsByWindow(windowDays);
        } catch {
            // Search log unavailable — proceed with empty MRU.
        }
        const mruHot = mru.slice(0, 30);
        const hotSlugs = new Set(mruHot.map((m) => m.slug));
        const coldSlugs: string[] = [];
        for (const entry of currentEntries) {
            // Cold = wisdom entry referencing a slug that hasn't been
            // retrieved within the window. Surface to the LLM as a
            // removal candidate (signal, not directive).
            for (const slug of extractSlugLinks(entry.content)) {
                if (!hotSlugs.has(slug)) coldSlugs.push(`${entry.id} → ${slug}`);
            }
        }

        // Recent wiki updates + insights from this dream pass.
        const wikiUpdateSlugs = result.wikiUpdates
            .filter((u) => u.ok)
            .map((u) => u.slug);
        const insightThemes = result.insights.map((i) => i.theme);
        const contradictionThemes = result.contradictions.map((c) => c.wisdomEntry);

        // Build prompt.
        const templates = this._getTemplates();
        const prompt = templates.wisdomDistillation
            .replace("{{MAX_ENTRIES}}", String(maxEntries))
            .replace("{{MAX_CHARS}}", String(maxChars))
            .replace(
                "{{CURRENT_WISDOM}}",
                currentEntries.length > 0
                    ? currentEntries
                          .map((e) => `- **${e.id}** — ${e.content}`)
                          .join("\n")
                    : "(WISDOM.md is currently empty.)",
            )
            .replace(
                "{{MRU_HOT}}",
                mruHot.length > 0
                    ? mruHot
                          .map(
                              (m) =>
                                  `- [[${m.slug}]] — ${m.hits} hits, ${m.uniqueQueries} unique queries, last hit ${m.lastHit.slice(0, 10)}, best score ${m.bestScore.toFixed(2)}`,
                          )
                          .join("\n")
                    : "(no wiki hits in window — fresh corpus or no searches yet)",
            )
            .replace(
                "{{COLD_ENTRIES}}",
                coldSlugs.length > 0
                    ? coldSlugs.map((s) => `- ${s}`).join("\n")
                    : "(no cold entries)",
            )
            .replace(
                "{{NEW_WIKI_UPDATES}}",
                wikiUpdateSlugs.length > 0
                    ? wikiUpdateSlugs.map((s) => `- [[${s}]]`).join("\n")
                    : "(no wiki updates this pass)",
            )
            .replace(
                "{{NEW_INSIGHTS}}",
                insightThemes.length > 0
                    ? insightThemes.map((t) => `- ${t}`).join("\n")
                    : "(no new insights this pass)",
            )
            .replace(
                "{{NEW_CONTRADICTIONS}}",
                contradictionThemes.length > 0
                    ? contradictionThemes.map((t) => `- ${t}`).join("\n")
                    : "(no new contradictions this pass)",
            )
            .replace("{{WINDOW_DAYS}}", String(windowDays));

        let completion;
        try {
            completion = await this._model.complete(prompt, {
                systemPrompt:
                    "You maintain WISDOM.md — a curated pointer table of patterns and lessons. Output JSON only — no prose, no markdown fences.",
                temperature: 0.2,
            });
        } catch {
            return;
        }
        if (completion.error || !completion.text.trim()) return;
        const cleaned = completion.text
            .replace(/^```json?\s*/m, "")
            .replace(/\s*```\s*$/m, "")
            .trim();
        let parsed: unknown;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            return;
        }
        if (!parsed || typeof parsed !== "object") return;
        const r = parsed as { patches?: unknown };
        if (!Array.isArray(r.patches)) return;

        const updated = applyWisdomPatches(currentEntries, r.patches, {
            maxEntries,
            maxChars,
            mru: mruHot,
        });
        if (updated === null) return; // keep_all or invalid

        const serialized = serializeWisdom(updated);
        await this._files.writeWisdom(serialized);
    }

    /**
     * Post-write grounding check: ask the LLM whether each factual claim
     * in the wiki body is supported by at least one cited source, and
     * whether a later cited source contradicts it. Writes the result back
     * to the page's `grounding` frontmatter so retrieval can demote
     * pages with unverified or stale claims.
     *
     * Uses the dreaming model (typically gpt-5.4) since this runs once
     * per wiki write, not per query — quality matters more than cost.
     * Best-effort: any LLM error leaves the page's prior grounding (or
     * absence thereof) unchanged.
     */
    private async _verifyGrounding(
        slug: string,
        target: "private",
    ): Promise<void> {
        if (!this._wiki) return;
        const page = await this._wiki.read(slug, target);
        if (!page) return;
        if (page.sources.length === 0) return; // no sources to ground against

        // Load up to 6 cited sources (most-recent-first when datable) so
        // the verifier sees both the originating dailies and any later
        // ones that would supersede.
        const dateRe = /(\d{4}-\d{2}-\d{2})/;
        const sortedSources = [...page.sources].sort((a, b) => {
            const da = a.uri.match(dateRe)?.[1] ?? "";
            const db = b.uri.match(dateRe)?.[1] ?? "";
            if (da && db) return db.localeCompare(da);
            if (da) return -1;
            if (db) return 1;
            return 0;
        });
        const sourceContents: { uri: string; content: string }[] = [];
        for (const src of sortedSources.slice(0, 6)) {
            const date = src.uri.match(dateRe)?.[1];
            if (!date) continue;
            try {
                const c = await this._files.readDaily(date);
                if (c) sourceContents.push({ uri: src.uri, content: c });
            } catch {
                // ignore
            }
        }
        if (sourceContents.length === 0) return;

        const prompt = GROUNDING_PROMPT_TEMPLATE
            .replace("{{PAGE_NAME}}", page.name)
            .replace("{{PAGE_BODY}}", page.body.trim())
            .replace(
                "{{SOURCES}}",
                sourceContents
                    .map((s) => `<source ${s.uri}>\n${s.content.trim()}\n</source>`)
                    .join("\n\n"),
            );
        let completion;
        try {
            completion = await this._model.complete(prompt, {
                systemPrompt:
                    "You verify wiki claims against cited sources. Output JSON only.",
                temperature: 0,
            });
        } catch {
            return;
        }
        if (completion.error || !completion.text.trim()) return;
        const cleaned = completion.text
            .replace(/^```json?\s*/m, "")
            .replace(/\s*```\s*$/m, "")
            .trim();
        let parsed: unknown;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            return;
        }
        if (!parsed || typeof parsed !== "object") return;
        const r = parsed as {
            grounded?: unknown;
            unverified?: unknown;
            stale?: unknown;
        };
        const grounded =
            typeof r.grounded === "number" && r.grounded >= 0 ? r.grounded : 0;
        const unverified = Array.isArray(r.unverified)
            ? (r.unverified as unknown[])
                  .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
                  .slice(0, 10)
            : [];
        const stale = Array.isArray(r.stale)
            ? (r.stale as unknown[])
                  .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
                  .slice(0, 10)
            : [];
        const verifiedOn = new Date().toISOString().slice(0, 10);
        const next: WikiPage = {
            ...page,
            grounding: { verifiedOn, grounded, unverified, stale },
            // Keep `updated` unchanged — verification didn't change the
            // body or sources; bumping `updated` would shift retrieval
            // recency boosts misleadingly.
        };
        await this._wiki.write(next, target);
    }

    private async _executeWikiOp(op: DreamWikiOp): Promise<DreamWikiUpdate> {
        if (!this._wiki) {
            return {
                op: op.op,
                slug: op.slug,
                ok: false,
                detail: "no wiki engine wired",
            };
        }
        try {
            if (op.op === "create") {
                // Apply-time dedup: before creating, search the wiki for an
                // existing topically-overlapping page. If one exists above
                // the cosine-similarity threshold, treat this create as an
                // update against that page. This catches near-duplicates
                // the LLM missed even with the related-pages context, and
                // it's what unlocks supersession — without dedup, day-14
                // synergy revisions create a SECOND page instead of
                // updating the original, so `recordSupersession` is never
                // invoked. See dreaming-config.ts for the threshold rationale.
                const dedupTarget = await this._findDedupTarget(op);
                if (dedupTarget) {
                    const existing = await this._wiki.read(
                        dedupTarget.slug,
                        "private",
                    );
                    if (existing) {
                        const merge = await this._mergeWithSupersession(
                            existing,
                            op.body,
                            op.sources[0] ?? `dream:${todayIso()}`,
                        );
                        // Union sources (existing + new). Op sources are
                        // bare URIs from the dreaming proposal; wrap them
                        // into SourceContribution shape on the way into
                        // the page.
                        const nextSources = [...existing.sources];
                        for (const s of op.sources) {
                            if (!nextSources.some((c) => c.uri === s)) {
                                nextSources.push({ uri: s });
                            }
                        }
                        await this._wiki.write(
                            {
                                ...existing,
                                body: ensureTrailingNewline(merge.body),
                                sources: nextSources,
                                updated: todayIso(),
                            },
                            "private",
                        );
                        for (const s of merge.supersedes) {
                            await this._wiki.recordSupersession(
                                dedupTarget.slug,
                                s,
                                "private",
                            );
                        }
                        // If the original op itself carried supersedes (rare
                        // — it's the supersession-signal path), also record
                        // that to keep both signals.
                        if (op.supersedes) {
                            await this._wiki.recordSupersession(
                                dedupTarget.slug,
                                op.supersedes,
                                "private",
                            );
                        }
                        const detail =
                            `deduped onto [[${dedupTarget.slug}]] ` +
                            `(cosine ${dedupTarget.score.toFixed(2)}); ` +
                            `mode=${merge.mode}` +
                            (merge.supersedes.length > 0
                                ? `; superseded ${merge.supersedes.length} fact${merge.supersedes.length === 1 ? "" : "s"}`
                                : "") +
                            (op.supersedes ? `; +op.supersedes ${op.supersedes.source}` : "");
                        return {
                            op: op.op,
                            slug: dedupTarget.slug,
                            ok: true,
                            detail,
                        };
                    }
                    // Existing page disappeared between dedup-find and now
                    // — defensive fallthrough to the standard create path.
                }
                const existing = await this._wiki.read(op.slug, "private");
                if (existing) {
                    // Treat create-on-existing as an append rather than a hard
                    // failure — dreaming often re-proposes seeds.
                    const updated = await this._wiki.append(
                        op.slug,
                        op.sources[0] ?? `dream:${todayIso()}`,
                        op.body,
                        "private",
                    );
                    let detail = `create-on-existing → appended (${updated.sources.length} sources)`;
                    if (op.supersedes) {
                        await this._wiki.recordSupersession(
                            op.slug,
                            op.supersedes,
                            "private",
                        );
                        detail += `; supersedes ${op.supersedes.source}`;
                    }
                    return {
                        op: op.op,
                        slug: op.slug,
                        ok: true,
                        detail,
                    };
                }
                if (op.category === "theme") {
                    // Theme pages are synthesis-only; emit them as full pages
                    // since dreaming is itself the synthesis source. Bypass
                    // the stub() path's category guard by going through write().
                    await this._wiki.write(
                        {
                            slug: op.slug,
                            name: op.name,
                            description: op.description,
                            category: op.category,
                            created: todayIso(),
                            updated: todayIso(),
                            sources: op.sources.map((s) => ({ uri: s })),
                            related: op.related ?? [],
                            confidence: op.confidence ?? "medium",
                            body: ensureTrailingNewline(op.body),
                        },
                        "private",
                    );
                } else {
                    await this._wiki.stub({
                        slug: op.slug,
                        name: op.name,
                        description: op.description,
                        category: op.category,
                        source: op.sources[0] ?? `dream:${todayIso()}`,
                        body: op.body,
                        related: op.related ?? [],
                    });
                    // If the model proposed >1 source on create, fold the rest in.
                    for (const extra of op.sources.slice(1)) {
                        await this._wiki.append(op.slug, extra, "", "private");
                    }
                }
                let detail = `created (${op.sources.length} source${op.sources.length === 1 ? "" : "s"})`;
                if (op.supersedes) {
                    await this._wiki.recordSupersession(
                        op.slug,
                        op.supersedes,
                        "private",
                    );
                    detail += `; supersedes ${op.supersedes.source}`;
                }
                return {
                    op: op.op,
                    slug: op.slug,
                    ok: true,
                    detail,
                };
            }
            if (op.op === "update") {
                await this._wiki.append(
                    op.slug,
                    op.source,
                    op.appendBody,
                    "private",
                );
                let detail = `appended ${op.source}`;
                if (op.supersedes) {
                    await this._wiki.recordSupersession(
                        op.slug,
                        op.supersedes,
                        "private",
                    );
                    detail += `; supersedes ${op.supersedes.source}`;
                }
                return {
                    op: op.op,
                    slug: op.slug,
                    ok: true,
                    detail,
                };
            }
            // op === "contradict"
            const existing = await this._wiki.read(op.slug, "private");
            if (!existing) {
                return {
                    op: op.op,
                    slug: op.slug,
                    ok: false,
                    detail: `no such page`,
                };
            }
            const next = unionStrings(existing.contradicts ?? [], op.contradicts);
            await this._wiki.write(
                {
                    ...existing,
                    contradicts: next,
                    updated: todayIso(),
                },
                "private",
            );
            return {
                op: op.op,
                slug: op.slug,
                ok: true,
                detail: op.note
                    ? `marked contradicting [${op.contradicts.join(", ")}] — ${op.note}`
                    : `marked contradicting [${op.contradicts.join(", ")}]`,
            };
        } catch (err) {
            return {
                op: op.op,
                slug: op.slug,
                ok: false,
                detail: err instanceof Error ? err.message : String(err),
            };
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────

/**
 * Render the markdown body of a trajectory companion page. Entries are
 * sorted by `supersededOn` ascending so a reader walks the timeline in
 * the obvious direction.
 */
function renderTrajectoryBody(page: WikiPage, _selfSlug: string): string {
    const sorted = [...(page.supersedes ?? [])].sort((a, b) =>
        a.supersededOn.localeCompare(b.supersededOn),
    );
    const lines: string[] = [];
    lines.push(`# Trajectory: ${page.name}`);
    lines.push("");
    lines.push(
        `This page tracks how ${page.name} has evolved. The most ` +
            `current claim lives in [[${page.slug}]]; superseded ` +
            `claims are preserved here in chronological order so ` +
            `"how did X change?" questions can land on a single page.`,
    );
    lines.push("");
    lines.push(`## Current state`);
    lines.push(
        `As of ${page.updated}, see [[${page.slug}]] for the full ` +
            `current body. Brief excerpt:`,
    );
    lines.push("");
    const firstPara = (page.body ?? "").trim().split(/\n\n/)[0] ?? "";
    lines.push(firstPara || "(no current body recorded)");
    lines.push("");
    lines.push(`## Superseded claims (oldest first)`);
    if (sorted.length === 0) {
        lines.push(`(none recorded)`);
    } else {
        for (const s of sorted) {
            const fact = s.fact?.trim() || "(no summary recorded)";
            lines.push(`- **Until ${s.supersededOn}:** ${fact}`);
            lines.push(`  - Source: ${s.source}`);
        }
    }
    return lines.join("\n");
}

/**
 * Collect the union of the page's own sources plus every URI named in
 * its `supersedes` entries. The trajectory page's `sources` field then
 * covers everything the timeline references, so retrieval that lands
 * on the trajectory page can drill into any era. Preserves the source
 * page's range/summary metadata for entries that have it; supersession
 * URIs are added as bare {uri} entries (no enrichment).
 */
function collectTrajectorySources(page: WikiPage): SourceContribution[] {
    const seen = new Set<string>();
    const out: SourceContribution[] = [];
    for (const s of page.sources) {
        if (!seen.has(s.uri)) {
            seen.add(s.uri);
            out.push(s);
        }
    }
    for (const sup of page.supersedes ?? []) {
        if (sup.source && !seen.has(sup.source)) {
            seen.add(sup.source);
            out.push({ uri: sup.source });
        }
    }
    return out;
}

function aggregateResults(
    analysisResults: AnalysisResult[],
    totalCandidates: number,
): DreamResult {
    const result: DreamResult = {
        insights: [],
        promotions: [],
        contradictions: [],
        gaps: [],
        wikiUpdates: [],
        candidatesExamined: analysisResults.length,
        candidatesTotal: totalCandidates,
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
    };

    for (const ar of analysisResults) {
        result.insights.push(...ar.insights);
        result.promotions.push(...ar.promotions.map((p) => p.filename));
        result.contradictions.push(...ar.contradictions);
        result.gaps.push(...ar.gaps);
        result.modelCalls += ar.modelCalls;
        result.inputTokens += ar.inputTokens;
        result.outputTokens += ar.outputTokens;
    }

    return result;
}

function ensureTrailingNewline(s: string): string {
    return s.endsWith("\n") ? s : s + "\n";
}

function todayIso(): string {
    return new Date().toISOString().split("T")[0];
}

function unionStrings(a: string[], b: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of [...a, ...b]) {
        if (!seen.has(v)) {
            seen.add(v);
            out.push(v);
        }
    }
    return out;
}

const VALID_WIKI_CATEGORIES = new Set([
    "entity",
    "concept",
    "project",
    "reference",
    "theme",
]);
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate a model-supplied wiki op into a typed `DreamWikiOp`, or return
 * null if it's missing required fields or has an unrecognized shape. The
 * candidate's URIs are used as a fallback source list when `create` lacks
 * explicit sources.
 */
function coerceWikiOp(
    raw: unknown,
    candidate: DreamCandidate,
): DreamWikiOp | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const op = r.op;
    const slug = typeof r.slug === "string" ? r.slug.trim() : "";
    if (!slug || !SLUG_RE.test(slug)) return null;

    if (op === "create") {
        const category = r.category as string;
        if (!VALID_WIKI_CATEGORIES.has(category)) return null;
        const body = typeof r.body === "string" ? r.body : "";
        if (!body.trim()) return null;
        const sourcesIn = Array.isArray(r.sources)
            ? (r.sources as string[]).filter(
                  (s) => typeof s === "string" && s.length > 0,
              )
            : [];
        const sources = sourcesIn.length > 0 ? sourcesIn : candidate.uris;
        if (sources.length === 0) return null;
        const out: Extract<DreamWikiOp, { op: "create" }> = {
            op: "create",
            slug,
            category: category as DreamWikiOp extends { op: "create"; category: infer C }
                ? C
                : never,
            name: typeof r.name === "string" && r.name.length > 0 ? r.name : slug,
            description:
                typeof r.description === "string" ? r.description : "",
            body,
            sources,
        };
        const related = Array.isArray(r.related)
            ? (r.related as string[]).filter(
                  (s) => typeof s === "string" && SLUG_RE.test(s),
              )
            : undefined;
        if (related !== undefined) out.related = related;
        const confidence =
            r.confidence === "high" ||
            r.confidence === "medium" ||
            r.confidence === "low"
                ? r.confidence
                : undefined;
        if (confidence !== undefined) out.confidence = confidence;
        const supersedes = coerceSupersedes(r.supersedes);
        if (supersedes) out.supersedes = supersedes;
        return out;
    }
    if (op === "update") {
        const appendBody =
            typeof r.appendBody === "string"
                ? r.appendBody
                : typeof r.append_body === "string"
                  ? r.append_body
                  : "";
        const source = typeof r.source === "string" ? r.source : "";
        if (!source || !appendBody.trim()) return null;
        const out: Extract<DreamWikiOp, { op: "update" }> = {
            op: "update",
            slug,
            appendBody,
            source,
        };
        const supersedes = coerceSupersedes(r.supersedes);
        if (supersedes) out.supersedes = supersedes;
        return out;
    }
    if (op === "contradict") {
        const contradicts = Array.isArray(r.contradicts)
            ? (r.contradicts as string[]).filter(
                  (s) => typeof s === "string" && SLUG_RE.test(s),
              )
            : [];
        if (contradicts.length === 0) return null;
        return {
            op: "contradict",
            slug,
            contradicts,
            note: typeof r.note === "string" ? r.note : undefined,
        };
    }
    return null;
}

/**
 * Validate a model-supplied `supersedes` object into the shape DreamWikiOp
 * expects: `{ source: string; fact?: string }`. Returns null when source
 * is missing or empty so the parent op stays usable.
 */
function coerceSupersedes(
    raw: unknown,
): { source: string; fact?: string } | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const source = typeof r.source === "string" ? r.source.trim() : "";
    if (!source) return null;
    const out: { source: string; fact?: string } = { source };
    if (typeof r.fact === "string" && r.fact.length > 0) out.fact = r.fact;
    return out;
}

// ─── Analysis Prompt Templates ───────────────────────────

const CROSS_REFERENCE_TEMPLATE = `You are an analytical memory engine examining cross-cutting patterns across agent memories.

<TASK>
Examine the provided memories and identify:
1. Patterns that span multiple time periods
2. Evolution of decisions, approaches, or understanding over time
3. Recurring themes or entities that suggest deeper connections
4. Wiki pages worth creating or updating to compound this knowledge

<OUTPUT_FORMAT>
Respond with a JSON object:
{
  "insights": [
    {
      "theme": "short-theme-name",
      "body": "2-4 sentence insight explaining the pattern",
      "sources": ["memory/YYYY-MM-DD.md", ...],
      "confidence": "high" | "medium" | "low"
    }
  ],
  "promotions": [],
  "contradictions": [],
  "gaps": [],
  "wiki_ops": [
    {
      "op": "create",
      "slug": "kebab-case-slug",
      "category": "entity" | "concept" | "project" | "reference" | "theme",
      "name": "Human-readable title",
      "description": "One-line description for the wiki index",
      "body": "Markdown body (use ## headings; no frontmatter, no H1)",
      "sources": ["memory/YYYY-MM-DD.md", ...],
      "related": ["other-slug", ...],
      "confidence": "high" | "medium" | "low"
    },
    {
      "op": "update",
      "slug": "existing-slug",
      "appendBody": "Markdown fragment to append under a new ## heading",
      "source": "memory/YYYY-MM-DD.md"
    },
    {
      "op": "contradict",
      "slug": "page-with-newer-claim",
      "contradicts": ["page-with-older-claim"],
      "note": "Brief explanation for the diary"
    }
  ]
}

<RULES>
- Only emit wiki_ops when the pattern is reusable, named knowledge — not just a daily-log highlight.
- **Prefer UPDATE over CREATE when an existing page covers the topic.** If an "Existing wiki pages on related topics" section appears above, scan it before emitting a create op. If any listed page already covers the same topic (same project, same entity, same recurring theme), emit an UPDATE op against its slug instead of a CREATE op for a near-duplicate. The wiki only stays useful if one topic = one page; duplicate pages with conflicting facts crowd each other out at search time.
- Concept and project pages SHOULD lead with a rule/fact followed by **Why:** and **How to apply:** lines.
- Entity pages capture stable facts about a person, system, or organization.
- Theme pages synthesize a recurring topic across many sources.
- Reference pages catalog external URLs, dashboards, or runbooks.
- Slugs are lowercase ASCII, hyphen-separated (e.g. "auth-middleware", "postgres-migration").
- Sources must be URIs from the provided memories — do not invent.
- Confidence: high = 3+ supporting memories, medium = 2, low = 1 with strong signal.
- Do not fabricate connections — report what is actually present.`;

const GAP_ANALYSIS_TEMPLATE = `You are an analytical memory engine identifying knowledge gaps.

<TASK>
Examine the provided memories and queries. Identify:
1. Topics that were searched but have no good coverage in memory
2. Time periods with sparse or missing information
3. Questions the memory system cannot answer well based on available content

<OUTPUT_FORMAT>
Respond with a JSON object:
{
  "insights": [
    {
      "theme": "gap-description",
      "body": "What is missing and why it matters",
      "sources": [],
      "confidence": "medium"
    }
  ],
  "promotions": [],
  "contradictions": [],
  "gaps": [
    {
      "query": "the query or topic with poor coverage",
      "frequency": 0,
      "lastQueried": ""
    }
  ]
}

<RULES>
- Focus on gaps that would actually matter for future work
- Distinguish between intentional silence (nothing happened) and missing coverage
- Suggest what kind of information would fill each gap`;

const CONTRADICTION_TEMPLATE = `You are an analytical memory engine detecting contradictions and supersessions.

You may be given any of three input shapes:

  (a) WISDOM.md + recent memories (the classic wisdom-drift case).
  (b) A single recent daily log + the "Current wiki state (candidates for supersession)" block — wiki pages that semantically match the daily. This is the supersession-signal case.
  (c) Both.

<TASKS>
For each input, choose one or more of these outcomes:

1. UPDATE wisdom — a WISDOM.md principle needs sharper wording. → emit a "contradictions" entry.
2. CONTRADICT wisdom — a WISDOM.md principle is no longer accurate. → emit a "contradictions" entry recommending rewrite.
3. PROMOTE_TO_WIKI — a wisdom entry is topical (about a specific person, project, system, or recurring theme) rather than a cross-topic principle. → emit a "wiki_ops" create op (per spec §12.4).
4. SUPERSEDE wiki — the new daily contains a fact that overrides an existing wiki claim. The daily wins; the wiki must evolve. → emit a "wiki_ops" update (or create, if no matching page exists) with a "supersedes" field pointing at the prior source. The wiki page is "current state"; the old daily stays in history.

<OUTPUT_FORMAT>
Respond with a JSON object:
{
  "insights": [],
  "promotions": [],
  "contradictions": [
    {
      "wisdomEntry": "The wisdom entry title or text",
      "evidence": ["memory/YYYY-MM-DD.md — description of contradicting behavior"],
      "recommendation": "How WISDOM.md should be updated"
    }
  ],
  "gaps": [],
  "wiki_ops": [
    {
      "op": "create" | "update",
      "slug": "kebab-case-slug",
      "category": "entity" | "concept" | "project" | "reference" | "theme",
      "name": "Human-readable title",
      "description": "One-line description",
      "body": "Markdown body (create) or appendBody (update). Concept/project pages SHOULD lead with a rule/fact followed by **Why:** and **How to apply:**.",
      "appendBody": "Markdown fragment for update ops",
      "source": "memory/YYYY-MM-DD.md (single source for update ops)",
      "sources": ["memory/YYYY-MM-DD.md", ...],
      "supersedes": {
        "source": "memory/YYYY-MM-DD.md (the older claim's source)",
        "fact": "One-line summary of the prior claim being overridden"
      }
    }
  ]
}

<RULES>
- Only flag genuine contradictions / supersessions with clear evidence in the provided text.
- Evolution is not contradiction. If a principle was refined or a fact got more specific, prefer UPDATE (with no supersedes).
- A supersession is when one fact *replaces* another (e.g. "switched from Postgres to MySQL"), not when one *adds* to another ("also testing MySQL on the side"). Be conservative.
- Wiki pages are the current state of record. A supersession op tells future retrieval "this page used to say X; it now says Y, and here's the older source." Always include "supersedes.source" pointing at the URI that holds the older claim.
- Promote to wiki when the wisdom entry describes a *thing* rather than a *rule*:
  - "Use Postgres for the ledger" — topical → promote (project: ledger-storage)
  - "Prefer additive migrations" — principle → keep in WISDOM.md
- Slugs are lowercase ASCII, hyphen-separated. Sources must be URIs from the provided memories.`;

const TYPED_MEMORY_TEMPLATE = `You are an analytical memory engine extracting durable knowledge that was missed during compaction.

<TASK>
Examine the provided memories for:
1. Decisions that should be project or feedback typed memories
2. Preferences or working patterns that should be user typed memories
3. External resources or references that should be reference typed memories
4. Lessons learned that should be feedback typed memories

<OUTPUT_FORMAT>
Respond with a JSON object:
{
  "insights": [],
  "promotions": [
    {
      "filename": "type_topic.md",
      "content": "---\\nname: Topic Name\\ndescription: One-line description\\ntype: feedback|project|user|reference\\n---\\n\\nBody with **Why:** and **How to apply:** lines for feedback/project types."
    }
  ],
  "contradictions": [],
  "gaps": []
}

<RULES>
- Conservative bias: when in doubt, skip
- Do not extract facts derivable from code or git history
- Do not extract ephemeral task state
- Each promotion must have complete YAML frontmatter
- For feedback/project types, include Why and How to apply lines`;

const THEME_SYNTHESIS_TEMPLATE = `You are an analytical memory engine synthesizing themes across temporal boundaries.

<TASK>
Examine the provided memories that share a common theme or entity. Synthesize:
1. The trajectory — what started, what changed, what resolved
2. Key inflection points or decisions
3. Current state and likely future direction
4. Any emerging patterns that aren't obvious from individual entries

<OUTPUT_FORMAT>
Respond with a JSON object:
{
  "insights": [
    {
      "theme": "theme-name",
      "body": "Multi-sentence synthesis of the theme trajectory",
      "sources": ["memory/YYYY-MM-DD.md", ...],
      "confidence": "high" | "medium" | "low"
    }
  ],
  "promotions": [],
  "contradictions": [],
  "gaps": []
}

<RULES>
- Synthesize, don't summarize — the value is in connecting dots across time
- Identify inflection points where direction changed
- Note if the theme is still active or resolved`;

/**
 * Prompt used by `_mergeWithSupersession` to fold new content into an
 * existing wiki body. The model picks one of three modes:
 *
 *   - "replace": new content overrides specific claims in the existing
 *     body. Rewrites the body so the new claim is the page's current
 *     claim and emits `supersedes` entries for each replaced fact.
 *   - "merge":   new content is partly new, partly overlapping. Produces
 *     a coherent rewrite that keeps non-conflicting old material and
 *     records supersedes for anything replaced.
 *   - "append":  new content adds to the existing body without
 *     contradicting it. No supersedes.
 *
 * The output must be a single JSON object — no prose, no markdown
 * fences. Body markdown should be a clean rewrite, NOT a diff or
 * change-log.
 *
 * Why this matters: without this merge step, dedup converts every
 * duplicate create into an append. The wiki body becomes a chronological
 * accretion of old + new claims, and the agent grabs whichever paragraph
 * the LLM happens to read first — typically the older one. With it, the
 * wiki page is genuinely "current state of record" and the supersedes
 * frontmatter preserves the audit trail.
 */
/**
 * Prompt for the post-write grounding verifier.
 *
 * The verifier scores the wiki body against the cited sources and
 * returns three lists: `grounded` (a count of claims that match a
 * source verbatim or as a clear paraphrase), `unverified` (claims the
 * body makes that no source supports — likely synthesis hallucinations),
 * and `stale` (claims supported by an earlier source but contradicted
 * by a later one — the supersession step missed these). The retrieval
 * layer downranks pages with non-empty `unverified` / `stale`.
 *
 * The model sees sources in newest-first order so it can naturally
 * spot the "earlier source says X, later source says Y" pattern.
 */
const GROUNDING_PROMPT_TEMPLATE = `You verify a wiki page's claims against its cited sources.

<WIKI PAGE: {{PAGE_NAME}}>
{{PAGE_BODY}}
</WIKI PAGE>

<CITED SOURCES (newest first)>
{{SOURCES}}
</CITED SOURCES>

<TASK>
Walk every numeric value, named entity, date, and decision in the wiki body. For each:
1. Find the source(s) that mention it. If a source uses different wording, count it as a match when the underlying claim is the same.
2. Decide:
   - GROUNDED: at least one source supports the claim. No earlier-vs-later contradiction.
   - UNVERIFIED: no cited source mentions this claim. It's either a synthesis invention or a claim the verifier can't match. Flag it.
   - STALE: an earlier cited source supports it but a later cited source contradicts it. The body should reflect the latest, but it's holding the older value. Flag with the latest source's value so the merge step knows what to rewrite to.

<OUTPUT_FORMAT>
Respond with one JSON object — no prose, no fences:

{
  "grounded": <integer count of claims that passed verification>,
  "unverified": [
    "<short description of the unverified claim, e.g. 'walkaway floor of $500M EV'>"
  ],
  "stale": [
    "<short description of the stale claim and its latest contradicting value, e.g. 'synergy base $18M (latest source says $28M)'>"
  ]
}

<RULES>
- Be conservative: when in doubt, count as grounded.
- Only flag UNVERIFIED for specific values that the synthesis model could plausibly have invented — not for paraphrased framing.
- STALE requires an explicit later contradiction. "Source A says X" + "Source B doesn't mention X" is NOT stale; it's just grounded by A.
- Quantitative claims (money, percentages, leverage, dates, names) are the primary targets. Skip generic framing like "the workstream stayed isolated."`;

const MERGE_PROMPT_TEMPLATE = `You are merging new content into an existing wiki page.

<EXISTING PAGE: {{PAGE_NAME}}>
{{EXISTING_BODY}}
</EXISTING PAGE>

<NEW CONTENT (from {{NEW_SOURCE}})>
{{NEW_BODY}}
</NEW CONTENT>

<TASK>
The new content has been routed to this page because they cover the same topic. Decide how to fold it in:

1. Identify SUPERSEDED claims — facts the existing body asserts that the new content contradicts or revises (e.g. existing says "base case $18M", new content says "base case $28M" — the $18M claim is superseded).
2. Identify ADDITIVE claims — facts in the new content that don't contradict the existing body (e.g. existing covers valuation, new content adds a financing detail not in the old body).
3. Rewrite the body so it reflects the CURRENT state — for each superseded fact, the body now says the new value (the old value is preserved in the supersedes frontmatter, not the body).

Pick a mode:
- "replace": the new content contradicts existing claims; rewrite the body so it reflects the new facts, and record supersedes for the old facts.
- "merge":   some claims are replaced and some are additive; produce a clean rewrite that integrates both.
- "append":  the new content is purely additive (no contradictions); the body keeps existing material and adds the new content as a coherent extension.

<OUTPUT_FORMAT>
Respond with a single JSON object. No prose, no markdown fences.

{
  "mode": "replace" | "merge" | "append",
  "body": "the new wiki page body in markdown, using ## headings, no frontmatter, no H1. Should read as a coherent current-state-of-record page, NOT a change log.",
  "supersedes": [
    {
      "fact": "one-line summary of the OLD claim that is no longer current (e.g. 'Base-case synergy was $18M annual run-rate cost synergies')",
      "source": "URI of the daily where the old claim originated (e.g. 'memory/2026-01-03.md'); when uncertain, use the page's earliest source"
    }
  ]
}

<RULES>
- supersedes entries describe what the page USED to say, not what the new content says
- One supersedes entry per superseded fact (numeric values, dates, names, statuses, decisions)
- mode="append" means an empty supersedes array
- The body should be self-contained — a reader who sees only the body should get the current truth, with no stale claims left behind
- Be conservative: if you're not sure whether a fact is contradicted, treat it as additive
- Quantitative changes (money, percentages, leverage ratios, dates) almost always go in supersedes when revised`;

const ENTITY_RENAME_TEMPLATE = `You are deciding whether two wiki pages describe the same underlying real-world entity that has been renamed (or rebranded), versus two distinct entities that happen to share sources.

<PAGE_A>
slug: {{PAGE_A_SLUG}}
name: {{PAGE_A_NAME}}
description: {{PAGE_A_DESCRIPTION}}
sources:
{{PAGE_A_SOURCES}}
body (first ~20 lines):
{{PAGE_A_BODY_HEAD}}
</PAGE_A>

<PAGE_B>
slug: {{PAGE_B_SLUG}}
name: {{PAGE_B_NAME}}
description: {{PAGE_B_DESCRIPTION}}
sources:
{{PAGE_B_SOURCES}}
body (first ~20 lines):
{{PAGE_B_BODY_HEAD}}
</PAGE_B>

<SIGNAL>
The pages share {{SHARED_SOURCES}} cited source URIs (Jaccard {{JACCARD}}). Their names don't share a dominant proper-noun token, which is why dedup-by-similarity didn't merge them.
</SIGNAL>

<TASK>
Decide whether the two pages describe the SAME real-world entity (a project, person, company, product, team, etc.) that was renamed between the earlier and later sources, OR whether they describe DIFFERENT entities that merely share context.

Output JSON only. No prose, no markdown fences:

{
  "same": true | false,
  "canonical_slug": "the slug of whichever page carries the CURRENT name (typically the page with the LATER most-recent source). Must be exactly PAGE_A_SLUG or PAGE_B_SLUG. null when same=false.",
  "old_name": "the prior name of the entity (taken from the non-canonical page's name). null when same=false.",
  "confidence": "high" | "medium" | "low",
  "reasoning": "one short sentence"
}

<RULES>
- Bias HARD toward false. False positives merge two distinct entities and corrupt the wiki; false negatives just leave two findable pages.
- Set same=true only when at least one source EXPLICITLY signals the rename (e.g. "renamed from X to Y", "rebranded as Y", "X (now Y)"), OR when the body of one page explicitly references the other's name as a prior identity.
- Shared people, shared workstreams, or shared project codes are NOT enough on their own — the SAME ENTITY has to be the subject of both pages.
- When in doubt about which name is canonical, pick the slug whose page has the more-recent most-recent source.`;

/** Stable per-pair key for the rename memo, regardless of arg order. */
function pairKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Pick which of two pages is the canonical (current-name) page. Uses
 * the most-recent ISO date embedded in any source URI; falls back to
 * the page with the later `updated` field, then the alphabetically-
 * first slug when everything else ties.
 */
function pickCanonicalByLatestSource(a: WikiPage, b: WikiPage): string {
    const dateRe = /(\d{4}-\d{2}-\d{2})/;
    const latestOf = (p: WikiPage): string => {
        let best = "";
        for (const s of p.sources) {
            const m = s.uri.match(dateRe);
            if (m && m[1] > best) best = m[1];
        }
        return best;
    };
    const da = latestOf(a);
    const db = latestOf(b);
    if (da !== db) return da > db ? a.slug : b.slug;
    if (a.updated !== b.updated) return a.updated > b.updated ? a.slug : b.slug;
    return a.slug < b.slug ? a.slug : b.slug;
}

// ─── Wisdom distillation ─────────────────────────────────

/**
 * A single line in WISDOM.md. The `id` is a stable kebab-case key the
 * LLM uses for patching; the `content` is the human-readable claim with
 * its embedded `[[slug]]` / `memory/YYYY-MM-DD.md` pointers.
 */
interface WisdomEntry {
    id: string;
    content: string;
}

/**
 * Parse a WISDOM.md file into structured entries. Tolerant: ignores
 * non-matching lines (headers, paragraphs, footer). The entry shape on
 * disk is one line per entry:
 *
 *     - **kebab-id** — One-sentence pattern. See [[slug]].
 */
function parseWisdomEntries(content: string): WisdomEntry[] {
    const out: WisdomEntry[] = [];
    const re = /^\s*-\s+\*\*([a-z0-9][a-z0-9-]{0,80})\*\*\s*[—–-]\s*(.+?)\s*$/i;
    for (const line of content.split("\n")) {
        const m = re.exec(line);
        if (!m) continue;
        out.push({ id: m[1].toLowerCase(), content: m[2] });
    }
    return out;
}

/** Serialize WisdomEntry[] back into the canonical WISDOM.md shape. */
function serializeWisdom(entries: WisdomEntry[]): string {
    const today = new Date().toISOString().slice(0, 10);
    const lines: string[] = [
        "# Wisdom",
        "",
        "Curated patterns and lessons (auto-maintained during dreaming). Each entry points to a wiki slug or daily for grounding. Use `memory_search` or `memory_get` to drill in.",
        "",
        "## Patterns and lessons",
        "",
    ];
    for (const e of entries) {
        lines.push(`- **${e.id}** — ${e.content}`);
    }
    const totalChars = lines.join("\n").length;
    lines.push("");
    lines.push(
        `_Updated ${today} during dreaming · ${entries.length} entries · ${totalChars} chars._`,
    );
    return lines.join("\n") + "\n";
}

/** Extract `[[slug]]` references from a wisdom entry's content. */
function extractSlugLinks(content: string): string[] {
    const out: string[] = [];
    for (const m of content.matchAll(/\[\[([a-z0-9][a-z0-9-]{0,80})\]\]/gi)) {
        out.push(m[1].toLowerCase());
    }
    return out;
}

/**
 * Apply the LLM's patch list to the current entries. Returns the new
 * entry list, or `null` when the patch set is empty / `keep_all` /
 * malformed enough that we shouldn't touch the file.
 *
 * Budget enforcement post-LLM: if the result exceeds `maxEntries`,
 * trim from the tail. If it exceeds `maxChars` after serialization,
 * keep trimming until under budget — the LLM was supposed to leave
 * room; the post-trim is a safety net.
 */
function applyWisdomPatches(
    current: WisdomEntry[],
    patches: unknown[],
    opts: {
        maxEntries: number;
        maxChars: number;
        mru: Array<{ slug: string; hits: number }>;
    },
): WisdomEntry[] | null {
    if (patches.length === 0) return null;
    // Single sentinel: keep_all means do nothing.
    if (
        patches.length === 1 &&
        (patches[0] as Record<string, unknown>)?.op === "keep_all"
    ) {
        return null;
    }
    const byId = new Map(current.map((e) => [e.id, { ...e }]));
    let mutated = false;
    for (const raw of patches) {
        if (!raw || typeof raw !== "object") continue;
        const p = raw as Record<string, unknown>;
        const op = typeof p.op === "string" ? p.op : "";
        const id =
            typeof p.id === "string" ? p.id.toLowerCase().trim() : "";
        const content =
            typeof p.content === "string" ? p.content.trim() : "";
        if (op === "keep_all") continue;
        if (!id) continue;
        if (op === "remove") {
            if (byId.delete(id)) mutated = true;
            continue;
        }
        if (op === "add" || op === "update") {
            if (!content) continue;
            // Validate id shape — kebab-case, ≤ 80 chars.
            if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) continue;
            byId.set(id, { id, content });
            mutated = true;
            continue;
        }
    }
    if (!mutated) return null;

    let result = [...byId.values()];

    // Enforce maxEntries by dropping the entries whose pointer wiki
    // pages have NOT been retrieved recently. The MRU rollup is the
    // ground-truth for "which entries are still earning their slot." If
    // an entry references no slugs (pure principle), keep it last-out.
    if (result.length > opts.maxEntries) {
        const hotness = new Map(opts.mru.map((m) => [m.slug, m.hits]));
        const scored = result.map((e) => {
            const slugs = extractSlugLinks(e.content);
            const maxHits = slugs.length === 0
                ? 0
                : Math.max(...slugs.map((s) => hotness.get(s) ?? 0));
            return { e, score: maxHits };
        });
        scored.sort((a, b) => b.score - a.score);
        result = scored.slice(0, opts.maxEntries).map((x) => x.e);
    }

    // Enforce maxChars by trimming from the tail (lowest priority
    // already at the tail post-MRU sort). Re-serialize to check.
    while (result.length > 1 && serializeWisdom(result).length > opts.maxChars) {
        result.pop();
    }

    return result;
}

const WISDOM_DISTILLATION_TEMPLATE = `You maintain WISDOM.md — a curated, pre-stuffed pointer table that the agent loads on every turn. It must stay compact: up to {{MAX_ENTRIES}} entries and ~{{MAX_CHARS}} chars. Each entry is a one-sentence pattern or lesson with at least one \`[[wiki-slug]]\` or \`memory/YYYY-MM-DD.md\` pointer.

You are reviewing the file at the end of a dreaming session. Decide whether to add, update, remove, or keep-all entries. Bias toward stability: only propose changes when you have real evidence.

<CURRENT_WISDOM>
{{CURRENT_WISDOM}}
</CURRENT_WISDOM>

<MRU_HOT — top wiki pages by retrieval over last {{WINDOW_DAYS}} days>
{{MRU_HOT}}
</MRU_HOT>

<COLD_ENTRIES — wisdom entries pointing at wiki pages with no recent retrieval (removal candidates)>
{{COLD_ENTRIES}}
</COLD_ENTRIES>

<NEW_WIKI_UPDATES — wiki pages touched in THIS dream pass>
{{NEW_WIKI_UPDATES}}
</NEW_WIKI_UPDATES>

<NEW_INSIGHTS — themes the dreaming model surfaced this pass>
{{NEW_INSIGHTS}}
</NEW_INSIGHTS>

<NEW_CONTRADICTIONS — superseded prior claims this pass>
{{NEW_CONTRADICTIONS}}
</NEW_CONTRADICTIONS>

<TASK>
Propose a JSON patch list. Output JSON only:

{
  "patches": [
    {"op": "add",    "id": "kebab-id-here",     "content": "Pattern claim. See [[slug]] or memory/YYYY-MM-DD.md."},
    {"op": "update", "id": "existing-id",       "content": "Revised claim with updated pointers."},
    {"op": "remove", "id": "stale-id"},
    {"op": "keep_all"}
  ],
  "reasoning": "one short sentence on the changes (or why nothing changed)"
}

<RULES>
- Bias toward stability: prefer the single \`{"op": "keep_all"}\` patch when nothing has materially changed. This is the most common outcome.
- Add an entry only when MRU evidence shows a pattern is sustained (≥ a few hits across distinct queries) OR a new wiki update + insight together reveal a recurring lesson.
- Update when an entry's claim has shifted (new contradicting evidence) — keep the same id, replace the content.
- Remove when an entry points only at cold wiki pages that haven't been hit recently and the dream's signals don't reinforce it. Cold ≠ automatic remove; remove when both MRU is cold AND the wisdom claim is no longer load-bearing.
- ids are kebab-case (lowercase a-z, 0-9, hyphens), ≤ 80 chars, descriptive (\`compliance-drives-refactors\`, not \`pattern-1\`).
- Each \`content\` should include at least one \`[[slug]]\` pointer to ground the claim. Optionally cite a daily for the founding event.
- Stay under {{MAX_ENTRIES}} entries total. If you propose adds that would exceed the cap, include enough removes to make room.`;
