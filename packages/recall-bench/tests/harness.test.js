import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { BenchmarkHarness } from '../src/harness.js';
import { filterQAByRange, loadPersona } from '../src/dataset.js';
import { formatTextReport, toHeatmapGrid } from '../src/report.js';
import { parseTimeRange } from '../src/types.js';
const R = (input) => parseTimeRange(input);
// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
/** In-memory adapter that stores days and answers with stored content. */
function createTestAdapter() {
    const stored = new Map();
    return {
        name: 'test-adapter',
        stored,
        async setup() { stored.clear(); },
        async ingestDay(day, content) { stored.set(day, content); },
        async finalizeIngestion() { },
        async query(question) {
            // Trivial: return all stored content joined
            return `Answer based on ${stored.size} days of memory.`;
        },
        async teardown() { stored.clear(); },
    };
}
/** Judge that gives fixed scores. */
function createTestJudge(scores) {
    return {
        async score() { return scores; },
    };
}
/** Build a minimal persona dataset on disk. */
async function buildTestDataset(dir, personaId, dayCount, qaPairs) {
    const personaDir = join(dir, personaId);
    const memoriesDir = join(personaDir, 'memories-1000d');
    const qaDir = join(personaDir, 'qa-1000d');
    await mkdir(memoriesDir, { recursive: true });
    await mkdir(qaDir, { recursive: true });
    // persona.yaml
    await writeFile(join(personaDir, 'persona.yaml'), YAML.stringify({
        id: personaId,
        name: 'Test Persona',
        epoch: '2024-01-01',
    }));
    // arcs-1000d.yaml (default canonical-duration arcs file)
    await writeFile(join(personaDir, 'arcs-1000d.yaml'), YAML.stringify({
        arcs: [
            { id: 'arc-1', startDay: 1, endDay: 50 },
            { id: 'arc-2', startDay: 20, endDay: 100 },
        ],
    }));
    // Memory days
    for (let d = 1; d <= dayCount; d++) {
        const padded = String(d).padStart(4, '0');
        await writeFile(join(memoriesDir, `day-${padded}.md`), `# Day ${d}\n\nSome memory content for day ${d}.`);
    }
    // Q&A pairs
    await writeFile(join(qaDir, 'questions.yaml'), YAML.stringify(qaPairs));
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
let tmpDir;
beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'recall-bench-test-'));
});
afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});
describe('filterQAByRange', () => {
    const pairs = [
        { id: 'q1', question: 'Q1', answer: 'A1', category: 'factual-recall', difficulty: 'easy', relevantDays: [5, 10], requiresSynthesis: false },
        { id: 'q2', question: 'Q2', answer: 'A2', category: 'temporal-reasoning', difficulty: 'medium', relevantDays: [25, 35], requiresSynthesis: false },
        { id: 'q3', question: 'Q3', answer: 'A3', category: 'decision-tracking', difficulty: 'hard', relevantDays: [100, 200], requiresSynthesis: true },
        { id: 'q4', question: 'Q4', answer: 'A4', category: 'synthesis', difficulty: 'medium', relevantDays: [10, 500], requiresSynthesis: true },
    ];
    it('filters to 30d — only pairs with all days <= 30', () => {
        const result = filterQAByRange(pairs, R('30d'));
        // q2 has relevant_days [25, 35] — day 35 exceeds 30
        expect(result.map(q => q.id)).toEqual(['q1']);
    });
    it('filters to 90d', () => {
        const result = filterQAByRange(pairs, R('90d'));
        expect(result.map(q => q.id)).toEqual(['q1', 'q2']);
    });
    it('filters to 6mo (180 days)', () => {
        const result = filterQAByRange(pairs, R('6mo'));
        expect(result.map(q => q.id)).toEqual(['q1', 'q2']);
    });
    it('filters to 1y (365 days)', () => {
        const result = filterQAByRange(pairs, R('1y'));
        expect(result.map(q => q.id)).toEqual(['q1', 'q2', 'q3']);
    });
    it('full range returns all', () => {
        const result = filterQAByRange(pairs, R('full'));
        expect(result.map(q => q.id)).toEqual(['q1', 'q2', 'q3', 'q4']);
    });
    it('accepts a raw numeric day count', () => {
        // q1 [5,10] ✓, q2 [25,35] ✓, q3 [100,200] ✗, q4 [10,500] ✗
        const result = filterQAByRange(pairs, R(60));
        expect(result.map(q => q.id)).toEqual(['q1', 'q2']);
    });
});
describe('BenchmarkHarness', () => {
    it('runs a single range and produces correct structure', async () => {
        const personaId = 'test-persona-single';
        await buildTestDataset(tmpDir, personaId, 50, [
            { id: 'q1', question: 'What?', answer: 'Something.', category: 'factual-recall', difficulty: 'easy', relevant_days: [5] },
            { id: 'q2', question: 'When?', answer: 'Day 10.', category: 'temporal-reasoning', difficulty: 'medium', relevant_days: [10] },
            { id: 'q3', question: 'Late?', answer: 'Day 100.', category: 'synthesis', difficulty: 'hard', relevant_days: [100] },
        ]);
        const adapter = createTestAdapter();
        const judge = createTestJudge({ correctness: 2, completeness: 1, hallucination: 1 });
        const harness = new BenchmarkHarness(adapter, judge, tmpDir, {
            personas: [personaId],
            ranges: [R('30d')],
        });
        const result = await harness.run();
        const pr = result.personas[0];
        const rr = pr.rangeResults[0];
        expect(rr.range.label).toBe('30d');
        expect(rr.daysIngested).toBe(30);
        // q3 has relevant_days [100], which exceeds 30d cutoff
        expect(rr.questionsEvaluated).toBe(2);
        expect(rr.overallScore).toBe(4); // 2 + 1 + 1
    });
    it('runs full benchmark with multiple ranges', async () => {
        const personaId = 'test-persona-multi';
        await buildTestDataset(tmpDir, personaId, 100, [
            { id: 'q1', question: 'Early?', answer: 'Yes.', category: 'factual-recall', difficulty: 'easy', relevant_days: [5] },
            { id: 'q2', question: 'Mid?', answer: 'Yes.', category: 'decision-tracking', difficulty: 'medium', relevant_days: [50] },
            { id: 'q3', question: 'Late?', answer: 'Yes.', category: 'synthesis', difficulty: 'hard', relevant_days: [95] },
        ]);
        const adapter = createTestAdapter();
        const judge = createTestJudge({ correctness: 3, completeness: 2, hallucination: 1 });
        const harness = new BenchmarkHarness(adapter, judge, tmpDir, {
            personas: [personaId],
            ranges: [R('30d'), R('90d'), R('full')],
        });
        const result = await harness.run();
        expect(result.personas).toHaveLength(1);
        const pr = result.personas[0];
        expect(pr.rangeResults).toHaveLength(3);
        // 30d: only q1
        expect(pr.rangeResults[0].questionsEvaluated).toBe(1);
        // 90d: q1 + q2
        expect(pr.rangeResults[1].questionsEvaluated).toBe(2);
        // full: all 3
        expect(pr.rangeResults[2].questionsEvaluated).toBe(3);
        // Heatmap should have entries
        expect(pr.heatmap.length).toBeGreaterThan(0);
        expect(result.heatmap.length).toBeGreaterThan(0);
    });
    it('ingests only days up to the cutoff', async () => {
        const personaId = 'test-persona-cutoff';
        await buildTestDataset(tmpDir, personaId, 100, [
            { id: 'q1', question: 'Q?', answer: 'A.', category: 'factual-recall', difficulty: 'easy', relevant_days: [5] },
        ]);
        const adapter = createTestAdapter();
        const judge = createTestJudge({ correctness: 3, completeness: 2, hallucination: 1 });
        const harness = new BenchmarkHarness(adapter, judge, tmpDir, {
            personas: [personaId],
            ranges: [R('30d')],
        });
        const result = await harness.run();
        expect(result.personas[0].rangeResults[0].daysIngested).toBe(30);
    });
    it('always evaluates new questions; caps historical at config.sample', async () => {
        const personaId = 'test-persona-sample';
        // 10 pairs, one per day at days 1..10.
        const qa = Array.from({ length: 10 }, (_, i) => ({
            id: `q${i + 1}`,
            question: `Day ${i + 1}?`,
            answer: `A.`,
            category: 'factual-recall',
            difficulty: 'easy',
            relevant_days: [i + 1],
        }));
        await buildTestDataset(tmpDir, personaId, 30, qa);
        const adapter = createTestAdapter();
        const judge = createTestJudge({ correctness: 3, completeness: 2, hallucination: 1 });
        const harness = new BenchmarkHarness(adapter, judge, tmpDir, {
            personas: [personaId],
            // Cutoffs at days 3, 6, 9 → +3 new each step. Cap historical at 2.
            ranges: [R(3), R(6), R(9)],
            sample: 2,
        });
        const result = await harness.run();
        const counts = result.personas[0].rangeResults.map(rr => rr.questionsEvaluated);
        // Range 1: 3 new + 0 historical = 3
        // Range 2: 3 new + min(2, 3) historical = 5
        // Range 3: 3 new + min(2, 6) historical = 5
        expect(counts).toEqual([3, 5, 5]);
        // Metadata records the sample setting and the total-evals count.
        expect(result.metadata.sample).toBe(2);
        expect(result.metadata.totalEvalsRun).toBe(13);
        expect(result.metadata.uniqueQAPairCount).toBe(10);
    });
    it('passes memory excerpts to the judge when judgeMemoryWindow > 0', async () => {
        const personaId = 'test-persona-judge-grounding';
        await buildTestDataset(tmpDir, personaId, 20, [
            { id: 'q1', question: 'Q?', answer: 'A.', category: 'factual-recall', difficulty: 'easy', relevant_days: [10] },
        ]);
        const adapter = createTestAdapter();
        const captured = [];
        const judge = {
            async score(_q, _ref, _sys, context) {
                captured.push({ context });
                return { correctness: 3, completeness: 2, hallucination: 1 };
            },
        };
        const harness = new BenchmarkHarness(adapter, judge, tmpDir, {
            personas: [personaId],
            ranges: [R(10)],
            judgeMemoryWindow: 1,
        });
        const result = await harness.run();
        expect(captured).toHaveLength(1);
        const excerpts = captured[0].context?.memoryExcerpts ?? '';
        // Window ±1 around day 10 → days 9, 10, 11 should all be present.
        expect(excerpts).toContain('--- DAY 9');
        expect(excerpts).toContain('--- DAY 10');
        expect(excerpts).toContain('--- DAY 11');
        // Days outside window should not leak in.
        expect(excerpts).not.toContain('--- DAY 8');
        expect(excerpts).not.toContain('--- DAY 12');
        expect(result.metadata.judgeMemoryWindow).toBe(1);
    });
    it('gates information-boundary/group-session-attribution by groupsEnabled', async () => {
        const personaId = 'test-persona-groups-off';
        await buildTestDataset(tmpDir, personaId, 30, [
            { id: 'q1', question: 'Q?', answer: 'A.', category: 'factual-recall', difficulty: 'easy', relevant_days: [5] },
            { id: 'q2', question: 'Q?', answer: 'leaked.', category: 'information-boundary', difficulty: 'medium', relevant_days: [10], expected_disclosure: 'refuse' },
            { id: 'q3', question: 'Q?', answer: 'A.', category: 'group-session-attribution', difficulty: 'easy', relevant_days: [15] },
        ]);
        const adapter = createTestAdapter();
        const judge = createTestJudge({ correctness: 3, completeness: 2, hallucination: 1 });
        // groupsEnabled defaults to false → q2 and q3 should be skipped.
        let result = await new BenchmarkHarness(adapter, judge, tmpDir, {
            personas: [personaId],
            ranges: [R(30)],
        }).run();
        expect(result.personas[0].rangeResults[0].questionsEvaluated).toBe(1);
        expect(result.metadata.groupsEnabled).toBe(false);
        // groupsEnabled: true → all three evaluated.
        result = await new BenchmarkHarness(adapter, judge, tmpDir, {
            personas: [personaId],
            ranges: [R(30)],
            groupsEnabled: true,
        }).run();
        expect(result.personas[0].rangeResults[0].questionsEvaluated).toBe(3);
        expect(result.metadata.groupsEnabled).toBe(true);
    });
    it('routes primary-judge failures to the appellate judge and records both verdicts', async () => {
        const personaId = 'test-persona-appellate';
        await buildTestDataset(tmpDir, personaId, 30, [
            { id: 'q1', question: 'good?', answer: 'A.', category: 'factual-recall', difficulty: 'easy', relevant_days: [5] },
            { id: 'q2', question: 'bad?', answer: 'B.', category: 'factual-recall', difficulty: 'easy', relevant_days: [5] },
        ]);
        const adapter = createTestAdapter();
        // Primary judges q1 well (passes), q2 poorly (fails → appellate).
        let primaryCalls = 0;
        const primary = {
            async score(question) {
                primaryCalls++;
                return question.includes('good')
                    ? { correctness: 3, completeness: 2, hallucination: 1 }
                    : { correctness: 1, completeness: 0, hallucination: 0 };
            },
        };
        // Appellate overturns q2 to a higher score — verifies its verdict is final.
        let appellateCalls = 0;
        const appellate = {
            async score() {
                appellateCalls++;
                return { correctness: 2, completeness: 1, hallucination: 1, reasoning: 'partial credit on appeal' };
            },
        };
        const failureLogPath = join(tmpDir, 'failures-test.jsonl');
        const result = await new BenchmarkHarness(adapter, primary, tmpDir, {
            personas: [personaId],
            ranges: [R(10)],
            appellateJudge: appellate,
            failureLogPath,
        }).run();
        expect(primaryCalls).toBe(2);
        expect(appellateCalls).toBe(1); // only q2 was a primary failure
        const qrs = result.personas[0].rangeResults[0].questionResults;
        const q2 = qrs.find((r) => r.qa.id === 'q2');
        expect(q2?.score.correctness).toBe(2); // appellate verdict won
        expect(q2?.primaryScore?.correctness).toBe(1); // primary preserved
        const q1 = qrs.find((r) => r.qa.id === 'q1');
        expect(q1?.primaryScore).toBeUndefined();
        expect(result.metadata.appellateInvocations).toBe(1);
        // Verify failure log was written with the expected structure.
        const { readFile } = await import('node:fs/promises');
        const log = await readFile(failureLogPath, 'utf-8');
        const lines = log.trim().split('\n');
        expect(lines).toHaveLength(1);
        const entry = JSON.parse(lines[0]);
        expect(entry.qa.id).toBe('q2');
        expect(entry.primaryScore.correctness).toBe(1);
        expect(entry.appellateScore.correctness).toBe(2);
    });
    it('threads boundary metadata to the judge for information-boundary pairs', async () => {
        const personaId = 'test-persona-boundary-judge';
        await buildTestDataset(tmpDir, personaId, 30, [
            { id: 'qb', question: 'What about X?', answer: 'sensitive', category: 'information-boundary', difficulty: 'medium', relevant_days: [10], expected_disclosure: 'refuse', query_session: 'principal', forbidden_sessions: ['legal'] },
        ]);
        const adapter = createTestAdapter();
        const captured = [];
        const judge = {
            async score(_q, _ref, _sys, context) {
                captured.push({ context });
                return { correctness: 3, completeness: 2, hallucination: 1 };
            },
        };
        await new BenchmarkHarness(adapter, judge, tmpDir, {
            personas: [personaId],
            ranges: [R(30)],
            groupsEnabled: true,
            judgeMemoryWindow: 1,
        }).run();
        expect(captured).toHaveLength(1);
        expect(captured[0].context?.expectedDisclosure).toBe('refuse');
        expect(captured[0].context?.querySession).toBe('principal');
        expect(captured[0].context?.forbiddenSessions).toEqual(['legal']);
    });
    it('omits judge context when judgeMemoryWindow is 0/undefined', async () => {
        const personaId = 'test-persona-judge-nocontext';
        await buildTestDataset(tmpDir, personaId, 20, [
            { id: 'q1', question: 'Q?', answer: 'A.', category: 'factual-recall', difficulty: 'easy', relevant_days: [10] },
        ]);
        const adapter = createTestAdapter();
        const captured = [];
        const judge = {
            async score(_q, _ref, _sys, context) {
                captured.push({ context });
                return { correctness: 3, completeness: 2, hallucination: 1 };
            },
        };
        const harness = new BenchmarkHarness(adapter, judge, tmpDir, {
            personas: [personaId],
            ranges: [R(10)],
            // no judgeMemoryWindow
        });
        const result = await harness.run();
        expect(captured[0].context).toBeUndefined();
        expect(result.metadata.judgeMemoryWindow).toBeUndefined();
    });
    it('runs multiple checkpoints incrementally (single setup/teardown, ingest delta per range)', async () => {
        const personaId = 'test-persona-incremental';
        await buildTestDataset(tmpDir, personaId, 60, [
            { id: 'q1', question: 'Q?', answer: 'A.', category: 'factual-recall', difficulty: 'easy', relevant_days: [5] },
        ]);
        const adapter = createTestAdapter();
        let setupCount = 0;
        let teardownCount = 0;
        const ingestedDays = [];
        const wrapped = {
            name: 'wrapped',
            async setup() { setupCount++; await adapter.setup(); },
            async ingestDay(day, content, meta) { ingestedDays.push(day); await adapter.ingestDay(day, content, meta); },
            async finalizeIngestion() { await adapter.finalizeIngestion(); },
            async query(q) { return adapter.query(q); },
            async teardown() { teardownCount++; await adapter.teardown(); },
        };
        const judge = createTestJudge({ correctness: 3, completeness: 2, hallucination: 1 });
        const harness = new BenchmarkHarness(wrapped, judge, tmpDir, {
            personas: [personaId],
            ranges: [R(10), R(20), R(30)],
        });
        await harness.run();
        expect(setupCount).toBe(1);
        expect(teardownCount).toBe(1);
        // Each day ingested exactly once across all 3 checkpoints
        expect(ingestedDays).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    });
});
describe('Report generation', () => {
    it('produces a text report with heatmap', async () => {
        const personaId = 'test-persona-report';
        await buildTestDataset(tmpDir, personaId, 50, [
            { id: 'q1', question: 'Q?', answer: 'A.', category: 'factual-recall', difficulty: 'easy', relevant_days: [5] },
            { id: 'q2', question: 'Q?', answer: 'A.', category: 'contradiction-resolution', difficulty: 'medium', relevant_days: [10, 20] },
        ]);
        const adapter = createTestAdapter();
        const judge = createTestJudge({ correctness: 2, completeness: 1, hallucination: 1 });
        const harness = new BenchmarkHarness(adapter, judge, tmpDir, {
            personas: [personaId],
            ranges: [R('30d'), R('90d')],
        });
        const result = await harness.run();
        const text = formatTextReport(result);
        expect(text).toContain('Recall Bench Report');
        expect(text).toContain('test-adapter');
        expect(text).toContain('AGGREGATE HEATMAP');
        expect(text).toContain('factual-recall');
        expect(text).toContain('contradiction-resolution');
    });
    it('produces a heatmap grid', async () => {
        const personaId = 'test-persona-grid';
        await buildTestDataset(tmpDir, personaId, 50, [
            { id: 'q1', question: 'Q?', answer: 'A.', category: 'factual-recall', difficulty: 'easy', relevant_days: [5] },
        ]);
        const adapter = createTestAdapter();
        const judge = createTestJudge({ correctness: 3, completeness: 2, hallucination: 1 });
        const harness = new BenchmarkHarness(adapter, judge, tmpDir, {
            personas: [personaId],
            ranges: [R('30d')],
        });
        const result = await harness.run();
        const grid = toHeatmapGrid(result.heatmap, result.ranges);
        expect(grid.categories).toHaveLength(10);
        expect(grid.ranges).toEqual(['30d']);
        expect(grid.scores).toHaveLength(10);
        // factual-recall should have a score
        expect(grid.scores[0][0]).toBe(6); // 3+2+1
        // Other categories should be null (no questions)
        expect(grid.scores[1][0]).toBeNull();
    });
});
describe('Dataset loading', () => {
    it('loads persona and filters Q&A by range', async () => {
        const personaId = 'test-persona-load';
        await buildTestDataset(tmpDir, personaId, 200, [
            { id: 'q1', question: 'Early?', answer: 'Yes.', category: 'factual-recall', difficulty: 'easy', relevant_days: [5] },
            { id: 'q2', question: 'Late?', answer: 'Yes.', category: 'synthesis', difficulty: 'hard', relevant_days: [150] },
        ]);
        const dataset = await loadPersona(tmpDir, personaId);
        expect(dataset.days).toHaveLength(200);
        expect(dataset.qaPairs).toHaveLength(2);
        // day metadata should include active arcs
        const day25 = dataset.days[24]; // 0-indexed, day 25
        expect(day25.metadata.activeArcs).toContain('arc-1');
        expect(day25.metadata.activeArcs).toContain('arc-2');
        const day5 = dataset.days[4]; // day 5
        expect(day5.metadata.activeArcs).toContain('arc-1');
        expect(day5.metadata.activeArcs).not.toContain('arc-2');
    });
});
//# sourceMappingURL=harness.test.js.map