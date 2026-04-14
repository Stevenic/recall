import * as path from "path";
import matter from "gray-matter";
import type { FileStorage } from "./interfaces/storage.js";

export interface ListOptions {
    after?: string;
    before?: string;
}

export interface MemoryFileManifest {
    dailies: string[];
    weeklies: string[];
    monthlies: string[];
    typedMemories: string[];
    hasWisdom: boolean;
}

/**
 * CRUD operations for daily, weekly, monthly, wisdom, and typed memory files.
 * All I/O goes through the FileStorage abstraction.
 */
export class MemoryFiles {
    private readonly _root: string;
    private readonly _storage: FileStorage;

    constructor(memoryRoot: string, storage: FileStorage) {
        this._root = memoryRoot;
        this._storage = storage;
    }

    get root(): string {
        return this._root;
    }

    // --- Daily logs ---

    private _dailyPath(date: string): string {
        return path.join(this._root, "memory", `${date}.md`);
    }

    async readDaily(date: string): Promise<string | null> {
        const p = this._dailyPath(date);
        if (!(await this._storage.pathExists(p))) return null;
        const buf = await this._storage.readFile(p);
        return buf.toString("utf-8");
    }

    async writeDaily(date: string, content: string): Promise<void> {
        await this._storage.upsertFile(this._dailyPath(date), content);
    }

    async appendDaily(date: string, entry: string): Promise<void> {
        const existing = await this.readDaily(date);
        if (existing) {
            const updated = existing.trimEnd() + "\n\n" + entry + "\n";
            await this.writeDaily(date, updated);
        } else {
            const content = `---\ntype: daily\n---\n\n## ${date}\n\n${entry}\n`;
            await this.writeDaily(date, content);
        }
    }

    async deleteDaily(date: string): Promise<void> {
        const p = this._dailyPath(date);
        if (await this._storage.pathExists(p)) {
            await this._storage.deleteFile(p);
        }
    }

    async listDailies(options?: ListOptions): Promise<string[]> {
        return this._listByPattern("memory", /^\d{4}-\d{2}-\d{2}\.md$/, options);
    }

    // --- Weekly summaries ---

    private _weeklyPath(week: string): string {
        return path.join(this._root, "memory", "weekly", `${week}.md`);
    }

    async readWeekly(week: string): Promise<string | null> {
        const p = this._weeklyPath(week);
        if (!(await this._storage.pathExists(p))) return null;
        const buf = await this._storage.readFile(p);
        return buf.toString("utf-8");
    }

    async writeWeekly(week: string, content: string): Promise<void> {
        await this._storage.upsertFile(this._weeklyPath(week), content);
    }

    async deleteWeekly(week: string): Promise<void> {
        const p = this._weeklyPath(week);
        if (await this._storage.pathExists(p)) {
            await this._storage.deleteFile(p);
        }
    }

    async listWeeklies(options?: ListOptions): Promise<string[]> {
        return this._listByPattern(
            path.join("memory", "weekly"),
            /^\d{4}-W\d{2}\.md$/,
            options,
        );
    }

    // --- Monthly summaries ---

    private _monthlyPath(month: string): string {
        return path.join(this._root, "memory", "monthly", `${month}.md`);
    }

    async readMonthly(month: string): Promise<string | null> {
        const p = this._monthlyPath(month);
        if (!(await this._storage.pathExists(p))) return null;
        const buf = await this._storage.readFile(p);
        return buf.toString("utf-8");
    }

    async writeMonthly(month: string, content: string): Promise<void> {
        await this._storage.upsertFile(this._monthlyPath(month), content);
    }

    async deleteMonthly(month: string): Promise<void> {
        const p = this._monthlyPath(month);
        if (await this._storage.pathExists(p)) {
            await this._storage.deleteFile(p);
        }
    }

    async listMonthlies(options?: ListOptions): Promise<string[]> {
        return this._listByPattern(
            path.join("memory", "monthly"),
            /^\d{4}-\d{2}\.md$/,
            options,
        );
    }

    // --- Wisdom ---

    private _wisdomPath(): string {
        return path.join(this._root, "WISDOM.md");
    }

    async readWisdom(): Promise<string | null> {
        const p = this._wisdomPath();
        if (!(await this._storage.pathExists(p))) return null;
        const buf = await this._storage.readFile(p);
        return buf.toString("utf-8");
    }

    async writeWisdom(content: string): Promise<void> {
        await this._storage.upsertFile(this._wisdomPath(), content);
    }

    // --- Typed memories ---

    private _typedPath(filename: string): string {
        return path.join(this._root, "memory", filename);
    }

    async readTypedMemory(filename: string): Promise<string | null> {
        const p = this._typedPath(filename);
        if (!(await this._storage.pathExists(p))) return null;
        const buf = await this._storage.readFile(p);
        return buf.toString("utf-8");
    }

