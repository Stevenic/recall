import { describe, it, expect } from 'vitest';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenClawMemoryAdapter } from '../src/adapter.js';
import type {
    MemorySearchManager,
    MemorySearchResult,
} from "@openclaw/memory-core/runtime-api.js";
import type { SynthesisModel } from '../src/synthesis.js';
import type { DayMetadata } from '../src/types.js';

function meta(day: number, date: string): DayMetadata {
    return { dayNumber: day, date, personaId: 'test', activeArcs: [] };
}

interface FakeManagerHandle {
    manager: MemorySearchManager;
    syncCalls: Array<{ reason?: string; force?: boolean }>;
    searchCalls: Array<{
        query: string;
        opts?: { maxResults?: number; minScore?: number; sources?: unknown };
    }>;
    closed: boolean;
    setHits: (hits: MemorySearchResult[]) => void;
}

function makeFakeManager(): FakeManagerHandle {
    let hits: MemorySearchResult[] = [];
    const handle: FakeManagerHandle = {
        manager: undefined as unknown as MemorySearchManager,
        syncCalls: [],
        searchCalls: [],
        closed: false,
        setHits: (h) => {
            hits = h;
        },
    };
    handle.manager = {
        async search(query, opts) {
            handle.searchCalls.push({ query, opts });
            return hits;
        },
        async readFile() {
            throw new Error('fake manager: readFile not implemented');
        },
        status() {
            return {
                backend: 'builtin' as const,
                provider: 'fake',
                files: 0,
                chunks: hits.length,
            };
        },
        async sync(opts) {
            handle.syncCalls.push(opts ?? {});
        },
        async probeEmbeddingAvailability() {
            return { ok: false };
        },
        async probeVectorAvailability() {
            return false;
        },
        async close() {
            handle.closed = true;
        },
    };
    return handle;
}

class CapturingSynthesis implements SynthesisModel {
    public lastUser: string | null = null;
    constructor(private readonly response = 'fake-answer') {}
    async complete(_system: string, user: string): Promise<{ text: string }> {
        this.lastUser = user;
        return { text: this.response };
    }
}

