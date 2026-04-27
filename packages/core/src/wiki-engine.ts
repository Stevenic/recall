import * as path from "path";
import matter from "gray-matter";
import type { FileStorage } from "./interfaces/storage.js";
import {
    DEFAULT_WIKI_CONFIG,
    isStub,
    type ResolvedWikiTarget,
    type SharedWikiConfig,
    type WikiCategory,
    type WikiConfig,
    type WikiLinkRef,
    type WikiPage,
    type WikiPageStubInput,
    type WikiTarget,
} from "./wiki-types.js";
import { isStubbable } from "./wiki-templates.js";

const WIKI_SUBDIR = path.join("memory", "wiki");
const RESERVED_SLUGS = new Set(["index"]);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LINK_PATTERN = /\[\[([^\]\n]+?)\]\]/g;

/**
 * Wiki page CRUD over one or more wiki targets (the agent's private wiki and
 * any configured shared wikis). Phase A surface — read/write/list/stub/append
 * plus link parsing and `index.md` regeneration. Synthesis (`rebuild`),
 * lint, merge/rename, and migration land in later phases.
 */
export class WikiEngine {
    private readonly _privateRoot: string;
    private readonly _storage: FileStorage;
    private readonly _config: Required<
        Omit<WikiConfig, "shared" | "enabled">
    > & {
        enabled: boolean;
        shared: SharedWikiConfig[];
    };
    private readonly _sharedByName: Map<string, SharedWikiConfig>;

    constructor(
        memoryRoot: string,
        storage: FileStorage,
        config?: WikiConfig,
    ) {
        this._privateRoot = memoryRoot;
        this._storage = storage;
        this._config = {
            ...DEFAULT_WIKI_CONFIG,
            ...config,
            shared: config?.shared ?? [],
        };
        this._sharedByName = new Map();
        for (const s of this._config.shared) {
            if (s.name === "private") {
                throw new Error(
                    `Shared wiki name "private" is reserved.`,
                );
            }
            if (this._sharedByName.has(s.name)) {
                throw new Error(
                    `Duplicate shared wiki name "${s.name}".`,
                );
            }
            this._sharedByName.set(s.name, s);
        }
    }

    get config(): Readonly<typeof this._config> {
        return this._config;
    }

    /** True when the wiki layer is enabled in config. */
    get enabled(): boolean {
        return this._config.enabled;
    }

    /**
     * Ensure the private wiki directory exists, plus any member-role shared
     * wiki directories. Reader-role shared wikis are managed externally and
     * are not auto-created.
     */
    async initialize(): Promise<void> {
        for (const t of this.resolveTargets()) {
            if (t.role === "member") {
                await this._storage.createFolder(t.wikiDir);
            }
        }
    }

    /** List configured wiki targets — `"private"` plus each shared wiki. */
    targets(): WikiTarget[] {
        return ["private", ...this._config.shared.map((s) => s.name)];
    }

    /** Resolved metadata for each configured target (path, role). */
    resolveTargets(): ResolvedWikiTarget[] {
        const resolved: ResolvedWikiTarget[] = [
            {
                name: "private",
                root: this._privateRoot,
                wikiDir: path.join(this._privateRoot, WIKI_SUBDIR),
                role: "member",
            },
        ];
        for (const s of this._config.shared) {
            const root = path.isAbsolute(s.path)
                ? s.path
                : path.resolve(this._privateRoot, s.path);
            resolved.push({
                name: s.name,
                root,
                wikiDir: path.join(root, WIKI_SUBDIR),
                role: s.role,
            });
        }
        return resolved;
    }

    /** Read a wiki page by slug. Returns null when the page doesn't exist. */
    async read(
        slug: string,
        target: WikiTarget = "private",
    ): Promise<WikiPage | null> {
        validateSlug(slug);
        const filePath = this._pagePath(slug, target);
        if (!(await this._storage.pathExists(filePath))) return null;
        const buf = await this._storage.readFile(filePath);
        return parseWikiPage(buf.toString("utf-8"), slug);
    }

