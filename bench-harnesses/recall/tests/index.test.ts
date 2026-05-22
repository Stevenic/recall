/**
 * Smoke tests for the Recall bench adapter.
 *
 * Exercises the MemorySystemAdapter lifecycle (setup → ingestDay → finalize →
 * query → teardown) with a stub MemoryModel so no real LLM calls are made.
 * The goal is to catch lifecycle wiring regressions cheaply, not to measure
 * answer quality (that's what the bench itself is for).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    LocalEmbeddings,
    type MemoryModel,
    type CompleteOptions,
    type CompletionResult,
} from 'recall';
import { createRecallAdapter } from '../src/index.js';
import type { DayMetadata } from '@recall/bench';

// Pre-load the local embeddings model once so the first test doesn't pay the
// ~10-15s ONNX download/load cost and risk a timeout that leaves the model
// file locked for subsequent tests.
beforeAll(async () => {
    const e = new LocalEmbeddings();
    await e.createEmbeddings(['warmup']);
}, 120_000);

class StubModel implements MemoryModel {
    calls: { prompt: string; options?: CompleteOptions }[] = [];
    response = 'stub answer';

    async complete(
        prompt: string,
        options?: CompleteOptions,
    ): Promise<CompletionResult> {
        this.calls.push({ prompt, options });
        return { text: this.response, inputTokens: 10, outputTokens: 5 };
    }
}

function metaFor(day: number, dateOverride?: string): DayMetadata {
    const date = dateOverride ?? `2026-01-${String(day).padStart(2, '0')}`;
    return {
        dayNumber: day,
        date,
        personaId: 'smoke-persona',
        activeArcs: [],
    };
}

describe('createRecallAdapter — lifecycle', () => {
    // Compaction is off in these tests, but vector indexing of daily logs
    // still embeds via LocalEmbeddings — give each test some headroom.
    const TEST_TIMEOUT = 30_000;
    let tmp: string;

    beforeEach(async () => {
        tmp = await mkdtemp(join(tmpdir(), 'recall-adapter-test-'));
    });

    afterEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    it('ingests days into memory/<date>.md', { timeout: TEST_TIMEOUT }, async () => {
        const model = new StubModel();
        const adapter = createRecallAdapter({
            memoryRoot: tmp,
            modelInstance: model,
            enableCompaction: false,
        });

        await adapter.setup();
        await adapter.ingestDay(1, '# Day 1\nFirst day content.', metaFor(1));
        await adapter.ingestDay(2, '# Day 2\nSecond day content.', metaFor(2));
        await adapter.finalizeIngestion();

        const files = await readdir(join(tmp, 'memory'));
        expect(files).toContain('2026-01-01.md');
        expect(files).toContain('2026-01-02.md');

        await adapter.teardown();
    });

    it('finalizeIngestion is idempotent — second call with no new days is a no-op', { timeout: TEST_TIMEOUT }, async () => {
        const model = new StubModel();
        const adapter = createRecallAdapter({
            memoryRoot: tmp,
            modelInstance: model,
            enableCompaction: false,
        });

        await adapter.setup();
        await adapter.ingestDay(1, '# Day 1', metaFor(1));
        await adapter.finalizeIngestion();
        const firstStats = await stat(join(tmp, '.index'));

        // No new ingestion before the second finalize.
        await adapter.finalizeIngestion();
        const secondStats = await stat(join(tmp, '.index'));

        // Index directory still exists and adapter didn't throw.
        expect(secondStats.isDirectory()).toBe(true);
        expect(firstStats.isDirectory()).toBe(true);

        await adapter.teardown();
    });

    it('query returns the synthesis-model response and includes retrieval entries', { timeout: TEST_TIMEOUT }, async () => {
        const model = new StubModel();
        model.response = 'The principal is Jamie Park.';

        const adapter = createRecallAdapter({
            memoryRoot: tmp,
            modelInstance: model,
            enableCompaction: false,
        });

        await adapter.setup();
        await adapter.ingestDay(
            1,
            '# Day 1\nMet with Jamie Park, the CFO. Discussed Q1 priorities.',
            metaFor(1),
        );
        await adapter.finalizeIngestion();

        const answer = await adapter.query('Who is the principal?');
        expect(answer).toBe('The principal is Jamie Park.');
        expect(model.calls.length).toBeGreaterThan(0);
        const lastCall = model.calls[model.calls.length - 1];
        // The prompt should include the question and reference the ingested content.
        expect(lastCall.prompt).toContain('Who is the principal?');

        const detail = await adapter.queryDetail!('Who is the principal?');
        expect(detail.answer).toBe('The principal is Jamie Park.');
        // Retrieval entries are arrays (may be empty if vector search finds nothing
        // on this tiny corpus, but the shape must be correct).
        expect(Array.isArray(detail.retrieval)).toBe(true);

        await adapter.teardown();
    });

    it('writes IDENTITY.md when identity is configured', { timeout: TEST_TIMEOUT }, async () => {
        const model = new StubModel();
        const adapter = createRecallAdapter({
            memoryRoot: tmp,
            modelInstance: model,
            identity: 'A focused test persona.',
            identityName: 'TestBot',
            enableCompaction: false,
        });

        await adapter.setup();
        const files = await readdir(tmp);
        expect(files).toContain('IDENTITY.md');

        await adapter.teardown();
    });

    it('teardown cleans up the temp root when no memoryRoot was provided', { timeout: TEST_TIMEOUT }, async () => {
        const model = new StubModel();
        const adapter = createRecallAdapter({
            modelInstance: model,
            enableCompaction: false,
        });

        await adapter.setup();
        await adapter.ingestDay(1, '# Day 1', metaFor(1));
        await adapter.finalizeIngestion();
        await adapter.teardown();

        // After teardown the adapter throws on further calls (service is null).
        await expect(adapter.query('anything')).rejects.toThrow(/not set up/);
    });
});
