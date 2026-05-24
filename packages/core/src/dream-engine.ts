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
    DEFAULT_MAX_CANDIDATES,
    DEFAULT_SIGNAL_WINDOW_DAYS,
    DEFAULT_STALENESS_THRESHOLD_DAYS,
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
        const results: AnalysisResult[] = [];
        const templates = this._getTemplates();

        for (const candidate of candidates) {
            try {
                const result = await this._analyzeCandidate(candidate, templates);
                results.push(result);
            } catch {
                // Skip candidates that fail analysis
                results.push({
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
            }
        }

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
        };
    }

    /**
     * Apply a single wiki op against the bound WikiEngine. Errors are caught
     * and surfaced in the returned `DreamWikiUpdate` so a malformed model
     * response can't fail the whole session.
     */
    private async _applyWikiOp(op: DreamWikiOp): Promise<DreamWikiUpdate> {
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
                    return {
                        op: op.op,
                        slug: op.slug,
                        ok: true,
                        detail: `create-on-existing → appended (${updated.sources.length} sources)`,
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
                            sources: op.sources,
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
                return {
                    op: op.op,
                    slug: op.slug,
                    ok: true,
                    detail: `created (${op.sources.length} source${op.sources.length === 1 ? "" : "s"})`,
                };
            }
            if (op.op === "update") {
                await this._wiki.append(
                    op.slug,
                    op.source,
                    op.appendBody,
                    "private",
                );
                return {
                    op: op.op,
                    slug: op.slug,
                    ok: true,
                    detail: `appended ${op.source}`,
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
        return {
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
            related: Array.isArray(r.related)
                ? (r.related as string[]).filter(
                      (s) => typeof s === "string" && SLUG_RE.test(s),
                  )
                : undefined,
            confidence:
                r.confidence === "high" ||
                r.confidence === "medium" ||
                r.confidence === "low"
                    ? r.confidence
                    : undefined,
        };
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
        return { op: "update", slug, appendBody, source };
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

const CONTRADICTION_TEMPLATE = `You are an analytical memory engine detecting contradictions between stated principles and observed behavior, and detecting wisdom entries that have drifted toward topical (per spec §12.4).

<TASK>
Compare the WISDOM.md entries against the provided recent memories. For each wisdom entry, choose exactly one outcome:

1. UPDATE — the principle is right but needs sharper wording given new evidence. → emit a "contradictions" entry with the recommendation.
2. CONTRADICT — the principle is no longer accurate; newer evidence overrides it. → emit a "contradictions" entry recommending removal or rewrite.
3. PROMOTE_TO_WIKI — the entry is topical (about a specific person, project, system, or recurring theme) rather than a cross-topic principle. → emit a "wiki_ops" create op that captures the topical knowledge as a wiki page. WISDOM.md should retain only the underlying principle (if any).

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
      "op": "create",
      "slug": "kebab-case-slug",
      "category": "entity" | "concept" | "project" | "reference" | "theme",
      "name": "Human-readable title",
      "description": "One-line description",
      "body": "Markdown body. Concept/project pages SHOULD lead with a rule/fact followed by **Why:** and **How to apply:**.",
      "sources": ["memory/YYYY-MM-DD.md", ...]
    }
  ]
}

<RULES>
- Only flag genuine contradictions with clear evidence
- Evolution is not contradiction — if a principle was refined, recommend an update (outcome 1)
- Promote to wiki when the entry describes a *thing* rather than a *rule*:
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
