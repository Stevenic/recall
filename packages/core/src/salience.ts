/**
 * Salience signal extraction for hierarchical memory aggregation.
 *
 * Computes per-child weights from three signals:
 *   - Token count (0.4) — longer entries = more substantive
 *   - Entity density (0.3) — more unique entities = semantically richer
 *   - Decision markers (0.3) — explicit decisions carry disproportionate recall value
 *
 * All signals are relative within the sibling set (divided by max).
 */

export type SalienceWeights = Record<string, number>;

export interface SalienceEntry {
    uri: string;
    text: string;
}

// --- Signal weights ---
const TOKEN_WEIGHT = 0.4;
const ENTITY_WEIGHT = 0.3;
const DECISION_WEIGHT = 0.3;

// --- Decision marker patterns ---
const DECISION_PATTERNS = [
    /\bdecided\s+to\b/gi,
    /\bswitched\s+to\b/gi,
    /\bchose\s+(\w+\s+)?over\b/gi,
    /\bgoing\s+with\b/gi,
    /\bconcluded\s+that\b/gi,
    /\bwent\s+with\b/gi,
    /\bpicked\b/gi,
    /\bselected\b/gi,
    /\bsettled\s+on\b/gi,
    /\bopted\s+(for|to)\b/gi,
    /\bmade\s+the\s+(decision|call|choice)\b/gi,
];

// --- Entity extraction patterns ---

