import { describe, it, expect } from 'vitest';
import { stat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspace, destroyWorkspace, writeDayFile } from '../src/workspace.js';

describe('workspace', () => {
    it('creates root, memory dir, and MEMORY.md stub', async () => {
        const ws = await createWorkspace();
        try {
            const rootStat = await stat(ws.rootDir);
            expect(rootStat.isDirectory()).toBe(true);

            const memStat = await stat(ws.memoryDir);
            expect(memStat.isDirectory()).toBe(true);

            const stub = await readFile(join(ws.rootDir, 'MEMORY.md'), 'utf8');
            expect(stub).toContain('# Memory');

            // memory/ starts empty
            const entries = await readdir(ws.memoryDir);
            expect(entries).toEqual([]);

            // indexPath sits under root but is not pre-created (OpenClaw makes it on sync)
            expect(ws.indexPath).toBe(join(ws.rootDir, 'index.sqlite'));
        } finally {
            await destroyWorkspace(ws);
        }
    });

    it('writes day files using ISO date as filename', async () => {
        const ws = await createWorkspace();
        try {
            await writeDayFile(ws, '2026-03-15', '# Day content\n\nSomething happened.');
            const written = await readFile(join(ws.memoryDir, '2026-03-15.md'), 'utf8');
            expect(written).toBe('# Day content\n\nSomething happened.');
        } finally {
            await destroyWorkspace(ws);
        }
    });

    it('rejects non-ISO date filenames', async () => {
        const ws = await createWorkspace();
        try {
            await expect(writeDayFile(ws, '2026/03/15', 'x')).rejects.toThrow(/ISO date/);
            await expect(writeDayFile(ws, 'day-1', 'x')).rejects.toThrow(/ISO date/);
        } finally {
            await destroyWorkspace(ws);
        }
    });

    it('destroyWorkspace removes the entire tree', async () => {
        const ws = await createWorkspace();
        await writeDayFile(ws, '2026-01-01', 'content');
        await destroyWorkspace(ws);
        await expect(stat(ws.rootDir)).rejects.toThrow();
    });

    it('destroyWorkspace is idempotent', async () => {
        const ws = await createWorkspace();
        await destroyWorkspace(ws);
        // Second call must not throw.
        await destroyWorkspace(ws);
    });

    it('allocates unique paths for concurrent workspaces', async () => {
        const a = await createWorkspace();
        const b = await createWorkspace();
        try {
            expect(a.rootDir).not.toBe(b.rootDir);
        } finally {
            await destroyWorkspace(a);
            await destroyWorkspace(b);
        }
    });
});
