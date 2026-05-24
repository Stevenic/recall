/**
 * Smoke tests for the MemPalace bench adapter.
 *
 * Exercises the lifecycle (setup → ingestDay → finalize → query → teardown)
 * against the real `mempalace-mcp` server with a stub synthesis model so no
 * external LLM calls are made. Skipped when `mempalace-mcp` isn't available
 * via uv / on PATH, so the suite stays green for contributors who don't
 * have a mempalace checkout.
 *
 * To force-run these against a specific mempalace checkout:
 *
 *   RECALL_MP_COMMAND="uv run --project C:/source/mempalace mempalace-mcp" \
 *     pnpm --filter @recall/bench-harness-mempalace test
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createMempalaceAdapter } from '../src/index.js';
import type { DayMetadata } from '../src/types.js';
import type { SynthesisModel } from '../src/synthesis.js';

function resolveCommand(): string[] | null {
    const fromEnv = process.env['RECALL_MP_COMMAND'];
    if (fromEnv) return fromEnv.split(/\s+/).filter((p) => p.length > 0);
    // Try `mempalace-mcp` on PATH.
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['mempalace-mcp']);
    if (probe.status === 0) return ['mempalace-mcp'];
    return null;
}

const command = resolveCommand();
const describeIfAvailable = command ? describe : describe.skip;

function metaFor(day: number, dateOverride?: string): DayMetadata {
    const date = dateOverride ?? `2026-01-${String(day).padStart(2, '0')}`;
    return {
        dayNumber: day,
        date,
        personaId: 'smoke-persona',
        activeArcs: [],
    };
}

class StubSynthesis implements SynthesisModel {
    calls: Array<{ system: string; user: string }> = [];
    response = 'stub answer';
    async complete(system: string, user: string) {
        this.calls.push({ system, user });
        return { text: this.response };
    }
}

describeIfAvailable('MempalaceAdapter — lifecycle', () => {
    const TEST_TIMEOUT = 120_000;
    let adapter: ReturnType<typeof createMempalaceAdapter> | null = null;
    let stub: StubSynthesis;

    beforeAll(() => {
        if (!command) throw new Error('command resolved as null after skip check — unreachable');
    });

    afterEach(async () => {
        if (adapter) {
            await adapter.teardown();
            adapter = null;
        }
    });

    it(
        'ingests a day and answers a query',
        async () => {
            stub = new StubSynthesis();
            adapter = createMempalaceAdapter({
                mempalaceCommand: command!,
                synthesisModelImpl: stub,
                searchK: 5,
            });
            await adapter.setup();
            await adapter.ingestDay(
                1,
                '# Day 1\n\nMet with Sarah about the Q3 board memo. She wants a draft by Friday.',
                metaFor(1),
            );
            await adapter.finalizeIngestion();

            const detail = await adapter.queryDetail!('Who is drafting the Q3 board memo?');
            expect(detail.answer).toBe('stub answer');
            expect(stub.calls).toHaveLength(1);
            // The synthesis prompt should include at least one retrieved excerpt
            // (mempalace indexes synchronously; reconnect flushes the HNSW cache).
            expect(stub.calls[0]!.user).toMatch(/Memory excerpts:/);
        },
        TEST_TIMEOUT,
    );

    it(
        'is idempotent on duplicate add_drawer calls',
        async () => {
            stub = new StubSynthesis();
            adapter = createMempalaceAdapter({
                mempalaceCommand: command!,
                synthesisModelImpl: stub,
            });
            await adapter.setup();
            const content = '# Day 2\n\nFollowed up on the SOC 2 audit with vendor.';
            await adapter.ingestDay(2, content, metaFor(2));
            // Same wing/room/content → mempalace returns reason: already_exists.
            await expect(adapter.ingestDay(2, content, metaFor(2))).resolves.toBeUndefined();
            await adapter.finalizeIngestion();
        },
        TEST_TIMEOUT,
    );
});