describe('OpenClawMemoryAdapter — full lifecycle with fake manager', () => {
    it('walks setup → ingest → finalize → query → teardown', async () => {
        const handle = makeFakeManager();
        const synth = new CapturingSynthesis('Deposition was March 15.');
        const adapter = new OpenClawMemoryAdapter({
            embeddingProvider: 'auto',
            synthesisModelImpl: synth,
            managerFactory: async () => handle.manager,
        });

        // setup creates a real workspace on disk
        await adapter.setup();
        // sneak the workspace path out via a query → should fail before finalize
        await expect(adapter.query('anything')).rejects.toThrow(/before finalizeIngestion/);

        await adapter.ingestDay(1, '# Day 1\n\nFiled motion.', meta(1, '2026-01-01'));
        await adapter.ingestDay(2, '# Day 2\n\nDeposition scheduled.', meta(2, '2026-01-02'));

        await adapter.finalizeIngestion();

        // sync was called with force: true on finalize
        expect(handle.syncCalls).toHaveLength(1);
        expect(handle.syncCalls[0]?.force).toBe(true);

        // give the fake some hits to return
        handle.setHits([
            {
                path: 'memory/2026-01-02.md',
                startLine: 1,
                endLine: 5,
                score: 0.9,
                snippet: 'Deposition scheduled.',
                source: 'memory',
            },
        ]);

        const answer = await adapter.query('When was the deposition?');
        expect(answer).toBe('Deposition was March 15.');
        expect(handle.searchCalls).toHaveLength(1);
        expect(handle.searchCalls[0]?.query).toBe('When was the deposition?');
        expect(handle.searchCalls[0]?.opts?.sources).toEqual(['memory']);
        expect(synth.lastUser).toContain('[2026-01-02]');

        await adapter.teardown();
        expect(handle.closed).toBe(true);
    });

    it('writes day files into the workspace using the ISO date metadata', async () => {
        const handle = makeFakeManager();
        const adapter = new OpenClawMemoryAdapter({
            embeddingProvider: 'auto',
            synthesisModelImpl: new CapturingSynthesis(),
            managerFactory: async (params) => {
                // Spy: capture the workspaceDir so we can poke at it.
                capturedWorkspace = params.workspaceDir;
                return handle.manager;
            },
        });
        let capturedWorkspace = '';
        await adapter.setup();
        await adapter.ingestDay(1, 'D1', meta(1, '2026-04-01'));
        await adapter.ingestDay(2, 'D2', meta(2, '2026-04-02'));
        await adapter.finalizeIngestion();

        const d1 = await readFile(join(capturedWorkspace, 'memory', '2026-04-01.md'), 'utf8');
        expect(d1).toBe('D1');
        const d2 = await readFile(join(capturedWorkspace, 'memory', '2026-04-02.md'), 'utf8');
        expect(d2).toBe('D2');

        await adapter.teardown();
        await expect(stat(capturedWorkspace)).rejects.toThrow();
    });

    it('returns the canned not-enough-info reply when search yields no hits', async () => {
        const handle = makeFakeManager();
        const adapter = new OpenClawMemoryAdapter({
            embeddingProvider: 'auto',
            synthesisModelImpl: new CapturingSynthesis('SHOULD NOT BE USED'),
            managerFactory: async () => handle.manager,
        });
        await adapter.setup();
        await adapter.finalizeIngestion();
        const answer = await adapter.query('Did anything happen?');
        expect(answer).toMatch(/don't have enough information/i);
        await adapter.teardown();
    });

    it('teardown still cleans the workspace if close() throws', async () => {
        const handle = makeFakeManager();
        handle.manager.close = async () => {
            throw new Error('boom');
        };
        const adapter = new OpenClawMemoryAdapter({
            embeddingProvider: 'auto',
            synthesisModelImpl: new CapturingSynthesis(),
            managerFactory: async (params) => {
                captured = params.workspaceDir;
                return handle.manager;
            },
        });
        let captured = '';
        await adapter.setup();
        await adapter.finalizeIngestion();

        await expect(adapter.teardown()).rejects.toThrow(/boom/);
        await expect(stat(captured)).rejects.toThrow();
    });

    it('rejects double setup without intervening teardown', async () => {
        const adapter = new OpenClawMemoryAdapter({
            embeddingProvider: 'auto',
            synthesisModelImpl: new CapturingSynthesis(),
            managerFactory: async () => makeFakeManager().manager,
        });
        await adapter.setup();
        await expect(adapter.setup()).rejects.toThrow(/setup called twice/);
        await adapter.teardown();
    });

    it('supports a clean setup → teardown → setup re-use cycle', async () => {
        const handle = makeFakeManager();
        const adapter = new OpenClawMemoryAdapter({
            embeddingProvider: 'auto',
            synthesisModelImpl: new CapturingSynthesis(),
            managerFactory: async () => handle.manager,
        });
        await adapter.setup();
        await adapter.finalizeIngestion();
        await adapter.teardown();

        // second cycle
        await adapter.setup();
        await adapter.ingestDay(1, 'fresh', meta(1, '2026-05-01'));
        await adapter.finalizeIngestion();
        await adapter.teardown();
        // sync was called once per finalize
        expect(handle.syncCalls).toHaveLength(2);
    });

    it('names itself by configured backend mode', () => {
        const fts = new OpenClawMemoryAdapter({ embeddingProvider: 'auto' });
        expect(fts.name).toBe('openclaw[fts]');
        const vec = new OpenClawMemoryAdapter({
            embeddingProvider: 'openai',
            embeddingModel: 'text-embedding-3-large',
        });
        expect(vec.name).toBe('openclaw[vector:text-embedding-3-large]');
    });

    it('passes embeddingProvider/embeddingModel through to the manager factory', async () => {
        const handle = makeFakeManager();
        let captured: { embeddingProvider: string; embeddingModel?: string } | null = null;
        const adapter = new OpenClawMemoryAdapter({
            embeddingProvider: 'openai',
            embeddingModel: 'text-embedding-3-small',
            synthesisModelImpl: new CapturingSynthesis(),
            managerFactory: async (params) => {
                captured = {
                    embeddingProvider: params.embeddingProvider,
                };
                if (params.embeddingModel !== undefined) captured.embeddingModel = params.embeddingModel;
                return handle.manager;
            },
        });
        await adapter.setup();
        await adapter.finalizeIngestion();
        expect(captured).toEqual({
            embeddingProvider: 'openai',
            embeddingModel: 'text-embedding-3-small',
        });
        await adapter.teardown();
    });
});
