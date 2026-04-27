import type { WikiCategory } from "./wiki-types.js";

/**
 * Per-category stub templates (§3.4 of specs/wiki.md).
 *
 * The agent (or a calling tool) typically passes a free-form description and
 * uses {@link renderStubBody} to wrap it in the discipline-preserving
 * skeleton. Concept and project stubs preserve the typed-memory
 * `**Why:** / **How to apply:**` convention.
 */

export interface StubBodyInput {
    /** Lede paragraph — answers "what is this?" in one or two sentences */
    lede: string;
    /**
     * Why this matters / the motivation. Required for `concept` and `project`.
     * Optional for `entity` and `reference`.
     */
    why?: string;
    /**
     * When/where this guidance kicks in. Required for `concept` and `project`.
     * Optional for `entity` and `reference`.
     */
    howToApply?: string;
    /** Free-form additional content appended after the templated sections */
    extra?: string;
    /** Reference URL or location (used by `reference` template) */
    where?: string;
    /** When-to-use details (used by `reference` template) */
    when?: string;
}

/**
 * Render a category-appropriate stub body. The output is the page body only
 * (no frontmatter); the caller assembles the full file via the WikiEngine.
 */
export function renderStubBody(
    category: WikiCategory,
    input: StubBodyInput,
): string {
    switch (category) {
        case "entity":
            return renderEntityStub(input);
        case "concept":
            return renderConceptStub(input);
        case "project":
            return renderProjectStub(input);
        case "reference":
            return renderReferenceStub(input);
        case "theme":
            throw new Error(
                "Theme pages are synthesis-only and cannot be stubbed by an agent.",
            );
    }
}

function renderEntityStub(input: StubBodyInput): string {
    const parts: string[] = [];
    parts.push(input.lede.trim());
    if (input.extra && input.extra.trim().length > 0) {
        parts.push("");
        parts.push(input.extra.trim());
    }
    return parts.join("\n") + "\n";
}

function renderConceptStub(input: StubBodyInput): string {
    if (!input.why || !input.howToApply) {
        throw new Error(
            "Concept stubs require both `why` and `howToApply` to preserve the typed-memory feedback convention.",
        );
    }
    const parts: string[] = [
        input.lede.trim(),
        "",
        `**Why:** ${input.why.trim()}`,
        "",
        `**How to apply:** ${input.howToApply.trim()}`,
    ];
    if (input.extra && input.extra.trim().length > 0) {
        parts.push("");
        parts.push(input.extra.trim());
    }
    return parts.join("\n") + "\n";
}

function renderProjectStub(input: StubBodyInput): string {
    if (!input.why || !input.howToApply) {
        throw new Error(
            "Project stubs require both `why` and `howToApply` to preserve the typed-memory project convention.",
        );
    }
    const parts: string[] = [
        input.lede.trim(),
        "",
        `**Why:** ${input.why.trim()}`,
        "",
        `**How to apply:** ${input.howToApply.trim()}`,
    ];
    if (input.extra && input.extra.trim().length > 0) {
        parts.push("");
        parts.push(input.extra.trim());
    }
    return parts.join("\n") + "\n";
}

function renderReferenceStub(input: StubBodyInput): string {
    const parts: string[] = [input.lede.trim()];
    if (input.where && input.where.trim().length > 0) {
        parts.push("");
        parts.push("## Where to find it");
        parts.push(input.where.trim());
    }
    if (input.when && input.when.trim().length > 0) {
        parts.push("");
        parts.push("## When to use it");
        parts.push(input.when.trim());
    }
    if (input.extra && input.extra.trim().length > 0) {
        parts.push("");
        parts.push(input.extra.trim());
    }
    return parts.join("\n") + "\n";
}

/**
 * Validate that a category accepts agent-written stubs. Theme pages are
 * synthesis-only.
 */
export function isStubbable(category: WikiCategory): boolean {
    return category !== "theme";
}