// Code-style identifiers: CamelCase, kebab-case-project, SCREAMING_SNAKE
const CAMEL_CASE = /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;
const KEBAB_CASE = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}\b/g;
const ERROR_CODES = /\b[A-Z][A-Z_]{2,}\b/g;
const HTTP_ERRORS = /\bHTTP\s+[45]\d\d\b/gi;
const TICKET_IDS = /\b(?:#|ticket\s*[#:]?)\s*\d{2,}\b/gi;

// Known tools vocabulary — extend as needed
const KNOWN_TOOLS = new Set([
    "docker",
    "redis",
    "postgres",
    "postgresql",
    "mongodb",
    "mysql",
    "sqlite",
    "nginx",
    "kubernetes",
    "k8s",
    "terraform",
    "ansible",
    "jenkins",
    "github",
    "gitlab",
    "jira",
    "linear",
    "slack",
    "grafana",
    "prometheus",
    "datadog",
    "sentry",
    "webpack",
    "vite",
    "eslint",
    "prettier",
    "jest",
    "vitest",
    "mocha",
    "cypress",
    "playwright",
    "storybook",
    "figma",
    "vercel",
    "netlify",
    "aws",
    "gcp",
    "azure",
    "heroku",
    "cloudflare",
    "supabase",
    "firebase",
    "stripe",
    "twilio",
    "sendgrid",
    "npm",
    "yarn",
    "pnpm",
    "node",
    "deno",
    "bun",
    "python",
    "rust",
    "go",
    "java",
    "typescript",
    "react",
    "vue",
    "angular",
    "svelte",
    "next",
    "nuxt",
    "express",
    "fastify",
    "django",
    "flask",
    "rails",
    "spring",
    "vectra",
    "openai",
    "anthropic",
    "claude",
    "gpt",
    "huggingface",
    "transformers",
    "langchain",
    "llamaindex",
]);

// Cached NER pipeline (lazy-loaded)
let nerPipeline: any = null;
let nerLoading: Promise<any> | null = null;

async function getNerPipeline(): Promise<any> {
    if (nerPipeline) return nerPipeline;
    if (nerLoading) return nerLoading;

    nerLoading = (async () => {
        try {
            const { pipeline } = await import("@huggingface/transformers");
            nerPipeline = await pipeline(
                "token-classification",
                "Xenova/bert-base-NER",
            );
            return nerPipeline;
        } catch {
            // NER model not available — fall back to regex-only
            return null;
        }
    })();

    return nerLoading;
}

/**
 * Count unique entities in text using NER + regex + vocabulary.
 */
export async function countEntities(text: string): Promise<number> {
    const entities = new Set<string>();

    // NER: extract PER and ORG entities
    const ner = await getNerPipeline();
    if (ner) {
        try {
            const results = await ner(text.substring(0, 2048)); // Cap input for performance
            for (const r of results) {
                if (
                    r.entity_group === "PER" ||
                    r.entity_group === "ORG" ||
                    r.entity?.startsWith("B-PER") ||
                    r.entity?.startsWith("B-ORG")
                ) {
                    entities.add(r.word?.toLowerCase().trim());
                }
            }
        } catch {
            // NER failed — continue with regex
        }
    }

    // Regex: code-style names
    for (const match of text.matchAll(CAMEL_CASE)) {
        entities.add(match[0].toLowerCase());
    }
    for (const match of text.matchAll(KEBAB_CASE)) {
        entities.add(match[0].toLowerCase());
    }
    for (const match of text.matchAll(ERROR_CODES)) {
        // Filter out common English words in all-caps
        if (match[0].length >= 4) {
            entities.add(match[0].toLowerCase());
        }
    }
    for (const match of text.matchAll(HTTP_ERRORS)) {
        entities.add(match[0].toLowerCase());
    }
    for (const match of text.matchAll(TICKET_IDS)) {
        entities.add(match[0].toLowerCase());
    }

    // Vocabulary: known tools
    const lowerText = text.toLowerCase();
    for (const tool of KNOWN_TOOLS) {
        if (lowerText.includes(tool)) {
            entities.add(tool);
        }
    }

    return entities.size;
}

/**
 * Count decision markers in text.
 */
export function countDecisionMarkers(text: string): number {
    let count = 0;
    for (const pattern of DECISION_PATTERNS) {
        const matches = text.match(pattern);
        if (matches) count += matches.length;
    }
    return count;
}

/**
 * Estimate token count using gpt-tokenizer.
 */
export async function countTokens(text: string): Promise<number> {
    try {
        const { encode } = await import("gpt-tokenizer");
        return encode(text).length;
    } catch {
        // Fallback: ~4 chars per token
        return Math.ceil(text.length / 4);
    }
}

/**
 * Compute normalized salience weights for a set of sibling entries.
 * Returns a map of URI → weight (weights sum to 1.0).
 */
export async function computeSalienceWeights(
    entries: SalienceEntry[],
): Promise<SalienceWeights> {
    if (entries.length === 0) return {};
    if (entries.length === 1) return { [entries[0].uri]: 1.0 };

    // Compute raw signals
    const signals = await Promise.all(
        entries.map(async (entry) => {
            const [tokens, entities, decisions] = await Promise.all([
                countTokens(entry.text),
                countEntities(entry.text),
                Promise.resolve(countDecisionMarkers(entry.text)),
            ]);
            return { uri: entry.uri, tokens, entities, decisions };
        }),
    );

    // Find max for each signal
    const maxTokens = Math.max(...signals.map((s) => s.tokens), 1);
    const maxEntities = Math.max(...signals.map((s) => s.entities), 1);
    const maxDecisions = Math.max(...signals.map((s) => s.decisions), 1);

    // Compute raw weights
    const rawWeights = signals.map((s) => ({
        uri: s.uri,
        weight:
            TOKEN_WEIGHT * (s.tokens / maxTokens) +
            ENTITY_WEIGHT * (s.entities / maxEntities) +
            DECISION_WEIGHT * (s.decisions / maxDecisions),
    }));

    // Normalize to sum to 1.0
    const totalWeight = rawWeights.reduce((sum, w) => sum + w.weight, 0);
    const result: SalienceWeights = {};
    for (const { uri, weight } of rawWeights) {
        result[uri] = totalWeight > 0 ? weight / totalWeight : 1 / entries.length;
    }

    return result;
}
