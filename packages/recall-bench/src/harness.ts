/**
 * BenchmarkHarness — orchestrates ingestion, querying, and scoring for a
 * single persona across one or more time-range slices.
 */

import type {
    BenchmarkResult,
    Category,
    CategoryScore,
    Difficulty,
    HarnessConfig,
    HeatmapCell,
    JudgeModel,
    MemorySystemAdapter,
    PersonaResult,
    QAPair,
    QuestionResult,
    TimeRangeKey,
    TimeRangeResult,
} from './types.js';
import { CATEGORIES, TIME_RANGES } from './types.js';
import { filterQAByRange, loadPersona, listPersonas } from './dataset.js';
import type { PersonaDataset } from './dataset.js';

const ALL_RANGES: TimeRangeKey[] = ['30d', '90d', '6mo', '1y', 'full'];
const DEFAULT_TIMEOUT = 30_000;

export class BenchmarkHarness {
    private config: Required<HarnessConfig>;

    constructor(
        private adapter: MemorySystemAdapter,
        private judge: JudgeModel,
        private dataDir: string,
        config: HarnessConfig = {},
    ) {
        this.config = {
            personas: config.personas ?? [],
            ranges: config.ranges ?? ALL_RANGES,
            shuffleSeed: config.shuffleSeed ?? 42,
            questionTimeoutMs: config.questionTimeoutMs ?? DEFAULT_TIMEOUT,
            parallelism: config.parallelism ?? 1,
        };
    }

    /**
     * Run the full benchmark and return structured results.
     *
     * For each time range (ascending), we:
     *   1. Set up the adapter fresh
     *   2. Ingest days 1..cutoff
     *   3. Finalize ingestion
     *   4. Query all Q&A pairs whose relevant_days fit within the cutoff
     *   5. Score answers via the judge model
     *   6. Tear down
     *
     * This means the adapter is set up/torn down once per (persona × range).
     */
    async run(): Promise<BenchmarkResult> {
        const personaIds = this.config.personas.length > 0
            ? this.config.personas
            : await listPersonas(this.dataDir);

        const personaResults: PersonaResult[] = [];

        for (const personaId of personaIds) {
            const dataset = await loadPersona(this.dataDir, personaId);
            const result = await this.runPersona(dataset);
            personaResults.push(result);
        }

        // Aggregate heatmap across all personas
        const heatmap = this.aggregateHeatmap(personaResults);

        return {
            timestamp: new Date().toISOString(),
            adapterName: this.adapter.name,
            ranges: this.config.ranges,
            personas: personaResults,
            heatmap,
        };
    }

    /**
     * Run a single time range for a single persona. Useful for quick iteration.
     */
    async runSingleRange(personaId: string, range: TimeRangeKey): Promise<TimeRangeResult> {
        const dataset = await loadPersona(this.dataDir, personaId);
        return this.evaluateRange(dataset, range);
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private async runPersona(dataset: PersonaDataset): Promise<PersonaResult> {
        const rangeResults: TimeRangeResult[] = [];
        let totalIngestionMs = 0;
        let totalQueryMs = 0;

        for (const range of this.config.ranges) {
            const result = await this.evaluateRange(dataset, range);
            rangeResults.push(result);

            totalIngestionMs += result.questionResults.reduce((a, q) => a + q.latencyMs, 0);
            totalQueryMs += result.questionResults.reduce((a, q) => a + q.latencyMs, 0);
        }

        const heatmap = this.buildHeatmap(rangeResults);

        return {
            personaId: dataset.personaId,
            adapterName: this.adapter.name,
            rangeResults,
            heatmap,
            totalIngestionMs,
            totalQueryMs,
        };
    }

    private async evaluateRange(dataset: PersonaDataset, range: TimeRangeKey): Promise<TimeRangeResult> {
        const cutoff = TIME_RANGES[range];
        const daysToIngest = dataset.days.filter(d => d.dayNumber <= cutoff);
        const eligibleQA = filterQAByRange(dataset.qaPairs, range);

        // Shuffle questions for this range
        const shuffled = this.shuffle(eligibleQA);

        // Setup + ingest
        await this.adapter.setup();

        for (const day of daysToIngest) {
            await this.adapter.ingestDay(day.dayNumber, day.content, day.metadata);
        }
        await this.adapter.finalizeIngestion();

        // Query + score
        const questionResults = await this.evaluateQuestions(shuffled);

        await this.adapter.teardown();

        // Aggregate
        const scores = questionResults.map(r => r.compositeScore);
        const overallScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

        const categoryScores = this.aggregateByCategory(questionResults);
        const difficultyScores = this.aggregateByDifficulty(questionResults);
        const hallucinationRate = this.computeHallucinationRate(questionResults);

        return {
            range,
            daysIngested: daysToIngest.length,
            questionsEvaluated: questionResults.length,
            overallScore,
            categoryScores,
            difficultyScores,
            hallucinationRate,
            questionResults,
        };
    }

    private async evaluateQuestions(qaPairs: QAPair[]): Promise<QuestionResult[]> {
        const results: QuestionResult[] = [];

        // Run with configured parallelism
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
        try {
            systemAnswer = await Promise.race([
                this.adapter.query(qa.question),
                this.timeout(this.config.questionTimeoutMs),
            ]);
        } catch {
            systemAnswer = '[TIMEOUT]';
        }

        const latencyMs = Date.now() - start;
        const score = await this.judge.score(qa.question, qa.answer, systemAnswer);
        const compositeScore = score.correctness + score.completeness + score.hallucination;

        return { qa, systemAnswer, score, compositeScore, latencyMs };
    }

    private aggregateByCategory(results: QuestionResult[]): CategoryScore[] {
        return CATEGORIES.map(cat => {
            const matching = results.filter(r => r.qa.category === cat);
            const scores = matching.map(r => r.compositeScore);
            return {
                category: cat,
                meanScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
                questionCount: scores.length,
                scores,
            };
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
                cells.push({
                    range: rr.range,
                    category: cs.category,
                    score: cs.meanScore,
                    questionCount: cs.questionCount,
                });
            }
        }
        return cells;
    }

    private aggregateHeatmap(personaResults: PersonaResult[]): HeatmapCell[] {
        // Merge heatmaps from all personas by averaging scores per (range, category)
        const map = new Map<string, { total: number; count: number; questions: number }>();

        for (const pr of personaResults) {
            for (const cell of pr.heatmap) {
                const key = `${cell.range}::${cell.category}`;
                const existing = map.get(key) ?? { total: 0, count: 0, questions: 0 };
                existing.total += cell.score * cell.questionCount;
                existing.count += cell.questionCount;
                existing.questions += cell.questionCount;
                map.set(key, existing);
            }
        }

        const cells: HeatmapCell[] = [];
        for (const [key, val] of map) {
            const [range, category] = key.split('::') as [TimeRangeKey, Category];
            cells.push({
                range,
                category,
                score: val.count > 0 ? val.total / val.count : 0,
                questionCount: val.questions,
            });
        }
        return cells;
    }

    // -----------------------------------------------------------------------
    // Utilities
    // -----------------------------------------------------------------------

    /** Seeded Fisher-Yates shuffle for reproducible question ordering. */
    private shuffle<T>(arr: T[]): T[] {
        const copy = [...arr];
        let seed = this.config.shuffleSeed;
        if (seed === 0) return copy;

        // Simple mulberry32 PRNG
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