    /**
     * Write or overwrite a wiki page. Refuses on `reader` role. Validates that
     * `slug` matches the file basename and that frontmatter fields are well-formed.
     */
    async write(
        page: WikiPage,
        target: WikiTarget = "private",
    ): Promise<void> {
        this._assertWritable(target);
        validateSlug(page.slug);
        validatePage(page);
        const filePath = this._pagePath(page.slug, target);
        const content = serializeWikiPage(page);
        await this._storage.upsertFile(filePath, content);
    }

    /**
     * Create a stub page from a category template. Single source, `confidence: low`.
     * Refuses if the slug already exists (use {@link append} for additions).
     */
    async stub(input: WikiPageStubInput): Promise<WikiPage> {
        const target = input.target ?? "private";
        this._assertWritable(target);
        validateSlug(input.slug);
        if (!isStubbable(input.category)) {
            throw new Error(
                `Category "${input.category}" is synthesis-only and cannot be stubbed by an agent.`,
            );
        }
        if (await this.read(input.slug, target)) {
            throw new Error(
                `Wiki page "${input.slug}" already exists. Use append() to add a source.`,
            );
        }
        const today = input.created ?? todayIso();
        const page: WikiPage = {
            slug: input.slug,
            name: input.name,
            description: input.description,
            category: input.category,
            created: today,
            updated: today,
            sources: [input.source],
            related: input.related ?? [],
            confidence: "low",
            body: ensureTrailingNewline(input.body),
        };
        await this.write(page, target);
        return page;
    }

    /**
     * Append a new source + body fragment to an existing page. Advances `updated`.
     * Refuses on `reader` role; throws if the page doesn't exist.
     */
    async append(
        slug: string,
        source: string,
        bodyFragment: string,
        target: WikiTarget = "private",
    ): Promise<WikiPage> {
        this._assertWritable(target);
        const existing = await this.read(slug, target);
        if (!existing) {
            throw new Error(
                `Wiki page "${slug}" does not exist (target: ${target}).`,
            );
        }
        if (!existing.sources.includes(source)) {
            existing.sources.push(source);
        }
        const trimmedFragment = bodyFragment.trim();
        if (trimmedFragment.length > 0) {
            const sep = existing.body.endsWith("\n\n") ? "" : "\n\n";
            existing.body =
                ensureTrailingNewline(
                    existing.body.replace(/\s+$/, "") + sep + trimmedFragment,
                );
        }
        existing.updated = todayIso();
        await this.write(existing, target);
        return existing;
    }

    /** List wiki page slugs for a single target (sorted). */
    async list(target: WikiTarget = "private"): Promise<string[]> {
        const resolved = this._resolveOne(target);
        if (!(await this._storage.pathExists(resolved.wikiDir))) return [];
        const files = await this._storage.listFiles(resolved.wikiDir, "files");
        return files
            .map((f) => f.name)
            .filter(
                (name) =>
                    name.endsWith(".md") &&
                    !RESERVED_SLUGS.has(name.replace(/\.md$/, "")),
            )
            .map((name) => name.replace(/\.md$/, ""))
            .sort();
    }

    /** List slugs across every configured target, tagged with origin. */
    async listAll(): Promise<{ target: WikiTarget; slug: string }[]> {
        const out: { target: WikiTarget; slug: string }[] = [];
        for (const t of this.targets()) {
            const slugs = await this.list(t);
            for (const slug of slugs) out.push({ target: t, slug });
        }
        return out;
    }

    /**
     * Regenerate `index.md` for a single target. Pages are grouped by category
     * with a trailing "Recent Updates" section sorted by `updated` desc.
     */
    async rebuildIndex(target: WikiTarget = "private"): Promise<void> {
        const resolved = this._resolveOne(target);
        const slugs = await this.list(target);
        const pages: WikiPage[] = [];
        for (const slug of slugs) {
            const page = await this.read(slug, target);
            if (page) pages.push(page);
        }
        const content = renderIndex(pages);
        await this._storage.upsertFile(
            path.join(resolved.wikiDir, "index.md"),
            content,
        );
    }

