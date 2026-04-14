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
import type {
    DreamingConfig,
    DreamCandidate,
    DreamOptions,
    DreamResult,
    DreamStatus,
    AnalysisResult,
    AnalysisTemplates,
} from "./dreaming-config.js";
import {
    DEFAULT_MAX_CANDIDATES,
    DEFAULT_SIGNAL_WINDOW_DAYS,
    DEFAULT_STALENESS_THRESHOLD_DAYS,
} from "./dreaming-config.js";

export class DreamEngine {
    private readonly _files: MemoryFiles;
    private readonly _index: MemoryIndex;
    private readonly _model: MemoryModel;
    private readonly _storage: FileStorage;
    private readonly _logger: SearchLogger;
    private readonly _config: DreamingConfig;

    constructor(
        files: MemoryFiles,
        index: MemoryIndex,
        model: MemoryModel,
        storage: FileStorage,
        logger: SearchLogger,
        config?: DreamingConfig,
    ) {
        this._files = files;
        this._index = index;
        this._model = model;
        this._storage = storage;
        this._logger = logger;
        this._config = config ?? {};
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
            result = await this.writeResults(analysisResults, toAnalyze.length);
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
    ): Promise<DreamResult> {
        const result = aggregateResults(analysisResults, totalCandidates);
        const today = new Date().toISOString().split("T")[0];

        // Ensure output directories exist
        await this._ensureOutputDirs();

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

// ─── Analysis Prompt Templates ───────────────────────────

const CROSS_REFERENCE_TEMPLATE = `You are an analytical memory engine examining cross-cutting patterns across agent memories.

<TASK>
Examine the provided memories and identify:
1. Patterns that span multiple time periods
2. Evolution of decisions, approaches, or understanding over time
3. Recurring themes or entities that suggest deeper connections
4. Decisions or facts that should be extracted as typed memories

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
  "promotions": [
    {
      "filename": "type_topic.md",
      "content": "---\\nname: ...\\ndescription: ...\\ntype: feedback|project|user|reference\\n---\\n\\nBody..."
    }
  ],
  "contradictions": [],
  "gaps": []
}

<RULES>
- Only report insights with clear evidence in the provided text
- Confidence: high = 3+ supporting memories, medium = 2, low = 1 with strong signal
- Promotions must follow the typed memory format with frontmatter
- Do not fabricate connections — report what is actually present`;

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

const CONTRADICTION_TEMPLATE = `You are an analytical memory engine detecting contradictions between stated principles and observed behavior.

<TASK>
Compare the WISDOM.md entries against the provided recent memories. For each wisdom entry:
1. Does recent behavior support this principle?
2. Does recent behavior contradict it?
3. Has the principle evolved in ways not reflected in WISDOM.md?

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
  "gaps": []
}

<RULES>
- Only flag genuine contradictions with clear evidence
- Evolution is not contradiction — if a principle was refined, recommend an update, not a removal
- Be specific about which memories contain the contradicting evidence`;

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
