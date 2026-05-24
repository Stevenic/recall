/**
 * BenchmarkHarness — orchestrates ingestion, querying, and scoring for a
 * single persona across one or more time-range checkpoints.
 *
 * Ranges are evaluated incrementally: the adapter is set up once, each range
 * (in ascending day order) ingests only the delta of new days since the last
 * checkpoint, calls finalizeIngestion (which adapters must treat as
 * idempotent), runs its query set, and the loop moves on without tearing
 * down. One teardown at the end. This makes N-checkpoint runs O(corpus_days)
 * instead of O(N × corpus_days).
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type {
    BenchmarkResult,
    Category,
    CategoryScore,
    Difficulty,
    DisclosureBreakdown,
    DisclosureStats,
    HarnessConfig,
    HeatmapCell,
    JudgeContext,
    JudgeModel,
    JudgeScore,
    MemorySystemAdapter,
    PersonaResult,
    QAPair,
    QuestionResult,
    RetrievalEntry,
    RunMetadata,
    TimeRange,
    TimeRangeResult,
} from './types.js';
import { CATEGORIES, DEFAULT_RANGES } from './types.js';
import { filterQAByRange, loadPersona, listPersonas } from './dataset.js';
import type { PersonaDataset } from './dataset.js';

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_ARCS_FILE = 'arcs-1000d.yaml';

export class BenchmarkHarness {
    private config: Required<Omit<HarnessConfig, 'modelLabels' | 'sample' | 'judgeMemoryWindow' | 'appellateJudge' | 'failureLogPath' | 'questionLogPath' | 'progressJsonlPath' | 'resumeFromJsonlPath' | 'dryRun'>> & Pick<HarnessConfig, 'modelLabels' | 'sample' | 'judgeMemoryWindow' | 'appellateJudge' | 'failureLogPath' | 'questionLogPath' | 'progressJsonlPath' | 'resumeFromJsonlPath' | 'dryRun'>;
    private static readonly GROUP_GATED_CATEGORIES: ReadonlySet<Category> = new Set([
        'group-session-attribution',
        'information-boundary',
    ]);
    private currentDataset: PersonaDataset | null = null;
    private appellateInvocations = 0;

    constructor(
        private adapter: MemorySystemAdapter,
        private judge: JudgeModel,
        private dataDir: string,
        config: HarnessConfig = {},
    ) {
        this.config = {
            personas: config.personas ?? [],
            ranges: config.ranges ?? [...DEFAULT_RANGES],
            shuffleSeed: config.shuffleSeed ?? 42,
            questionTimeoutMs: config.questionTimeoutMs ?? DEFAULT_TIMEOUT,
            parallelism: config.parallelism ?? 1,
            arcsFile: config.arcsFile ?? DEFAULT_ARCS_FILE,
            sample: config.sample,
            judgeMemoryWindow: config.judgeMemoryWindow,
            groupsEnabled: config.groupsEnabled ?? false,
            appellateJudge: config.appellateJudge,
            failureLogPath: config.failureLogPath,
            questionLogPath: config.questionLogPath,
            dryRun: config.dryRun,
            progressJsonlPath: config.progressJsonlPath,
            resumeFromJsonlPath: config.resumeFromJsonlPath,
            modelLabels: config.modelLabels,
        };
    }

    /**
     * Run the full benchmark and return structured results.
     */
    async run(): Promise<BenchmarkResult> {
        const startTimestamp = new Date();
        const startMs = Date.now();

        const personaIds = this.config.personas.length > 0
            ? this.config.personas
            : await listPersonas(this.dataDir);

        await this.writeProgressHeader(startTimestamp);

        const personaResults: PersonaResult[] = [];

        for (const personaId of personaIds) {
            const dataset = await loadPersona(this.dataDir, personaId, this.config.arcsFile);
            const result = await this.runPersona(dataset);
            personaResults.push(result);
        }

        const heatmap = this.aggregateHeatmap(personaResults);

        const totalEvalsRun = personaResults.reduce((sum, pr) => sum + pr.totalEvalsRun, 0);
        const uniqueQAPairCount = personaResults.reduce((sum, pr) => sum + pr.uniqueQAPairCount, 0);
        const disclosureBreakdown = this.aggregateDisclosure(personaResults);
        const metadata: RunMetadata = {
            durationMs: Date.now() - startMs,
            totalEvalsRun,
            uniqueQAPairCount,
        };
        if (this.config.sample !== undefined && Number.isFinite(this.config.sample)) {
            metadata.sample = this.config.sample;
        }
        if (this.config.judgeMemoryWindow && this.config.judgeMemoryWindow > 0) {
            metadata.judgeMemoryWindow = this.config.judgeMemoryWindow;
        }
        metadata.groupsEnabled = this.config.groupsEnabled;
        const labels = this.config.modelLabels ?? {};
        if (labels.synthesisModel) metadata.synthesisModel = labels.synthesisModel;
        if (labels.embeddingProvider) metadata.embeddingProvider = labels.embeddingProvider;
        if (labels.embeddingModel) metadata.embeddingModel = labels.embeddingModel;
        if (labels.judgeModel) metadata.judgeModel = labels.judgeModel;
        if (labels.appellateJudgeModel) metadata.appellateJudgeModel = labels.appellateJudgeModel;
        if (this.config.appellateJudge) metadata.appellateInvocations = this.appellateInvocations;

        await this.writeProgressSummary(metadata);

        const result: BenchmarkResult = {
            timestamp: startTimestamp.toISOString(),
            adapterName: this.adapter.name,
            ranges: this.config.ranges,
            personas: personaResults,
            heatmap,
            metadata,
        };
        if (disclosureBreakdown) result.disclosureBreakdown = disclosureBreakdown;
        return result;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private async runPersona(dataset: PersonaDataset): Promise<PersonaResult> {
        this.currentDataset = dataset;
        try {
            return await this.runPersonaInner(dataset);
        } finally {
            this.currentDataset = null;
        }
    }

    private async runPersonaInner(dataset: PersonaDataset): Promise<PersonaResult> {
        // Sort ranges ascending so we can ingest deltas in order. De-dupe by
        // label so the same checkpoint isn't evaluated twice.
        const seen = new Set<string>();
        const orderedRanges = [...this.config.ranges]
            .filter((r) => {
                if (seen.has(r.label)) return false;
                seen.add(r.label);
                return true;
            })
            .sort((a, b) => a.days - b.days);

        const rangeResults: TimeRangeResult[] = [];
        let totalIngestionMs = 0;
        let totalQueryMs = 0;
        let lastIngestedDay = 0;

        // Tracks Q&A ids that were "fresh" at some prior checkpoint and are
        // therefore "historical" at this one. A pair is identified as
        // historical purely by eligibility history, not by whether it was
        // evaluated — so sampling never leaks new questions into the
        // historical bucket.
        const previouslyEligible = new Set<string>();

        // If resuming, load cached checkpoint records. Cached ranges skip
        // their eval phase but still need the adapter ingested up to their
        // cutoff (so subsequent uncached ranges see the right corpus state).
        // We do the catch-up ingest once as a bulk pre-pass, then enter the
        // normal loop; cached ranges short-circuit before the eval block.
        const resumeCache = await this.loadResumeCheckpoints();
        let resumeCutoffDay = 0;
        for (const tr of resumeCache.values()) {
            if (tr.daysIngested > resumeCutoffDay) resumeCutoffDay = tr.daysIngested;
        }

        await this.adapter.setup();
        try {
            // Bulk catch-up ingest for the cached range, then seed
            // previouslyEligible from every question eligible by the catch-up
            // cutoff. Without this, the first uncached range would see those
            // prior-checkpoint questions as "new" instead of historical.
            if (resumeCutoffDay > 0) {
                const catchUpStart = Date.now();
                let catchUpCount = 0;
                for (const day of dataset.days) {
                    if (day.dayNumber > lastIngestedDay && day.dayNumber <= resumeCutoffDay) {
                        await this.adapter.ingestDay(day.dayNumber, day.content, day.metadata);
                        catchUpCount++;
                    }
                }
                await this.adapter.finalizeIngestion();
                const catchUpMs = Date.now() - catchUpStart;
                totalIngestionMs += catchUpMs;
                lastIngestedDay = resumeCutoffDay;
                const resumeRange: TimeRange = { label: `resume-${resumeCutoffDay}d`, days: resumeCutoffDay };
                for (const qa of filterQAByRange(dataset.qaPairs, resumeRange)) {
                    previouslyEligible.add(qa.id);
                }
                process.stderr.write(
                    `  [bench] resume: catch-up ingested ${catchUpCount} day(s) in ${(catchUpMs / 1000).toFixed(1)}s; ` +
                        `eval starting at first range after day ${resumeCutoffDay}\n`,
                );
            }

            const totalCheckpoints = orderedRanges.length;
            for (let i = 0; i < orderedRanges.length; i++) {
                const range = orderedRanges[i];
                const cutoff = Math.min(range.days, this.maxDay(dataset));

                // Resume short-circuit: cached range — push its summary into
                // rangeResults, mark its eligible Q&A as previously seen, and
                // skip ingest+eval. Ingest is already covered by the catch-up.
                const cached = resumeCache.get(range.label);
                if (cached) {
                    rangeResults.push(cached);
                    const eligibleAtRange = filterQAByRange(dataset.qaPairs, range);
                    for (const qa of this.applyGroupGate(eligibleAtRange)) previouslyEligible.add(qa.id);
                    const slot = `[${String(i + 1).padStart(2)}/${String(totalCheckpoints).padStart(2)}]`;
                    process.stderr.write(
                        `  [bench] ${slot} ${dataset.personaId} ${range.label.padStart(6)}  (resumed — skipping)\n`,
                    );
                    continue;
                }

                const ingestStart = Date.now();
                let newDaysIngested = 0;
                for (const day of dataset.days) {
                    if (day.dayNumber > lastIngestedDay && day.dayNumber <= cutoff) {
                        await this.adapter.ingestDay(day.dayNumber, day.content, day.metadata);
                        newDaysIngested++;
                    }
                }
                await this.adapter.finalizeIngestion();
                const ingestMs = Date.now() - ingestStart;
                totalIngestionMs += ingestMs;
                lastIngestedDay = Math.max(lastIngestedDay, cutoff);

                const eligibleBeforeGate = filterQAByRange(dataset.qaPairs, range);
                const eligibilityByCategory = new Map<Category, number>();
                for (const qa of eligibleBeforeGate) {
                    eligibilityByCategory.set(
                        qa.category,
                        (eligibilityByCategory.get(qa.category) ?? 0) + 1,
                    );
                }
                const eligibleQA = this.applyGroupGate(eligibleBeforeGate);
                const newPairs: QAPair[] = [];
                const historicalPairs: QAPair[] = [];
                for (const qa of eligibleQA) {
                    if (previouslyEligible.has(qa.id)) historicalPairs.push(qa);
                    else newPairs.push(qa);
                }

                // Sample historical pairs if a budget is set. New questions
                // are always evaluated in full. Sampling is stratified by
                // category so the per-checkpoint pool reflects the available
                // pool's category mix — e.g., if 100 factual-recall and 20
                // negative-recall are eligible, a sample of 60 takes
                // ~50 factual-recall + ~10 negative-recall, not 60 from
                // wherever the shuffle lands first.
                let sampledHistorical = historicalPairs;
                if (
                    this.config.sample !== undefined &&
                    Number.isFinite(this.config.sample) &&
                    this.config.sample >= 0 &&
                    historicalPairs.length > this.config.sample
                ) {
                    sampledHistorical = this.sampleStratifiedByCategory(
                        historicalPairs,
                        this.config.sample,
                    );
                }

                const toEvaluate = this.shuffle([...newPairs, ...sampledHistorical]);

                const queryStart = Date.now();
                const questionResults = await this.evaluateQuestions(toEvaluate);
                const queryMs = Date.now() - queryStart;
                totalQueryMs += queryMs;

                // Mark all of this checkpoint's eligible pairs as previously
                // seen so they count as "historical" at subsequent checkpoints.
                for (const qa of eligibleQA) previouslyEligible.add(qa.id);

                const summary = this.summarizeRange(range, cutoff, questionResults, eligibilityByCategory);
                rangeResults.push(summary);
                this.reportProgress(dataset.personaId, i + 1, totalCheckpoints, summary, {
                    ingestMs,
                    queryMs,
                    newDaysIngested,
                    newQuestionCount: newPairs.length,
                    historicalEvaluated: sampledHistorical.length,
                    historicalAvailable: historicalPairs.length,
                });
                await this.writeProgressCheckpoint(dataset.personaId, i + 1, totalCheckpoints, summary, {
                    ingestMs,
                    queryMs,
                    newDaysIngested,
                    newQuestionCount: newPairs.length,
                    historicalEvaluated: sampledHistorical.length,
                    historicalAvailable: historicalPairs.length,
                });

                // Dry-run mode: bail after the first checkpoint completes.
                // Catches misconfigured profiles, broken adapters, broken
                // prompts, or env issues without paying for the full sweep.
                if (this.config.dryRun) {
                    process.stderr.write(
                        `[bench] --dry-run: stopping after checkpoint 1/${totalCheckpoints}\n`,
                    );
                    break;
                }
            }
        } finally {
            await this.adapter.teardown();
        }

        const heatmap = this.buildHeatmap(rangeResults);

        const totalEvalsRun = rangeResults.reduce((s, rr) => s + rr.questionsEvaluated, 0);
        const disclosureBreakdown = this.buildDisclosureBreakdown(rangeResults);
        const result: PersonaResult = {
            personaId: dataset.personaId,
            adapterName: this.adapter.name,
            rangeResults,
            heatmap,
            totalIngestionMs,
            totalQueryMs,
            uniqueQAPairCount: dataset.qaPairs.length,
            totalEvalsRun,
        };
        if (disclosureBreakdown) result.disclosureBreakdown = disclosureBreakdown;
        return result;
    }

    /**
     * Group information-boundary question results across all ranges by their
     * `expectedDisclosure` value and produce summary stats per group.
     */
    private buildDisclosureBreakdown(
        rangeResults: TimeRangeResult[],
    ): DisclosureBreakdown | undefined {
        const buckets: Record<string, { scores: number[]; halluc: number[]; pairIds: Set<string> }> = {};

        for (const rr of rangeResults) {
            for (const qr of rr.questionResults) {
                if (qr.qa.category !== 'information-boundary') continue;
                const disclosure = qr.qa.expectedDisclosure;
                if (!disclosure) continue;
                if (!buckets[disclosure]) {
                    buckets[disclosure] = { scores: [], halluc: [], pairIds: new Set() };
                }
                buckets[disclosure].scores.push(qr.compositeScore);
                buckets[disclosure].halluc.push(qr.score.hallucination);
                buckets[disclosure].pairIds.add(qr.qa.id);
            }
        }

        if (Object.keys(buckets).length === 0) return undefined;

        const out: DisclosureBreakdown = {};
        for (const key of ['refuse', 'partial', 'answer'] as const) {
            const b = buckets[key];
            if (!b || b.scores.length === 0) continue;
            const mean = b.scores.reduce((a, c) => a + c, 0) / b.scores.length;
            const hallucinatedCount = b.halluc.filter(v => v === 0).length;
            const stats: DisclosureStats = {
                evaluations: b.scores.length,
                uniquePairs: b.pairIds.size,
                meanScore: mean,
                hallucinationRate: (hallucinatedCount / b.halluc.length) * 100,
            };
            out[key] = stats;
        }
        return Object.keys(out).length > 0 ? out : undefined;
    }

    /**
     * Aggregate per-persona disclosure breakdowns into a single run-level view.
     * Means are weighted by evaluation count.
     */
    private aggregateDisclosure(personaResults: PersonaResult[]): DisclosureBreakdown | undefined {
        const buckets: Record<string, { weighted: number; n: number; pairs: number; halluc: number }> = {};
        for (const pr of personaResults) {
            const db = pr.disclosureBreakdown;
            if (!db) continue;
            for (const key of ['refuse', 'partial', 'answer'] as const) {
                const s = db[key];
                if (!s) continue;
                if (!buckets[key]) buckets[key] = { weighted: 0, n: 0, pairs: 0, halluc: 0 };
                buckets[key].weighted += s.meanScore * s.evaluations;
                buckets[key].n += s.evaluations;
                buckets[key].pairs += s.uniquePairs;
                buckets[key].halluc += (s.hallucinationRate / 100) * s.evaluations;
            }
        }
        if (Object.keys(buckets).length === 0) return undefined;
        const out: DisclosureBreakdown = {};
        for (const key of ['refuse', 'partial', 'answer'] as const) {
            const b = buckets[key];
            if (!b || b.n === 0) continue;
            out[key] = {
                evaluations: b.n,
                uniquePairs: b.pairs,
                meanScore: b.weighted / b.n,
                hallucinationRate: (b.halluc / b.n) * 100,
            };
        }
        return Object.keys(out).length > 0 ? out : undefined;
    }

    /**
     * Emit one line per completed checkpoint on stderr so the operator can
     * see the bench making progress through a long run. Goes to stderr so
     * that stdout (the final report) stays uncluttered for piping.
     */
    private reportProgress(
        personaId: string,
        index: number,
        total: number,
        rr: TimeRangeResult,
        timing: {
            ingestMs: number;
            queryMs: number;
            newDaysIngested: number;
            newQuestionCount: number;
            historicalEvaluated: number;
            historicalAvailable: number;
        },
    ): void {
        const pct = rr.questionsEvaluated > 0
            ? ((rr.overallScore / 6) * 100).toFixed(1) + '%'
            : '   --   ';
        const ingestSec = (timing.ingestMs / 1000).toFixed(1);
        const querySec = (timing.queryMs / 1000).toFixed(1);
        const slot = `[${String(index).padStart(2)}/${String(total).padStart(2)}]`;
        const tag = `${personaId} ${rr.range.label.padStart(6)}`;
        const qBreakdown = `q=${rr.questionsEvaluated} (new=${timing.newQuestionCount} hist=${timing.historicalEvaluated}/${timing.historicalAvailable})`;
        const stats = `+${String(timing.newDaysIngested).padStart(3)}d ingest=${ingestSec.padStart(5)}s · ${qBreakdown} query=${querySec.padStart(5)}s · score=${pct}`;
        process.stderr.write(`  [bench] ${slot} ${tag}  ${stats}\n`);
    }

    private maxDay(dataset: PersonaDataset): number {
        let max = 0;
        for (const d of dataset.days) {
            if (d.dayNumber > max) max = d.dayNumber;
        }
        return max;
    }

    private summarizeRange(
        range: TimeRange,
        daysIngested: number,
        questionResults: QuestionResult[],
        eligibilityByCategory?: Map<Category, number>,
    ): TimeRangeResult {
        const scores = questionResults.map(r => r.compositeScore);
        const overallScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
        return {
            range,
            daysIngested,
            questionsEvaluated: questionResults.length,
            overallScore,
            categoryScores: this.aggregateByCategory(questionResults, eligibilityByCategory),
            difficultyScores: this.aggregateByDifficulty(questionResults),
            hallucinationRate: this.computeHallucinationRate(questionResults),
            questionResults,
        };
    }

    private async evaluateQuestions(qaPairs: QAPair[]): Promise<QuestionResult[]> {
        const results: QuestionResult[] = [];
        const chunks = this.chunkArray(qaPairs, this.config.parallelism);
        for (const chunk of chunks) {
            const chunkResults = await Promise.all(chunk.map(qa => this.evaluateOne(qa)));
            results.push(...chunkResults);
        }
        return results;
    }

    private async evaluateOne(qa: QAPair): Promise<QuestionResult> {
        const start = Date.now();

        let systemAnswer: string;
        let retrieval: RetrievalEntry[] | undefined;
        let toolCalls: import('./types.js').ToolCallTraceEntry[] | undefined;
        try {
            // Prefer queryDetail when the adapter provides it — surfaces the
            // retrieval result alongside the answer so we can log it on failure.
            const queried = await Promise.race([
                this.runQuery(qa.question),
                this.timeout(this.config.questionTimeoutMs),
            ]);
            systemAnswer = queried.answer;
            retrieval = queried.retrieval;
            toolCalls = queried.toolCalls;
        } catch {
            systemAnswer = '[TIMEOUT]';
        }

        const latencyMs = Date.now() - start;
        const context = this.buildJudgeContext(qa);

        const primaryScore = await this.judge.score(qa.question, qa.answer, systemAnswer, context);
        let finalScore = primaryScore;
        let usedAppellate = false;
        if (this.config.appellateJudge && this.isFailure(primaryScore)) {
            try {
                const appellateScore = await this.config.appellateJudge.score(
                    qa.question,
                    qa.answer,
                    systemAnswer,
                    context,
                );
                finalScore = appellateScore;
                usedAppellate = true;
                this.appellateInvocations++;
            } catch {
                // If the appellate judge fails, fall back to primary verdict
                // rather than dropping the eval. Recorded as no appellate use.
            }
        }

        const compositeScore = finalScore.correctness + finalScore.completeness + finalScore.hallucination;
        const result: QuestionResult = { qa, systemAnswer, score: finalScore, compositeScore, latencyMs };
        if (usedAppellate) result.primaryScore = primaryScore;

        // Write failure log entry when appellate ran (i.e., something was
        // flagged) — captures retrieval + both verdicts for offline analysis.
        if (usedAppellate && this.config.failureLogPath) {
            await this.logFailure({
                qa,
                systemAnswer,
                primaryScore,
                appellateScore: finalScore,
                retrieval,
                judgeContext: context,
                latencyMs,
            });
        }

        // Per-question log: one record per evaluated question, regardless
        // of score. Lets operators inspect any non-perfect answer mid-run.
        // Cheaper than lowering the appellate threshold (no extra LLM call).
        if (this.config.questionLogPath) {
            await this.logQuestion({
                qa,
                systemAnswer,
                primaryScore,
                finalScore,
                usedAppellate,
                compositeScore,
                retrieval,
                toolCalls,
                judgeContext: context,
                latencyMs,
            });
        }

        return result;
    }

    private async runQuery(question: string): Promise<{
        answer: string;
        retrieval?: RetrievalEntry[];
        toolCalls?: import('./types.js').ToolCallTraceEntry[];
    }> {
        if (this.adapter.queryDetail) {
            const detail = await this.adapter.queryDetail(question);
            const out: {
                answer: string;
                retrieval?: RetrievalEntry[];
                toolCalls?: import('./types.js').ToolCallTraceEntry[];
            } = { answer: detail.answer };
            if (detail.retrieval) out.retrieval = detail.retrieval;
            if (detail.toolCalls) out.toolCalls = detail.toolCalls;
            return out;
        }
        const answer = await this.adapter.query(question);
        return { answer };
    }

    /**
     * Failure predicate for the supreme-court appellate flow. A judgment is
     * considered a failure (and routed to the appellate judge) when any of:
     *   - composite score < 4/6 (i.e., substantially wrong/incomplete)
     *   - hallucination = 0 (judge flagged invented content)
     *   - correctness = 0 (judge declared the answer wrong)
     */
    private isFailure(score: JudgeScore): boolean {
        const composite = score.correctness + score.completeness + score.hallucination;
        return composite < 4 || score.hallucination === 0 || score.correctness === 0;
    }

    private async writeProgressHeader(startTimestamp: Date): Promise<void> {
        const path = this.config.progressJsonlPath;
        if (!path) return;
        const labels = this.config.modelLabels ?? {};
        const record = {
            type: 'header',
            timestamp: startTimestamp.toISOString(),
            adapterName: this.adapter.name,
            ranges: this.config.ranges,
            sample: this.config.sample,
            judgeMemoryWindow: this.config.judgeMemoryWindow,
            groupsEnabled: this.config.groupsEnabled,
            synthesisModel: labels.synthesisModel,
            embeddingProvider: labels.embeddingProvider,
            embeddingModel: labels.embeddingModel,
            judgeModel: labels.judgeModel,
            appellateJudgeModel: labels.appellateJudgeModel,
        };
        await this.appendProgressLine(record);
    }

    private async writeProgressCheckpoint(
        personaId: string,
        index: number,
        total: number,
        rr: TimeRangeResult,
        timing: {
            ingestMs: number;
            queryMs: number;
            newDaysIngested: number;
            newQuestionCount: number;
            historicalEvaluated: number;
            historicalAvailable: number;
        },
    ): Promise<void> {
        const path = this.config.progressJsonlPath;
        if (!path) return;
        const record = {
            type: 'checkpoint',
            timestamp: new Date().toISOString(),
            personaId,
            checkpointIndex: index,
            totalCheckpoints: total,
            range: rr.range,
            daysIngested: rr.daysIngested,
            questionsEvaluated: rr.questionsEvaluated,
            overallScore: rr.overallScore,
            hallucinationRate: rr.hallucinationRate,
            categoryScores: rr.categoryScores.map((c) => ({
                category: c.category,
                meanScore: c.meanScore,
                questionCount: c.questionCount,
                eligibleCount: c.eligibleCount,
            })),
            difficultyScores: rr.difficultyScores,
            ingestMs: timing.ingestMs,
            queryMs: timing.queryMs,
            newDaysIngested: timing.newDaysIngested,
            newQuestionCount: timing.newQuestionCount,
            historicalEvaluated: timing.historicalEvaluated,
            historicalAvailable: timing.historicalAvailable,
        };
        await this.appendProgressLine(record);
    }

    private async writeProgressSummary(metadata: RunMetadata): Promise<void> {
        const path = this.config.progressJsonlPath;
        if (!path) return;
        const record = {
            type: 'summary',
            timestamp: new Date().toISOString(),
            durationMs: metadata.durationMs,
            totalEvalsRun: metadata.totalEvalsRun,
            uniqueQAPairCount: metadata.uniqueQAPairCount,
            appellateInvocations: metadata.appellateInvocations,
        };
        await this.appendProgressLine(record);
    }

    private async appendProgressLine(record: Record<string, unknown>): Promise<void> {
        const path = this.config.progressJsonlPath;
        if (!path) return;
        try {
            await mkdir(dirname(path), { recursive: true });
            await appendFile(path, JSON.stringify(record) + '\n', 'utf-8');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[bench] progress-log write failed: ${msg}\n`);
        }
    }

    private async logQuestion(entry: {
        qa: QAPair;
        systemAnswer: string;
        primaryScore: JudgeScore;
        finalScore: JudgeScore;
        usedAppellate: boolean;
        compositeScore: number;
        retrieval?: RetrievalEntry[];
        toolCalls?: import('./types.js').ToolCallTraceEntry[];
        judgeContext?: JudgeContext;
        latencyMs: number;
    }): Promise<void> {
        const path = this.config.questionLogPath;
        if (!path) return;
        const record: Record<string, unknown> = {
            timestamp: new Date().toISOString(),
            personaId: this.currentDataset?.personaId,
            qa: {
                id: entry.qa.id,
                question: entry.qa.question,
                referenceAnswer: entry.qa.answer,
                category: entry.qa.category,
                difficulty: entry.qa.difficulty,
                relevantDays: entry.qa.relevantDays,
                expectedDisclosure: entry.qa.expectedDisclosure,
                querySession: entry.qa.querySession,
                forbiddenSessions: entry.qa.forbiddenSessions,
            },
            systemAnswer: entry.systemAnswer,
            score: entry.finalScore,
            composite: entry.compositeScore,
            usedAppellate: entry.usedAppellate,
            retrieval: entry.retrieval,
            memoryContextProvided: !!entry.judgeContext?.memoryExcerpts,
            latencyMs: entry.latencyMs,
        };
        if (entry.toolCalls && entry.toolCalls.length > 0) {
            record.toolCalls = entry.toolCalls;
        }
        if (entry.usedAppellate) {
            record.primaryScore = entry.primaryScore;
        }
        try {
            await mkdir(dirname(path), { recursive: true });
            await appendFile(path, JSON.stringify(record) + '\n', 'utf-8');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[bench] question-log write failed: ${msg}\n`);
        }
    }

    private async logFailure(entry: {
        qa: QAPair;
        systemAnswer: string;
        primaryScore: JudgeScore;
        appellateScore: JudgeScore;
        retrieval?: RetrievalEntry[];
        judgeContext?: JudgeContext;
        latencyMs: number;
    }): Promise<void> {
        const path = this.config.failureLogPath;
        if (!path) return;
        const record = {
            timestamp: new Date().toISOString(),
            personaId: this.currentDataset?.personaId,
            qa: {
                id: entry.qa.id,
                question: entry.qa.question,
                referenceAnswer: entry.qa.answer,
                category: entry.qa.category,
                difficulty: entry.qa.difficulty,
                relevantDays: entry.qa.relevantDays,
                expectedDisclosure: entry.qa.expectedDisclosure,
                querySession: entry.qa.querySession,
                forbiddenSessions: entry.qa.forbiddenSessions,
            },
            systemAnswer: entry.systemAnswer,
            primaryScore: entry.primaryScore,
            appellateScore: entry.appellateScore,
            retrieval: entry.retrieval,
            memoryContextProvided: !!entry.judgeContext?.memoryExcerpts,
            latencyMs: entry.latencyMs,
        };
        try {
            await mkdir(dirname(path), { recursive: true });
            await appendFile(path, JSON.stringify(record) + '\n', 'utf-8');
        } catch (err) {
            // Don't let logging failures crash the bench
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[bench] failure-log write failed: ${msg}\n`);
        }
    }

    /**
     * Filter out Q&A pairs in categories that require group-aware memory
     * support when `groupsEnabled` is false. Today no known memory system
     * supports per-session ACLs, so these categories produce 0% scores by
     * default and just add noise to the heatmap.
     */
    private applyGroupGate(pairs: QAPair[]): QAPair[] {
        if (this.config.groupsEnabled) return pairs;
        return pairs.filter((qa) => !BenchmarkHarness.GROUP_GATED_CATEGORIES.has(qa.category));
    }

    /**
     * Assemble the JudgeContext for `qa`:
     *   - `memoryExcerpts` when `judgeMemoryWindow > 0` — gives the judge
     *     the actual source memories for grounding-aware scoring.
     *   - For `information-boundary` Q&A pairs (and only when groupsEnabled
     *     is on, since otherwise these are gated out before this point):
     *     also pass `expectedDisclosure`, `querySession`, and
     *     `forbiddenSessions` so the judge can score refusal/partial/answer
     *     behavior instead of comparing the system answer to a literal
     *     reference that contains the forbidden content.
     */
    private buildJudgeContext(qa: QAPair): JudgeContext | undefined {
        const memoryExcerpts = this.buildMemoryExcerpts(qa);
        const isBoundary = qa.category === 'information-boundary' && !!qa.expectedDisclosure;

        if (!memoryExcerpts && !isBoundary) return undefined;

        const context: JudgeContext = {};
        if (memoryExcerpts) context.memoryExcerpts = memoryExcerpts;
        if (isBoundary) {
            context.expectedDisclosure = qa.expectedDisclosure;
            if (qa.querySession) context.querySession = qa.querySession;
            if (qa.forbiddenSessions) context.forbiddenSessions = qa.forbiddenSessions;
        }
        return context;
    }

    private buildMemoryExcerpts(qa: QAPair): string | undefined {
        const window = this.config.judgeMemoryWindow;
        if (!window || window <= 0) return undefined;
        if (!qa.relevantDays || qa.relevantDays.length === 0) return undefined;
        const dataset = this.currentDataset;
        if (!dataset) return undefined;

        const dayLookup = new Map<number, typeof dataset.days[number]>();
        for (const d of dataset.days) dayLookup.set(d.dayNumber, d);

        const toInclude = new Set<number>();
        for (const d of qa.relevantDays) {
            for (let i = d - window; i <= d + window; i++) {
                if (dayLookup.has(i)) toInclude.add(i);
            }
        }
        if (toInclude.size === 0) return undefined;
        const sorted = [...toInclude].sort((a, b) => a - b);
        const parts: string[] = [];
        for (const dayNum of sorted) {
            const day = dayLookup.get(dayNum);
            if (!day) continue;
            parts.push(`--- DAY ${dayNum} (${day.metadata.date}) ---\n${day.content.trim()}`);
        }
        return parts.join('\n\n');
    }

    private aggregateByCategory(
        results: QuestionResult[],
        eligibilityByCategory?: Map<Category, number>,
    ): CategoryScore[] {
        return CATEGORIES.map(cat => {
            const matching = results.filter(r => r.qa.category === cat);
            const scores = matching.map(r => r.compositeScore);
            const out: CategoryScore = {
                category: cat,
                meanScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
                questionCount: scores.length,
                scores,
            };
            if (eligibilityByCategory) {
                out.eligibleCount = eligibilityByCategory.get(cat) ?? 0;
            }
            return out;
        });
    }

    private aggregateByDifficulty(results: QuestionResult[]): Record<Difficulty, { mean: number; count: number }> {
        const out: Record<Difficulty, { mean: number; count: number }> = {
            easy: { mean: 0, count: 0 },
            medium: { mean: 0, count: 0 },
            hard: { mean: 0, count: 0 },
        };
        for (const diff of ['easy', 'medium', 'hard'] as Difficulty[]) {
            const matching = results.filter(r => r.qa.difficulty === diff);
            const scores = matching.map(r => r.compositeScore);
            out[diff] = {
                mean: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
                count: scores.length,
            };
        }
        return out;
    }

    private computeHallucinationRate(results: QuestionResult[]): number {
        if (results.length === 0) return 0;
        const hallucinated = results.filter(r => r.score.hallucination === 0).length;
        return (hallucinated / results.length) * 100;
    }

    private buildHeatmap(rangeResults: TimeRangeResult[]): HeatmapCell[] {
        const cells: HeatmapCell[] = [];
        for (const rr of rangeResults) {
            for (const cs of rr.categoryScores) {
                const cell: HeatmapCell = {
                    range: rr.range.label,
                    category: cs.category,
                    score: cs.meanScore,
                    questionCount: cs.questionCount,
                };
                if (cs.eligibleCount !== undefined) cell.eligibleCount = cs.eligibleCount;
                cells.push(cell);
            }
        }
        return cells;
    }

    private aggregateHeatmap(personaResults: PersonaResult[]): HeatmapCell[] {
        const map = new Map<string, { total: number; count: number; questions: number; eligible: number | undefined }>();

        for (const pr of personaResults) {
            for (const cell of pr.heatmap) {
                const key = `${cell.range}::${cell.category}`;
                const existing = map.get(key) ?? { total: 0, count: 0, questions: 0, eligible: undefined };
                existing.total += cell.score * cell.questionCount;
                existing.count += cell.questionCount;
                existing.questions += cell.questionCount;
                if (cell.eligibleCount !== undefined) {
                    existing.eligible = (existing.eligible ?? 0) + cell.eligibleCount;
                }
                map.set(key, existing);
            }
        }

        const cells: HeatmapCell[] = [];
        for (const [key, val] of map) {
            const [range, category] = key.split('::') as [string, Category];
            const cell: HeatmapCell = {
                range,
                category,
                score: val.count > 0 ? val.total / val.count : 0,
                questionCount: val.questions,
            };
            if (val.eligible !== undefined) cell.eligibleCount = val.eligible;
            cells.push(cell);
        }
        return cells;
    }

    // -----------------------------------------------------------------------
    // Utilities
    // -----------------------------------------------------------------------

    /**
     * Sample `sampleSize` items from `pairs` with the count drawn from each
     * category proportional to that category's representation in the input.
     *
     * Uses the largest-remainder method (Hare quota) so the per-category
     * targets sum to exactly `sampleSize`. Within each category the picks are
     * deterministic via the existing seeded shuffle.
     *
     * Edge cases:
     *   - `sampleSize >= pairs.length`: returns a shuffled copy of `pairs`.
     *   - `sampleSize === 0`: returns an empty array.
     *   - Single-category pool: degrades to plain shuffled head-of-list.
     */
    private sampleStratifiedByCategory(pairs: QAPair[], sampleSize: number): QAPair[] {
        if (sampleSize <= 0) return [];
        if (sampleSize >= pairs.length) return this.shuffle(pairs);

        // Group by category, preserving insertion order for determinism.
        const byCategory = new Map<Category, QAPair[]>();
        for (const p of pairs) {
            const bucket = byCategory.get(p.category);
            if (bucket) bucket.push(p);
            else byCategory.set(p.category, [p]);
        }

        // Compute per-category quota: target = sampleSize * (bucket / total).
        // Floor as integer base, track fractional remainder per category, then
        // distribute leftover seats by largest-remainder so the sum lands on
        // sampleSize exactly. Ties broken by larger bucket first, then by
        // category insertion order — all deterministic, no RNG needed here.
        const total = pairs.length;
        const allocations: { category: Category; bucketSize: number; base: number; remainder: number }[] = [];
        let sumBase = 0;
        for (const [category, bucket] of byCategory) {
            const raw = (bucket.length / total) * sampleSize;
            const base = Math.floor(raw);
            const remainder = raw - base;
            allocations.push({ category, bucketSize: bucket.length, base, remainder });
            sumBase += base;
        }
        let leftover = sampleSize - sumBase;

        // Sort a copy of allocations by remainder desc, then bucketSize desc,
        // then by category position to break ties stably. Hand out leftover
        // seats from the top until exhausted, but never exceed bucketSize.
        const categoryOrder = [...byCategory.keys()];
        const sorted = [...allocations].sort((a, b) => {
            if (b.remainder !== a.remainder) return b.remainder - a.remainder;
            if (b.bucketSize !== a.bucketSize) return b.bucketSize - a.bucketSize;
            return categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
        });
        for (const alloc of sorted) {
            if (leftover <= 0) break;
            if (alloc.base < alloc.bucketSize) {
                alloc.base += 1;
                leftover -= 1;
            }
        }
        // If categories were already saturated, distribute any remaining
        // leftover seats by overflowing into the largest non-saturated bucket.
        // This only fires when a category's proportional allocation exceeded
        // its bucket size (rare; happens when one category dominates and the
        // quota rounds up past it).
        while (leftover > 0) {
            const target = allocations
                .filter((a) => a.base < a.bucketSize)
                .sort((a, b) => b.bucketSize - a.bucketSize)[0];
            if (!target) break; // pool exhausted (shouldn't happen given sample < total guard)
            target.base += 1;
            leftover -= 1;
        }

        // Sample the allocated count from each category. shuffle() respects
        // shuffleSeed, so the entire stratification is reproducible.
        const out: QAPair[] = [];
        for (const alloc of allocations) {
            const bucket = byCategory.get(alloc.category)!;
            const shuffled = this.shuffle(bucket);
            for (let i = 0; i < alloc.base; i++) out.push(shuffled[i]);
        }
        return out;
    }

    /**
     * Read a prior run's progress JSONL and return its cached `checkpoint`
     * records keyed by range label. Records are converted into partial
     * TimeRangeResults that carry the aggregated scores; per-question results
     * are left empty (the JSONL doesn't include them).
     *
     * Returns an empty map if the file doesn't exist, the path is unset, or
     * the file has no parseable checkpoint records. Malformed lines are
     * skipped with a warning rather than aborting the run.
     */
    private async loadResumeCheckpoints(): Promise<Map<string, TimeRangeResult>> {
        const out = new Map<string, TimeRangeResult>();
        const path = this.config.resumeFromJsonlPath;
        if (!path) return out;
        if (!existsSync(path)) {
            process.stderr.write(`  [bench] resume: file not found, starting fresh: ${path}\n`);
            return out;
        }
        let raw: string;
        try {
            raw = await readFile(path, 'utf-8');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`  [bench] resume: read failed (${msg}); starting fresh\n`);
            return out;
        }
        const lines = raw.split(/\r?\n/);
        let parsed = 0;
        for (const line of lines) {
            if (!line.trim()) continue;
            let rec: Record<string, unknown>;
            try {
                rec = JSON.parse(line);
            } catch {
                continue; // skip malformed lines
            }
            if (rec.type !== 'checkpoint') continue;
            const range = rec.range as TimeRange | undefined;
            if (!range || typeof range.label !== 'string') continue;
            const catScores = Array.isArray(rec.categoryScores) ? rec.categoryScores : [];
            const tr: TimeRangeResult = {
                range,
                daysIngested: typeof rec.daysIngested === 'number' ? rec.daysIngested : range.days,
                questionsEvaluated: typeof rec.questionsEvaluated === 'number' ? rec.questionsEvaluated : 0,
                overallScore: typeof rec.overallScore === 'number' ? rec.overallScore : 0,
                hallucinationRate: typeof rec.hallucinationRate === 'number' ? rec.hallucinationRate : 0,
                categoryScores: catScores.map((c: Record<string, unknown>) => ({
                    category: c.category as Category,
                    meanScore: typeof c.meanScore === 'number' ? c.meanScore : 0,
                    questionCount: typeof c.questionCount === 'number' ? c.questionCount : 0,
                    eligibleCount: typeof c.eligibleCount === 'number' ? c.eligibleCount : 0,
                    // Raw per-question scores aren't in the JSONL; downstream
                    // aggregations use meanScore + questionCount instead.
                    scores: [],
                })),
                difficultyScores: this.normalizeDifficultyScoresFromJsonl(rec.difficultyScores),
                questionResults: [], // not restorable from JSONL — prior failure log retains them
            };
            out.set(range.label, tr);
            parsed++;
        }
        if (parsed > 0) {
            process.stderr.write(`  [bench] resume: loaded ${parsed} cached checkpoint(s) from ${path}\n`);
        }
        return out;
    }

    /**
     * Coerce a JSONL `difficultyScores` field back into the strict
     * Record<Difficulty, {mean, count}> shape the harness uses internally.
     * Missing keys are filled with zeros so downstream code never sees
     * undefined entries.
     */
    private normalizeDifficultyScoresFromJsonl(
        raw: unknown,
    ): Record<Difficulty, { mean: number; count: number }> {
        const zero = { mean: 0, count: 0 };
        const out: Record<Difficulty, { mean: number; count: number }> = {
            easy: { ...zero },
            medium: { ...zero },
            hard: { ...zero },
        };
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const rec = raw as Record<string, unknown>;
            for (const key of ['easy', 'medium', 'hard'] as Difficulty[]) {
                const v = rec[key];
                if (v && typeof v === 'object') {
                    const o = v as { mean?: unknown; count?: unknown };
                    out[key] = {
                        mean: typeof o.mean === 'number' ? o.mean : 0,
                        count: typeof o.count === 'number' ? o.count : 0,
                    };
                }
            }
        }
        return out;
    }

    /** Seeded Fisher-Yates shuffle for reproducible question ordering. */
    private shuffle<T>(arr: T[]): T[] {
        const copy = [...arr];
        let seed = this.config.shuffleSeed;
        if (seed === 0) return copy;

        const rand = () => {
            seed |= 0;
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };

        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    }

    private chunkArray<T>(arr: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < arr.length; i += size) {
            chunks.push(arr.slice(i, i + size));
        }
        return chunks;
    }

    private timeout(ms: number): Promise<never> {
        return new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Query timed out after ${ms}ms`)), ms),
        );
    }
}