    /** Parse `[[slug]]` and `[[name:slug]]` references from a body. */
    static parseLinks(body: string): WikiLinkRef[] {
        return parseWikiLinks(body);
    }

    /** Resolve a `[[slug]]` link relative to the target the link was found in. */
    static resolveLink(
        link: WikiLinkRef,
        sourceTarget: WikiTarget,
    ): { target: WikiTarget; slug: string } {
        if (link.target === null) {
            return { target: sourceTarget, slug: link.slug };
        }
        if (link.target === "private") {
            throw new Error(
                `Qualified [[private:...]] references are not addressable from shared pages.`,
            );
        }
        return { target: link.target, slug: link.slug };
    }

    // --- internals ---

    private _pagePath(slug: string, target: WikiTarget): string {
        const resolved = this._resolveOne(target);
        return path.join(resolved.wikiDir, `${slug}.md`);
    }

    private _resolveOne(target: WikiTarget): ResolvedWikiTarget {
        if (target === "private") {
            return {
                name: "private",
                root: this._privateRoot,
                wikiDir: path.join(this._privateRoot, WIKI_SUBDIR),
                role: "member",
            };
        }
        const shared = this._sharedByName.get(target);
        if (!shared) {
            throw new Error(
                `Unknown wiki target "${target}". Configured: ${this.targets().join(", ")}`,
            );
        }
        const root = path.isAbsolute(shared.path)
            ? shared.path
            : path.resolve(this._privateRoot, shared.path);
        return {
            name: shared.name,
            root,
            wikiDir: path.join(root, WIKI_SUBDIR),
            role: shared.role,
        };
    }

    private _assertWritable(target: WikiTarget): void {
        const resolved = this._resolveOne(target);
        if (resolved.role === "reader") {
            throw new Error(
                `Wiki target "${target}" is read-only for this agent.`,
            );
        }
    }
}

// --- pure helpers ---

export function validateSlug(slug: string): void {
    if (!slug || typeof slug !== "string") {
        throw new Error("Slug must be a non-empty string.");
    }
    if (RESERVED_SLUGS.has(slug)) {
        throw new Error(`Slug "${slug}" is reserved.`);
    }
    if (!SLUG_PATTERN.test(slug)) {
        throw new Error(
            `Slug "${slug}" must be lowercase ASCII with hyphen-separated words.`,
        );
    }
}

function validatePage(page: WikiPage): void {
    if (!page.name || typeof page.name !== "string") {
        throw new Error(`Wiki page "${page.slug}" missing required field: name`);
    }
    if (!page.description || typeof page.description !== "string") {
        throw new Error(
            `Wiki page "${page.slug}" missing required field: description`,
        );
    }
    if (!page.category) {
        throw new Error(
            `Wiki page "${page.slug}" missing required field: category`,
        );
    }
    if (!Array.isArray(page.sources) || page.sources.length === 0) {
        throw new Error(
            `Wiki page "${page.slug}" must have at least one source.`,
        );
    }
}

/** Parse a wiki page file (with frontmatter) into a {@link WikiPage}. */
export function parseWikiPage(content: string, expectedSlug: string): WikiPage {
    const parsed = matter(content);
    const data = parsed.data as Record<string, unknown>;
    const slug = (data.slug as string | undefined) ?? expectedSlug;
    const category = data.category as WikiCategory | undefined;
    if (!category) {
        throw new Error(`Wiki page "${slug}" missing category in frontmatter.`);
    }
    const sources = Array.isArray(data.sources)
        ? (data.sources as string[])
        : [];
    const related = Array.isArray(data.related)
        ? (data.related as string[])
        : [];
    const contradicts = Array.isArray(data.contradicts)
        ? (data.contradicts as string[])
        : undefined;
    return {
        slug,
        name: (data.name as string | undefined) ?? slug,
        description: (data.description as string | undefined) ?? "",
        category,
        created:
            (data.created as string | undefined) ??
            (data.updated as string | undefined) ??
            todayIso(),
        updated:
            (data.updated as string | undefined) ??
            (data.created as string | undefined) ??
            todayIso(),
        sources,
        related,
        confidence: data.confidence as WikiPage["confidence"],
        contradicts,
        redirectTo: data.redirect_to as string | undefined,
        body: parsed.content,
    };
}

