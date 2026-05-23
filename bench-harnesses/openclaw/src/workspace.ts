/**
 * Workspace lifecycle: create/destroy a temp directory matching the layout
 * OpenClaw expects (MEMORY.md stub + memory/<date>.md files), and write
 * day files into it.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Workspace {
    /** Root of the temp workspace. */
    rootDir: string;
    /** Where day files are written: `<rootDir>/memory`. */
    memoryDir: string;
    /** Where the SQLite index is written by OpenClaw on sync. */
    indexPath: string;
}

const MEMORY_STUB = '# Memory\n\nWorkspace root memory note (recall-bench harness).\n';

/**
 * Allocate a fresh temp workspace under `tmpdir()`. The path includes a UUID
 * so concurrent harness workers don't collide. Creates `MEMORY.md` and the
 * empty `memory/` subdir.
 */
export async function createWorkspace(prefix = 'recall-oc-'): Promise<Workspace> {
    const rootDir = join(tmpdir(), `${prefix}${randomUUID()}`);
    const memoryDir = join(rootDir, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(rootDir, 'MEMORY.md'), MEMORY_STUB, 'utf8');
    return {
        rootDir,
        memoryDir,
        indexPath: join(rootDir, 'index.sqlite'),
    };
}

/**
 * Write a single day's content as `memory/<date>.md`.
 *
 * @param ws - workspace allocated via `createWorkspace`
 * @param isoDate - ISO 8601 date string (e.g., `2026-01-01`); used as the filename
 * @param content - verbatim Markdown for the day
 */
export async function writeDayFile(ws: Workspace, isoDate: string, content: string): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
        throw new Error(`writeDayFile: expected ISO date YYYY-MM-DD, got "${isoDate}"`);
    }
    await writeFile(join(ws.memoryDir, `${isoDate}.md`), content, 'utf8');
}

/**
 * Delete the workspace recursively. Safe to call multiple times.
 */
export async function destroyWorkspace(ws: Workspace): Promise<void> {
    await rm(ws.rootDir, { recursive: true, force: true });
}
