import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { BenchmarkHarness } from '../src/harness.js';
import { filterQAByRange, loadPersona } from '../src/dataset.js';
import { formatTextReport, toHeatmapGrid } from '../src/report.js';
import type { MemorySystemAdapter, JudgeModel, QAPair, TimeRangeKey, DayMetadata } from '../src/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** In-memory adapter that stores days and answers with stored content. */
function createTestAdapter(): MemorySystemAdapter & { stored: Map<number, string> } {
    const stored = new Map<number, string>();
    return {
        name: 'test-adapter',
        stored,
        async setup() { stored.clear(); },
        async ingestDay(day: number, content: string) { stored.set(day, content); },
        async finalizeIngestion() {},
        async query(question: string) {
            // Trivial: return all stored content joined
            return `Answer based on ${stored.size} days of memory.`;
        },
        async teardown() { stored.clear(); },
    };
}

/** Judge that gives fixed scores. */
function createTestJudge(scores: { correctness: number; completeness: number; hallucination: number }): JudgeModel {
    return {
        async score() { return scores; },
    };
}

/** Build a minimal persona dataset on disk. */
async function buildTestDataset(dir: string, personaId: string, dayCount: number, qaPairs: Array<{
    id: string;
    question: string;
    answer: string;
    category: string;
    difficulty: string;
    relevant_days: number[];
}>) {
    const personaDir = join(dir, personaId);
    const memoriesDir = join(personaDir, 'memories');
    const qaDir = join(personaDir, 'qa');
    await mkdir(memoriesDir, { recursive: true });
    await mkdir(qaDir, { recursive: true });

    // persona.yaml
    await writeFile(join(personaDir, 'persona.yaml'), YAML.stringify({
        id: personaId,
        name: 'Test Persona',
        epoch: '2024-01-01',
    }));

    // arcs.yaml
    await writeFile(join(personaDir, 'arcs.yaml'), YAML.stringify({
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

let tmpDir: string;

beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'recall-bench-test-'));
});

afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

describe('filterQAByRange', () => {
    const pairs: QAPair[] = [
        { id: 'q1', question: 'Q1', answer: 'A1', category: 'factual-recall', difficulty: 'easy', relevantDays: [5, 10], requiresSynthesis: false },
        { id: 'q2', question: 'Q2', answer: 'A2', category: 'temporal-reasoning', difficulty: 'medium', relevantDays: [25, 35], requiresSynthesis: false },
        { id: 'q3', question: 'Q3', answer: 'A3', category: 'decision-tracking', difficulty: 'hard', relevantDays: [100, 200], requiresSynthesis: true },
        { id: 'q4', question: 'Q4', answer: 'A4', category: 'synthesis', difficulty: 'medium', relevantDays: [10, 500], requiresSynthesis: true },
    ];

    it('filters to 30d — only pairs with all days <= 30', () => {
        const result = filterQAByRange(pairs, '30d');
        // q2 has relevant_days [25, 35] — day 35 exceeds 30
        expect(result.map(q => q.id)).toEqual(['q1']);
    });

    it('filters to 90d', () => {
        const result = filterQAByRange(pairs, '90d');
        expect(result.map(q => q.id)).toEqual(['q1', 'q2']);
    });

    it('filters to 6mo (180 days)', () => {
        const result = filterQAByRange(pairs, '6mo');
        expect(result.map(q => q.id)).toEqual(['q1', 'q2']);
    });

    it('filters to 1y (365 days)', () => {
        const result = filterQAByRange(pairs, '1y');
        expect(result.map(q => q.id)).toEqual(['q1', 'q2', 'q3']);
    });

    it('full range returns all', () => {
        const result = filterQAByRange(pairs, 'full');
        expect(result.map(q => q.id)).toEqual(['q1', 'q2', 'q3', 'q4']);
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
            ranges: ['30d'],
        });

        const result = await harness.runSingleRange(personaId, '30d');

        expect(result.range).toBe('30d');
        expect(result.daysIngested).toBe(30);
        // q3 has relevant_days [100], which exceeds 30d cutoff
        expect(result.questionsEvaluated).toBe(2);
        expect(result.overallScore).toBe(4); // 2 + 1 + 1
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
            ranges: ['30d', '90d', 'full'],
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
            ranges: ['30d'],
        });

        const result = await harness.runSingleRange(personaId, '30d');
        expect(result.daysIngested).toBe(30);
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
            ranges: ['30d', '90d'],
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
            ranges: ['30d'],
        });

        const result = await harness.run();
        const grid = toHeatmapGrid(result.heatmap, result.ranges);

        expect(grid.categories).toHaveLength(8);
        expect(grid.ranges).toEqual(['30d']);
        expect(grid.scores).toHaveLength(8);
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
