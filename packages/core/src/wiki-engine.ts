import * as path from "path";
import matter from "gray-matter";
import type { FileStorage } from "./interfaces/storage.js";
import type { MemoryModel } from "./interfaces/model.js";
import {
    DEFAULT_WIKI_CONFIG,
    isStub,
    type ResolvedWikiTarget,
    type SharedWikiConfig,
    type WikiCategory,
    type WikiConfig,
    type WikiLinkRef,
    type WikiLintReport,
    type WikiPage,
    type WikiPageStubInput,
    type WikiRebuildReport,
    type WikiTarget,
    type WikiTypedMigrationReport,
} from "./wiki-types.js";
import { isStubbable } from "./wiki-templates.js";

export interface WikiEngineDeps {
    /** LLM model used for `rebuild()` synthesis. Optional; rebuild throws without one. */
    model?: MemoryModel;
}

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
    private readonly _model: MemoryModel | undefined;
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
        deps?: WikiEngineDeps,
    ) {
        this._privateRoot = memoryRoot;
        this._storage = storage;
        this._model = deps?.model;
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
     * `slug` matches the file basename and that frontmatter fields are
     * well-formed. Creates the wiki directory on demand so callers who haven't
     * gone through `initialize()` (typically programmatic use) still succeed
     * on backends that don't auto-create parent dirs (e.g. LocalFileStorage).
     */
    async write(
        page: WikiPage,
        target: WikiTarget = "private",
    ): Promise<void> {
        this._assertWritable(target);
        validateSlug(page.slug);
        validatePage(page);
        const resolved = this._resolveOne(target);
        await this._storage.createFolder(resolved.wikiDir);
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

    /**
     * Validate the private wiki (and shared wikis when requested). Detects:
     * broken `[[links]]`, orphans (no inbound link), stale pages (older than
     * `stalenessThresholdDays`), pages whose filename slug disagrees with
     * frontmatter, contradiction loops (A↔B), and `[[name:slug]]` qualified
     * references to unconfigured wiki targets.
     */
    async lint(opts?: { includeShared?: boolean }): Promise<WikiLintReport> {
        const includeShared = opts?.includeShared === true;
        const targets: WikiTarget[] = ["private"];
        if (includeShared) {
            for (const s of this._config.shared) targets.push(s.name);
        }

        const report: WikiLintReport = {
            brokenLinks: [],
            orphans: [],
            stalePages: [],
            missingCategory: [],
            slugDrift: [],
            contradictionLoops: [],
            unknownTargets: [],
            scanned: {},
        };

        // Load every page from every target so we can resolve links and
        // detect cross-page issues. Map keyed by `${target}:${slug}` -> page.
        const pages = new Map<string, WikiPage>();
        const inbound = new Map<string, Set<string>>();
        for (const t of targets) {
            const resolved = this._resolveOne(t);
            const slugs = await this.list(t);
            report.scanned[t] = slugs.length;
            for (const slug of slugs) {
                const key = `${t}:${slug}`;
                // Read via raw file path so we can detect slug drift.
                const filePath = path.join(resolved.wikiDir, `${slug}.md`);
                if (!(await this._storage.pathExists(filePath))) continue;
                const buf = await this._storage.readFile(filePath);
                const page = parseWikiPage(buf.toString("utf-8"), slug);
                pages.set(key, page);
                if (page.slug !== slug) {
                    report.slugDrift.push({
                        file: `${t === "private" ? "" : t + ":"}${slug}.md`,
                        declaredSlug: page.slug,
                    });
                }
                if (!page.category) {
                    report.missingCategory.push(`${t}:${slug}`);
                }
                inbound.set(key, new Set());
            }
        }

        // Pass 2: link resolution + inbound tracking.
        const configuredTargetNames = new Set<WikiTarget>(["private"]);
        for (const s of this._config.shared) configuredTargetNames.add(s.name);

        for (const [key, page] of pages) {
            const [sourceTarget, slug] = splitKey(key);
            const links = parseWikiLinks(page.body);
            // Frontmatter `related` is also a link source.
            const relatedRefs: WikiLinkRef[] = page.related.map((s) => ({
                target: null,
                slug: s,
                display: null,
                start: 0,
                end: 0,
            }));
            for (const ref of [...links, ...relatedRefs]) {
                let resolvedTarget: WikiTarget;
                let resolvedSlug = ref.slug;
                if (ref.target === null) {
                    resolvedTarget = sourceTarget;
                } else if (ref.target === "private") {
                    // [[private:...]] from a shared page — not addressable.
                    if (sourceTarget !== "private") {
                        report.unknownTargets.push({
                            from: `${sourceTarget}:${slug}`,
                            targetName: ref.target,
                        });
                        continue;
                    }
                    resolvedTarget = "private";
                } else if (configuredTargetNames.has(ref.target)) {
                    resolvedTarget = ref.target;
                } else {
                    report.unknownTargets.push({
                        from: `${sourceTarget}:${slug}`,
                        targetName: ref.target,
                    });
                    continue;
                }
                const targetKey = `${resolvedTarget}:${resolvedSlug}`;
                if (!pages.has(targetKey)) {
                    report.brokenLinks.push({
                        from: `${sourceTarget}:${slug}`,
                        toSlug: resolvedSlug,
                        target: resolvedTarget,
                    });
                } else {
                    inbound.get(targetKey)?.add(`${sourceTarget}:${slug}`);
                }
            }
        }

        // Pass 3: orphans + staleness + contradiction loops.
        const stalenessMs =
            this._config.stalenessThresholdDays * 24 * 60 * 60 * 1000;
        const now = Date.now();
        const seenLoops = new Set<string>();

        for (const [key, page] of pages) {
            const inboundSet = inbound.get(key);
            if (!inboundSet || inboundSet.size === 0) {
                // Pages with no inbound links AND no related[] pointers from
                // others. Redirects (with redirectTo set) are not orphans —
                // they exist to forward and shouldn't be flagged.
                if (!page.redirectTo) {
                    report.orphans.push(key);
                }
            }

            // Staleness: page.updated is older than threshold AND no source's
            // mtime/date is newer. Cheap heuristic — compare against today.
            try {
                const updated = new Date(page.updated).getTime();
                if (
                    !isNaN(updated) &&
                    now - updated > stalenessMs
                ) {
                    report.stalePages.push({
                        slug: key,
                        updated: page.updated,
                        // We don't yet know a definitive "newest source" date;
                        // surface the page's `updated` for the operator to
                        // investigate. A future enhancement can stat source files.
                        newestSource: page.updated,
                    });
                }
            } catch {
                // Bad date — ignore.
            }

            // Contradiction loops: A.contradicts -> B AND B.contradicts -> A.
            if (page.contradicts && page.contradicts.length > 0) {
                const [t, s] = splitKey(key);
                for (const otherSlug of page.contradicts) {
                    const otherKey = `${t}:${otherSlug}`;
                    const other = pages.get(otherKey);
                    if (!other?.contradicts?.includes(s)) continue;
                    const loopKey = [key, otherKey].sort().join("<->");
                    if (seenLoops.has(loopKey)) continue;
                    seenLoops.add(loopKey);
                    report.contradictionLoops.push([key, otherKey]);
                }
            }
        }

        return report;
    }

    /**
     * Merge page `src` into `dst` within the same target. Appends `src`'s body
     * to `dst`'s body under an `## (merged from <src>)` heading, unions the
     * source lists, and overwrites `src` with a redirect stub pointing at
     * `dst`. Refuses on reader-role targets.
     */
    async merge(
        srcSlug: string,
        dstSlug: string,
        target: WikiTarget = "private",
    ): Promise<void> {
        this._assertWritable(target);
        validateSlug(srcSlug);
        validateSlug(dstSlug);
        if (srcSlug === dstSlug) {
            throw new Error(`merge: src and dst slugs are identical (${srcSlug}).`);
        }
        const src = await this.read(srcSlug, target);
        if (!src) throw new Error(`merge: source page "${srcSlug}" does not exist.`);
        const dst = await this.read(dstSlug, target);
        if (!dst) throw new Error(`merge: destination page "${dstSlug}" does not exist.`);

        // Union sources, deduping while preserving order.
        const seen = new Set(dst.sources);
        const mergedSources = [...dst.sources];
        for (const s of src.sources) {
            if (!seen.has(s)) {
                seen.add(s);
                mergedSources.push(s);
            }
        }

        // Append src body under a clearly-marked heading so the operator can
        // edit/dedup later. We don't try to interleave — preserves provenance.
        const mergedBody =
            dst.body.trimEnd() +
            "\n\n" +
            `## (merged from \`${srcSlug}\` on ${todayIso()})\n\n` +
            src.body.trim() +
            "\n";

        const mergedRelated = unionSlugs(dst.related, src.related, [
            srcSlug,
            dstSlug,
        ]);

        const mergedPage: WikiPage = {
            ...dst,
            sources: mergedSources,
            related: mergedRelated,
            body: mergedBody,
            updated: todayIso(),
        };
        if (src.contradicts && src.contradicts.length > 0) {
            mergedPage.contradicts = unionSlugs(
                dst.contradicts ?? [],
                src.contradicts,
                [srcSlug],
            );
        }
        await this.write(mergedPage, target);

        // Replace src with a redirect stub.
        const redirect: WikiPage = {
            slug: srcSlug,
            name: src.name,
            description: `Redirects to [[${dstSlug}]] (merged on ${todayIso()})`,
            category: src.category,
            created: src.created,
            updated: todayIso(),
            sources: src.sources,
            related: [dstSlug],
            redirectTo: dstSlug,
            body: `This page was merged into [[${dstSlug}]] on ${todayIso()}.\n`,
        };
        await this.write(redirect, target);
    }

    /**
     * Rename `oldSlug` → `newSlug` within `target`. Writes the page at the
     * new slug, then replaces the old slug with a redirect stub. Refuses on
     * reader-role targets. `newSlug` must not already exist.
     */
    async rename(
        oldSlug: string,
        newSlug: string,
        target: WikiTarget = "private",
    ): Promise<void> {
        this._assertWritable(target);
        validateSlug(oldSlug);
        validateSlug(newSlug);
        if (oldSlug === newSlug) {
            throw new Error(`rename: old and new slugs are identical (${oldSlug}).`);
        }
        const page = await this.read(oldSlug, target);
        if (!page) throw new Error(`rename: page "${oldSlug}" does not exist.`);
        if (await this.read(newSlug, target)) {
            throw new Error(
                `rename: destination "${newSlug}" already exists. Use merge() instead.`,
            );
        }
        const renamed: WikiPage = {
            ...page,
            slug: newSlug,
            updated: todayIso(),
        };
        await this.write(renamed, target);

        const redirect: WikiPage = {
            slug: oldSlug,
            name: page.name,
            description: `Redirects to [[${newSlug}]] (renamed on ${todayIso()})`,
            category: page.category,
            created: page.created,
            updated: todayIso(),
            sources: page.sources,
            related: [newSlug],
            redirectTo: newSlug,
            body: `This page was renamed to [[${newSlug}]] on ${todayIso()}.\n`,
        };
        await this.write(redirect, target);
    }

    /**
     * Regenerate a page's body from its declared sources using the configured
     * LLM model. Preserves the page's slug, name, description, category, and
     * source list — only the body and `updated` change. Throws if no model
     * was injected at construction time, or if the page has no sources, or
     * if all source files fail to load.
     */
    async rebuild(
        slug: string,
        target: WikiTarget = "private",
    ): Promise<WikiPage> {
        this._assertWritable(target);
        validateSlug(slug);
        if (!this._model) {
            throw new Error(
                `WikiEngine.rebuild requires a model. Pass deps.model to the constructor.`,
            );
        }
        const page = await this.read(slug, target);
        if (!page) throw new Error(`rebuild: page "${slug}" does not exist.`);
        if (page.sources.length === 0) {
            throw new Error(`rebuild: page "${slug}" has no sources to rebuild from.`);
        }

        const sourceTexts: { uri: string; content: string }[] = [];
        for (const sourceUri of page.sources) {
            const content = await this._readSource(sourceUri, target);
            if (content !== null) {
                sourceTexts.push({ uri: sourceUri, content });
            }
        }
        if (sourceTexts.length === 0) {
            throw new Error(
                `rebuild: none of "${slug}"'s ${page.sources.length} source(s) could be read.`,
            );
        }

        const prompt = buildRebuildPrompt(page, sourceTexts);
        const completion = await this._model.complete(prompt, {
            systemPrompt: WIKI_REBUILD_SYSTEM_PROMPT,
            temperature: 0.4,
            maxTokens: 2000,
        });
        const newBody = stripCodeFence(completion.text).trim();
        if (!newBody) {
            throw new Error(`rebuild: model returned an empty body for "${slug}".`);
        }
        const rebuilt: WikiPage = {
            ...page,
            body: ensureTrailingNewline(newBody),
            updated: todayIso(),
            confidence:
                page.sources.length >=
                (this._config.minSourcesForSynthesis ?? 3)
                    ? page.confidence ?? "medium"
                    : "low",
        };
        await this.write(rebuilt, target);
        return rebuilt;
    }

    /**
     * Convert legacy typed memories (`memory/<type>_<topic>.md`) into wiki
     * pages, mapped per §10.4: `user_*` → entity, `feedback_*` → concept,
     * `project_*` → project, `reference_*` → reference. Idempotent
     * (skips files already moved to the archive). Non-destructive: original
     * typed memories are moved to `memory/.archive/typed-memories/`, not
     * deleted. Slug collisions are resolved by appending `-<category>`.
     */
    async migrateTypedMemories(): Promise<WikiTypedMigrationReport> {
        this._assertWritable("private");
        const memDir = path.join(this._privateRoot, "memory");
        const archiveDir = path.join(memDir, ".archive", "typed-memories");
        const report: WikiTypedMigrationReport = {
            migrated: {},
            renamedOnCollision: {},
            alreadyMigrated: [],
            failed: [],
            archivePath: archiveDir,
        };
        // Listing files in memory/ excludes subdirectories. The typed-memory
        // pattern is `<type>_<topic>.md` where type is one of the four legacy
        // categories. Anything else (daily logs, MEMORY.md, etc.) is filtered.
        // We don't gate on `pathExists(memDir)` — VirtualFileStorage only
        // registers folders that were explicitly createFolder'd, but
        // listFiles iterates over file entries by parent and works either way.
        const files = await this._storage.listFiles(memDir, "files");
        const candidates = files
            .map((f) => f.name)
            .filter(
                (name) =>
                    /^(user|feedback|project|reference)_[^.]+\.md$/.test(name),
            )
            .sort();

        for (const filename of candidates) {
            const filePath = path.join(memDir, filename);
            const archivePath = path.join(archiveDir, filename);
            try {
                if (await this._storage.pathExists(archivePath)) {
                    report.alreadyMigrated.push(filename);
                    continue;
                }
                const buf = await this._storage.readFile(filePath);
                const parsed = matter(buf.toString("utf-8"));
                const data = parsed.data as Record<string, unknown>;
                const typedPrefix = filename.split("_")[0];
                const category = TYPED_TO_CATEGORY[typedPrefix];
                if (!category) {
                    report.failed.push({
                        path: filename,
                        reason: `unrecognized typed prefix "${typedPrefix}"`,
                    });
                    continue;
                }
                const topic = filename
                    .replace(/^(user|feedback|project|reference)_/, "")
                    .replace(/\.md$/, "");
                const slugBase = slugify(topic);
                if (!slugBase) {
                    report.failed.push({
                        path: filename,
                        reason: "could not derive a slug from filename",
                    });
                    continue;
                }
                let slug = slugBase;
                if (await this.read(slug, "private")) {
                    // Collision with an existing wiki page — try the
                    // category-suffixed slug. If THAT also collides, fail.
                    const collisionSlug = `${slugBase}-${category}`;
                    if (await this.read(collisionSlug, "private")) {
                        report.failed.push({
                            path: filename,
                            reason: `slug "${slugBase}" and fallback "${collisionSlug}" both already exist`,
                        });
                        continue;
                    }
                    slug = collisionSlug;
                    report.renamedOnCollision[slugBase] = collisionSlug;
                }
                const sources = inferSourcesFromBody(parsed.content);
                if (sources.length === 0) {
                    sources.push(`migration:${todayIso()}:${filename}`);
                }
                const page: WikiPage = {
                    slug,
                    name:
                        typeof data.name === "string" && data.name.length > 0
                            ? data.name
                            : topic.replace(/-/g, " "),
                    description:
                        typeof data.description === "string"
                            ? data.description
                            : "",
                    category,
                    created: todayIso(),
                    updated: todayIso(),
                    sources,
                    related: [],
                    confidence: "medium",
                    body: ensureTrailingNewline(parsed.content.trim()),
                };
                await this.write(page, "private");

                // Move the original to the archive (non-destructive). We use
                // upsertFile + deleteFile because most FileStorage impls don't
                // expose a rename primitive.
                await this._storage.upsertFile(archivePath, buf);
                await this._storage.deleteFile(filePath);
                report.migrated[filename] = slug;
            } catch (err) {
                report.failed.push({
                    path: filename,
                    reason: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return report;
    }

    /**
     * Regenerate the "Knowledge Map" section of WISDOM.md as a per-category
     * listing of wiki pages. Idempotent: replaces any existing
     * `## Knowledge Map` section in place; otherwise appends a new one.
     * Pure data op — no LLM involved.
     */
    async rebuildKnowledgeMap(): Promise<{ updated: boolean; pages: number }> {
        const slugs = await this.list("private");
        if (slugs.length === 0) {
            return { updated: false, pages: 0 };
        }
        const pages: WikiPage[] = [];
        for (const slug of slugs) {
            const page = await this.read(slug, "private");
            if (page && !page.redirectTo) pages.push(page);
        }
        const wisdomPath = path.join(this._privateRoot, "WISDOM.md");
        const block = renderKnowledgeMap(pages);

        let content = "";
        if (await this._storage.pathExists(wisdomPath)) {
            content = (await this._storage.readFile(wisdomPath)).toString(
                "utf-8",
            );
        }

        const headingRe = /(^|\n)## Knowledge Map[\s\S]*?(?=\n## |\n# |$)/;
        let next: string;
        if (headingRe.test(content)) {
            next = content.replace(headingRe, "\n" + block);
        } else {
            const prefix = content.length > 0 ? content.trimEnd() + "\n\n" : "";
            next = prefix + block + "\n";
        }
        await this._storage.upsertFile(wisdomPath, next);
        return { updated: true, pages: pages.length };
    }

    /**
     * Convert legacy dreaming insight files (`memory/dreams/insights/*.md`)
     * into wiki pages. Idempotent: re-running skips pages that already exist
     * with the same slug. Non-destructive: original insight files are left
     * in place; the migration is opt-in cleanup.
     *
     * Each insight becomes a `category: theme` wiki page (theme pages are
     * synthesis-only, which is exactly what insights are). The page slug is
     * derived from the insight's frontmatter `theme` field, the filename
     * (after stripping date prefix), or a fallback hash.
     */
    async migrateInsights(): Promise<{
        created: string[];
        skipped: { file: string; reason: string }[];
    }> {
        this._assertWritable("private");
        const created: string[] = [];
        const skipped: { file: string; reason: string }[] = [];
        const insightsDir = path.join(
            this._privateRoot,
            "memory",
            "dreams",
            "insights",
        );
        if (!(await this._storage.pathExists(insightsDir))) {
            return { created, skipped };
        }
        const files = await this._storage.listFiles(insightsDir, "files");
        for (const f of files) {
            if (!f.name.endsWith(".md")) continue;
            const filePath = path.join(insightsDir, f.name);
            try {
                const buf = await this._storage.readFile(filePath);
                const parsed = matter(buf.toString("utf-8"));
                const data = parsed.data as Record<string, unknown>;
                const themeRaw =
                    typeof data.theme === "string" && data.theme.length > 0
                        ? data.theme
                        : f.name.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "");
                const slug = slugify(themeRaw);
                if (!slug) {
                    skipped.push({ file: f.name, reason: "could not derive a slug" });
                    continue;
                }
                if (await this.read(slug, "private")) {
                    skipped.push({
                        file: f.name,
                        reason: `wiki page "${slug}" already exists`,
                    });
                    continue;
                }
                const sources = Array.isArray(data.sources)
                    ? (data.sources as string[]).filter(
                          (s) => typeof s === "string" && s.length > 0,
                      )
                    : [];
                const created_at =
                    typeof data.date === "string" ? data.date : todayIso();
                const page: WikiPage = {
                    slug,
                    name: themeRaw,
                    description: `Synthesized insight from ${sources.length || "unknown"} source(s) (migrated from ${f.name})`,
                    category: "theme",
                    created: created_at,
                    updated: todayIso(),
                    sources: sources.length > 0 ? sources : [`memory/dreams/insights/${f.name}`],
                    related: [],
                    confidence:
                        data.confidence === "high" ||
                        data.confidence === "medium" ||
                        data.confidence === "low"
                            ? (data.confidence as "high" | "medium" | "low")
                            : "medium",
                    body: parsed.content.trim() + "\n",
                };
                await this.write(page, "private");
                created.push(slug);
            } catch (err) {
                skipped.push({
                    file: f.name,
                    reason: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return { created, skipped };
    }

    /**
     * Rebuild every page in `target` from its sources. Skips redirects and
     * single-source stubs (the rebuild prompt assumes synthesis is meaningful;
     * a 1-source page is just the source). Returns a structured report.
     */
    async rebuildAll(target: WikiTarget = "private"): Promise<WikiRebuildReport> {
        this._assertWritable(target);
        const report: WikiRebuildReport = {
            rebuilt: [],
            skipped: [],
            failed: [],
        };
        const slugs = await this.list(target);
        for (const slug of slugs) {
            const page = await this.read(slug, target);
            if (!page) {
                report.skipped.push(slug);
                continue;
            }
            if (page.redirectTo) {
                report.skipped.push(slug);
                continue;
            }
            if (page.sources.length < 2) {
                // Stubs (1 source) aren't useful to "regenerate" — they're
                // the source itself. Phase D's dreaming integration is what
                // promotes stubs.
                report.skipped.push(slug);
                continue;
            }
            try {
                await this.rebuild(slug, target);
                report.rebuilt.push(slug);
            } catch (err) {
                report.failed.push({
                    slug,
                    reason: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return report;
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

    /**
     * Read a source file referenced by a wiki page's `sources` list. Source
     * URIs are typically `memory/YYYY-MM-DD.md` (or `WISDOM.md`, or another
     * `memory/wiki/<slug>.md`). Returns null on missing or unreadable files
     * so callers can keep going.
     */
    private async _readSource(
        sourceUri: string,
        target: WikiTarget,
    ): Promise<string | null> {
        const resolved = this._resolveOne(target);
        // Absolute paths are passed through verbatim; relative paths are
        // resolved against the target's root (since shared wikis may live
        // outside the agent's private root).
        const fullPath = path.isAbsolute(sourceUri)
            ? sourceUri
            : path.join(resolved.root, sourceUri);
        if (!(await this._storage.pathExists(fullPath))) return null;
        try {
            const buf = await this._storage.readFile(fullPath);
            return buf.toString("utf-8");
        } catch {
            return null;
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

/**
 * Maps legacy typed-memory prefixes to wiki categories per spec §10.4.
 */
const TYPED_TO_CATEGORY: Record<string, WikiCategory | undefined> = {
    user: "entity",
    feedback: "concept",
    project: "project",
    reference: "reference",
};

/**
 * Best-effort extraction of `memory/YYYY-MM-DD.md` source URIs from a typed
 * memory body. The legacy typed-memory format didn't track sources
 * explicitly, but bodies often contain date references like "2026-04-08"
 * inline. Returns an empty array when nothing parseable is found — caller
 * falls back to a synthetic `migration:<date>:<file>` source.
 */
function inferSourcesFromBody(body: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const dateRe = /\b(\d{4}-\d{2}-\d{2})\b/g;
    let m: RegExpExecArray | null;
    while ((m = dateRe.exec(body)) !== null) {
        const date = m[1];
        const uri = `memory/${date}.md`;
        if (!seen.has(uri)) {
            seen.add(uri);
            out.push(uri);
        }
    }
    return out;
}

/**
 * Render the Knowledge Map markdown block. Categories listed in the order
 * the spec sketches (§12.3). Empty categories are skipped.
 */
function renderKnowledgeMap(pages: WikiPage[]): string {
    const order: { cat: WikiCategory; label: string }[] = [
        { cat: "project", label: "Active Projects" },
        { cat: "concept", label: "Core Concepts" },
        { cat: "entity", label: "Entities" },
        { cat: "reference", label: "References" },
        { cat: "theme", label: "Themes" },
    ];
    const grouped: Record<WikiCategory, WikiPage[]> = {
        entity: [],
        concept: [],
        project: [],
        reference: [],
        theme: [],
    };
    for (const p of pages) grouped[p.category].push(p);
    const lines: string[] = ["## Knowledge Map", ""];
    for (const { cat, label } of order) {
        const items = grouped[cat].sort((a, b) => a.slug.localeCompare(b.slug));
        if (items.length === 0) continue;
        lines.push(`### ${label} (${items.length})`);
        for (const p of items) {
            const stubMark = isStub(p) ? " (stub)" : "";
            lines.push(`- [[${p.slug}]] — ${p.description}${stubMark}`);
        }
        lines.push("");
    }
    return lines.join("\n").trimEnd() + "\n";
}

/**
 * Convert a free-form string into a valid wiki slug (lowercase ASCII,
 * hyphen-separated). Returns the empty string when nothing maps.
 */
function slugify(input: string): string {
    return input
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "") // strip diacritics
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
}

function splitKey(key: string): [WikiTarget, string] {
    const idx = key.indexOf(":");
    if (idx === -1) return ["private", key];
    return [key.slice(0, idx), key.slice(idx + 1)];
}

function unionSlugs(...lists: string[][]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const list of lists) {
        for (const s of list) {
            if (!seen.has(s)) {
                seen.add(s);
                out.push(s);
            }
        }
    }
    return out;
}

/**
 * Strip a leading/trailing ```markdown fence the LLM occasionally wraps the
 * body in. Idempotent on already-fenceless input.
 */
function stripCodeFence(text: string): string {
    const trimmed = text.trim();
    const match = /^```(?:markdown|md)?\n([\s\S]*?)\n?```$/.exec(trimmed);
    if (match) return match[1];
    return trimmed;
}

const WIKI_REBUILD_SYSTEM_PROMPT = [
    "You are regenerating a wiki page from its underlying source memories.",
    "Read every source carefully. Write a single coherent page that synthesizes them.",
    "",
    "Rules:",
    "- Write only the page body (no frontmatter, no ``` fences, no preamble).",
    "- Use markdown headings starting at H2 (`## …`). The H1 is implied by the page name.",
    "- Stay grounded in the sources. If sources contradict, note the contradiction explicitly.",
    "- Preserve specific facts, names, dates, decisions, and numbers verbatim from the sources.",
    "- Cross-reference related wiki pages with `[[slug]]` links when natural — never invent slugs.",
    "- Concept and project pages should preserve the **Why:** / **How to apply:** discipline if it was present in the prior body.",
    "- Be concise. Compounding synthesis is the point; redundancy is not.",
].join("\n");

function buildRebuildPrompt(
    page: WikiPage,
    sources: { uri: string; content: string }[],
): string {
    const lines: string[] = [];
    lines.push(`# ${page.name}`);
    lines.push("");
    lines.push(`Category: ${page.category}`);
    lines.push(`Slug: ${page.slug}`);
    if (page.description) lines.push(`Description: ${page.description}`);
    if (page.related.length > 0) {
        lines.push(`Related pages: ${page.related.map((s) => `[[${s}]]`).join(", ")}`);
    }
    lines.push("");
    lines.push(`## Previous page body (for reference)`);
    lines.push(page.body.trim() || "(empty — first synthesis)");
    lines.push("");
    lines.push(`## Sources (${sources.length})`);
    for (const s of sources) {
        lines.push("");
        lines.push(`### ${s.uri}`);
        lines.push(s.content.trim());
    }
    lines.push("");
    lines.push(
        `Now write the new body for "${page.name}" as a wiki page. Body only — no frontmatter.`,
    );
    return lines.join("\n");
}
