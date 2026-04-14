/**
 * Search signal logger for the dreaming system.
 *
 * Appends search operations to a JSONL log file under .dreams/.
 * Supports reading, parsing, and monthly rotation of log files.
 */

import * as path from "path";
import type { FileStorage } from "./interfaces/storage.js";
import type { SearchLogEntry } from "./dreaming-config.js";

export class SearchLogger {
    private readonly _root: string;
    private readonly _storage: FileStorage;

    constructor(memoryRoot: string, storage: FileStorage) {
        this._root = memoryRoot;
        this._storage = storage;
    }

    // ─── Paths ───────────────────────────────────────────

    private _dreamsDir(): string {
        return path.join(this._root, ".dreams");
    }

    private _logPath(): string {
        return path.join(this._dreamsDir(), "search-log.jsonl");
    }

    private _archivePath(yearMonth: string): string {
        return path.join(this._dreamsDir(), `search-log-${yearMonth}.jsonl`);
    }

    private _candidatesPath(): string {
        return path.join(this._dreamsDir(), "candidates.json");
    }

    private _statePath(): string {
        return path.join(this._dreamsDir(), "dream-state.json");
    }

    // ─── Initialization ──────────────────────────────────

    async initialize(): Promise<void> {
        const dir = this._dreamsDir();
        if (!(await this._storage.pathExists(dir))) {
            await this._storage.createFolder(dir);
        }
    }

    // ─── Log Writing ─────────────────────────────────────

    /**
     * Append a search log entry.
     */
    async logSearch(
        query: string,
        results: Array<{ uri: string; score: number }>,
        topK: number,
    ): Promise<void> {
        await this.initialize();

        const entry: SearchLogEntry = {
            ts: new Date().toISOString(),
            query,
            results: results.map((r) => r.uri),
            scores: results.map((r) => Math.round(r.score * 1000) / 1000),
            topK,
            returned: results.length,
        };

        const line = JSON.stringify(entry) + "\n";
        const logPath = this._logPath();

        if (await this._storage.pathExists(logPath)) {
            const existing = await this._storage.readFile(logPath);
            const updated = existing.toString("utf-8") + line;
            await this._storage.upsertFile(logPath, updated);
        } else {
            await this._storage.upsertFile(logPath, line);
        }
    }

    // ─── Log Reading ─────────────────────────────────────

    /**
     * Read all entries from the current search log.
     */
    async readLog(): Promise<SearchLogEntry[]> {
        const logPath = this._logPath();
        if (!(await this._storage.pathExists(logPath))) return [];

        const raw = await this._storage.readFile(logPath);
        return parseJsonl(raw.toString("utf-8"));
    }

    /**
     * Read entries from a specific time window (days back from now).
     */
    async readLogWindow(windowDays: number): Promise<SearchLogEntry[]> {
        const all = await this.readLog();
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - windowDays);
        const cutoffIso = cutoff.toISOString();
        return all.filter((e) => e.ts >= cutoffIso);
    }

    // ─── Log Rotation ────────────────────────────────────

    /**
     * Rotate old entries out of the current log into monthly archives.
     * Entries from before the current month are moved to search-log-YYYY-MM.jsonl.
     */
    async rotateLog(): Promise<{ archived: number; remaining: number }> {
        const entries = await this.readLog();
        if (entries.length === 0) return { archived: 0, remaining: 0 };

        const now = new Date();
        const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

        // Partition entries by month
        const byMonth = new Map<string, SearchLogEntry[]>();
        const current: SearchLogEntry[] = [];

        for (const entry of entries) {
            const entryMonth = entry.ts.substring(0, 7); // "YYYY-MM"
            if (entryMonth === currentYearMonth) {
                current.push(entry);
            } else {
                if (!byMonth.has(entryMonth)) byMonth.set(entryMonth, []);
                byMonth.get(entryMonth)!.push(entry);
            }
        }

        let archived = 0;

        // Write archive files
        for (const [month, monthEntries] of byMonth) {
            const archivePath = this._archivePath(month);
            let existing = "";
            if (await this._storage.pathExists(archivePath)) {
                const buf = await this._storage.readFile(archivePath);
                existing = buf.toString("utf-8");
            }
            const newLines = monthEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
            await this._storage.upsertFile(archivePath, existing + newLines);
            archived += monthEntries.length;
        }

        // Rewrite current log with only current month's entries
        const logPath = this._logPath();
        if (current.length === 0) {
            await this._storage.upsertFile(logPath, "");
        } else {
            const lines = current.map((e) => JSON.stringify(e)).join("\n") + "\n";
            await this._storage.upsertFile(logPath, lines);
        }

        return { archived, remaining: current.length };
    }

    // ─── Candidates Persistence ──────────────────────────

    /**
     * Read carry-over candidates from the last session.
     */
    async readCandidates(): Promise<unknown[]> {
        const p = this._candidatesPath();
        if (!(await this._storage.pathExists(p))) return [];
        try {
            const buf = await this._storage.readFile(p);
            return JSON.parse(buf.toString("utf-8"));
        } catch {
            return [];
        }
    }

    /**
     * Write carry-over candidates for the next session.
     */
    async writeCandidates(candidates: unknown[]): Promise<void> {
        await this.initialize();
        await this._storage.upsertFile(
            this._candidatesPath(),
            JSON.stringify(candidates, null, 2),
        );
    }

    // ─── Dream State ─────────────────────────────────────

    async readState(): Promise<Record<string, unknown>> {
        const p = this._statePath();
        if (!(await this._storage.pathExists(p))) return {};
        try {
            const buf = await this._storage.readFile(p);
            return JSON.parse(buf.toString("utf-8"));
        } catch {
            return {};
        }
    }

    async writeState(state: Record<string, unknown>): Promise<void> {
        await this.initialize();
        await this._storage.upsertFile(
            this._statePath(),
            JSON.stringify(state, null, 2),
        );
    }
}

// ─── Helpers ─────────────────────────────────────────────

function parseJsonl(text: string): SearchLogEntry[] {
    const entries: SearchLogEntry[] = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            entries.push(JSON.parse(trimmed));
        } catch {
            // Skip malformed lines
        }
    }
    return entries;
}