    async writeTypedMemory(
        filename: string,
        content: string,
    ): Promise<void> {
        await this._storage.upsertFile(this._typedPath(filename), content);
    }

    async deleteTypedMemory(filename: string): Promise<void> {
        const p = this._typedPath(filename);
        if (await this._storage.pathExists(p)) {
            await this._storage.deleteFile(p);
        }
    }

    async listTypedMemories(): Promise<string[]> {
        // Typed memories are non-date files in memory/ (excluding subdirs)
        const memDir = path.join(this._root, "memory");
        if (!(await this._storage.pathExists(memDir))) return [];
        const files = await this._storage.listFiles(memDir, "files");
        return files
            .map((f) => f.name)
            .filter(
                (name) =>
                    name.endsWith(".md") &&
                    !name.match(/^\d{4}-\d{2}-\d{2}\.md$/),
            )
            .sort();
    }

    // --- Bulk ---

    async listAll(): Promise<MemoryFileManifest> {
        const [dailies, weeklies, monthlies, typedMemories, hasWisdom] =
            await Promise.all([
                this.listDailies(),
                this.listWeeklies(),
                this.listMonthlies(),
                this.listTypedMemories(),
                this._storage.pathExists(this._wisdomPath()),
            ]);
        return { dailies, weeklies, monthlies, typedMemories, hasWisdom };
    }

    // --- Dream files ---

    async listInsights(): Promise<string[]> {
        const dir = path.join(this._root, "memory", "dreams", "insights");
        if (!(await this._storage.pathExists(dir))) return [];
        const files = await this._storage.listFiles(dir, "files");
        return files
            .map((f) => f.name)
            .filter((name) => name.endsWith(".md"))
            .sort();
    }

    async listContradictions(): Promise<string[]> {
        const dir = path.join(this._root, "memory", "dreams", "contradictions");
        if (!(await this._storage.pathExists(dir))) return [];
        const files = await this._storage.listFiles(dir, "files");
        return files
            .map((f) => f.name)
            .filter((name) => name.endsWith(".md"))
            .sort();
    }

    async readDreamFile(relativePath: string): Promise<string | null> {
        const p = path.join(this._root, relativePath);
        if (!(await this._storage.pathExists(p))) return null;
        const buf = await this._storage.readFile(p);
        return buf.toString("utf-8");
    }

    /**
     * Ensure the directory structure exists.
     */
    async initialize(): Promise<void> {
        await this._storage.createFolder(path.join(this._root, "memory"));
        await this._storage.createFolder(
            path.join(this._root, "memory", "weekly"),
        );
        await this._storage.createFolder(
            path.join(this._root, "memory", "monthly"),
        );
        await this._storage.createFolder(
            path.join(this._root, "memory", "dreams"),
        );
        await this._storage.createFolder(
            path.join(this._root, "memory", "dreams", "insights"),
        );
        await this._storage.createFolder(
            path.join(this._root, "memory", "dreams", "contradictions"),
        );
    }

    /**
     * Parse YAML frontmatter from a memory file's content.
     * Returns the frontmatter data and the body text (without frontmatter).
     */
    parseFrontmatter(content: string): { data: Record<string, any>; body: string } {
        const parsed = matter(content);
        return { data: parsed.data, body: parsed.content };
    }

    /**
     * Extract pointer URIs from a parent node's frontmatter.
     * Returns empty array if no pointers found.
     */
    parsePointers(content: string): string[] {
        const { data } = this.parseFrontmatter(content);
        if (Array.isArray(data.pointers)) {
            return data.pointers;
        }
        return [];
    }

    /**
     * Extract salience weights from a parent node's frontmatter.
     * Returns empty object if no salience found.
     */
    parseSalience(content: string): Record<string, number> {
        const { data } = this.parseFrontmatter(content);
        if (data.salience && typeof data.salience === "object") {
            return data.salience as Record<string, number>;
        }
        return {};
    }

    // --- Helpers ---

    private async _listByPattern(
        subdir: string,
        pattern: RegExp,
        options?: ListOptions,
    ): Promise<string[]> {
        const dir = path.join(this._root, subdir);
        if (!(await this._storage.pathExists(dir))) return [];
        const files = await this._storage.listFiles(dir, "files");
        let names = files
            .map((f) => f.name)
            .filter((name) => name.endsWith(".md") && pattern.test(name))
            .map((name) => name.replace(/\.md$/, ""))
            .sort();

        if (options?.after) {
            names = names.filter((n) => n >= options.after!);
        }
        if (options?.before) {
            names = names.filter((n) => n <= options.before!);
        }

        return names;
    }
}