/** Serialize a {@link WikiPage} to a markdown file with frontmatter. */
export function serializeWikiPage(page: WikiPage): string {
    const fm: Record<string, unknown> = {
        name: page.name,
        description: page.description,
        type: "wiki",
        category: page.category,
        slug: page.slug,
        created: page.created,
        updated: page.updated,
        sources: page.sources,
    };
    if (page.related.length > 0) fm.related = page.related;
    if (page.confidence) fm.confidence = page.confidence;
    if (page.contradicts && page.contradicts.length > 0) {
        fm.contradicts = page.contradicts;
    }
    if (page.redirectTo) fm.redirect_to = page.redirectTo;
    return matter.stringify(ensureTrailingNewline(page.body), fm);
}

export function parseWikiLinks(body: string): WikiLinkRef[] {
    const refs: WikiLinkRef[] = [];
    LINK_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LINK_PATTERN.exec(body)) !== null) {
        const inner = match[1];
        const [linkPart, displayPart] = splitOnce(inner, "|");
        const [targetPart, slugPart] = splitOnTarget(linkPart);
        const slug = slugPart.trim();
        if (!slug || !SLUG_PATTERN.test(slug)) continue;
        if (targetPart && !isValidTargetName(targetPart)) continue;
        refs.push({
            target: targetPart,
            slug,
            display: displayPart ? displayPart.trim() : null,
            start: match.index,
            end: match.index + match[0].length,
        });
    }
    return refs;
}

function splitOnce(input: string, sep: string): [string, string | null] {
    const idx = input.indexOf(sep);
    if (idx === -1) return [input, null];
    return [input.slice(0, idx), input.slice(idx + 1)];
}

function splitOnTarget(input: string): [string | null, string] {
    const idx = input.indexOf(":");
    if (idx === -1) return [null, input];
    return [input.slice(0, idx).trim(), input.slice(idx + 1).trim()];
}

function isValidTargetName(name: string): boolean {
    return /^[a-zA-Z0-9_-]+$/.test(name);
}

function renderIndex(pages: WikiPage[]): string {
    const groups: Record<WikiCategory, WikiPage[]> = {
        entity: [],
        concept: [],
        project: [],
        reference: [],
        theme: [],
    };
    for (const page of pages) {
        groups[page.category].push(page);
    }
    const lines: string[] = [];
    lines.push("---");
    lines.push("type: wiki-index");
    lines.push(`generated: ${todayIso()}`);
    lines.push(`total: ${pages.length}`);
    lines.push("---");
    lines.push("");
    lines.push("# Wiki Index");
    lines.push("");

    const sectionLabels: Record<WikiCategory, string> = {
        entity: "Entities",
        concept: "Concepts",
        project: "Projects",
        reference: "References",
        theme: "Themes",
    };
    for (const cat of [
        "entity",
        "concept",
        "project",
        "reference",
        "theme",
    ] as WikiCategory[]) {
        const items = groups[cat];
        if (items.length === 0) continue;
        lines.push(`## ${sectionLabels[cat]} (${items.length})`);
        for (const p of items.sort((a, b) => a.slug.localeCompare(b.slug))) {
            const stubMark = isStub(p) ? " (stub)" : "";
            lines.push(`- [[${p.slug}]] — ${p.description}${stubMark}`);
        }
        lines.push("");
    }

    const recent = [...pages]
        .sort((a, b) => b.updated.localeCompare(a.updated))
        .slice(0, 10);
    if (recent.length > 0) {
        lines.push("## Recent Updates");
        for (const p of recent) {
            lines.push(
                `- ${p.updated}: [[${p.slug}]] (${p.sources.length} source${p.sources.length === 1 ? "" : "s"})`,
            );
        }
        lines.push("");
    }
    return lines.join("\n");
}

function ensureTrailingNewline(s: string): string {
    return s.endsWith("\n") ? s : s + "\n";
}

function todayIso(): string {
    return new Date().toISOString().split("T")[0];
}
