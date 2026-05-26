# Bilingual memory + localized retrieval

Recall stores memories, embeds them, runs an agent loop over them, and dreams synthesized wiki pages. Today every layer assumes English: the embedding model is English-only, the BM25 tokenizer is English-only, the recency-cue + temporal-reference regexes parse English keywords, and a few markdown structures are hard-coded English strings.

The goal here is **bilingual**, not just localized: a single Recall deployment ingests memories in multiple languages, indexes them in a shared embedding space, and answers queries in either language with cross-lingual retrieval. Single-locale (the simpler case) falls out for free.

The decision to keep **prompts in English** narrows the work considerably. LLMs handle non-English content in English-instructed prompts fine; the wiki pages they produce can be in the source language even though the prompt is in English. That leaves three things to actually do:

1. Detect each memory's language at ingest, store it as frontmatter.
2. Swap the embedding model to one trained on multiple languages (cross-lingual semantic match falls out of the model — no per-language indexing).
3. Localize the small surface of regex extractors and tokenizers.

## Goals

1. A single Recall instance handles mixed-language memories (English + one other) without forking the codebase.
2. Cross-lingual retrieval: a query in language A finds memories in language B when they describe the same topic.
3. Prompts and frontmatter field names stay English (machine-readable for the agent + system) — no need to translate them.
4. Pluggable enough that adding language C is one new "language module" plus a translation pass.

Out of scope for v1:
- More than two languages in production (multilingual embeddings handle ≥50 languages, but our bench + tuning is two-language for now).
- Bench dataset translation. Translating the 500-day EA corpus is a separate workstream once we pick a second language.
- Localized prompts. The dreaming + agent prompts stay in English regardless of corpus language. Trade-off: the dream LLM has to read across languages, which it handles natively. Win: one less surface area to maintain.

## What needs to change

Three categories, in order of surface area.

### 1. Embeddings (the big one)

The current default, `Xenova/all-MiniLM-L6-v2`, is English-only. Multilingual embeddings put English and non-English text in the same vector space, so "what was the synergy assumption?" matches a Japanese daily that says 「シナジー想定」 because the embeddings encode the underlying concept, not the surface tokens. **This is what makes cross-lingual retrieval just work** — no per-language index, no translation step.

Concrete options for the multilingual default:

#### Local (via `@huggingface/transformers`, ONNX, no API key)

| Model | Size | Dim | Languages | Quality (MTEB) | Notes |
|---|---|---|---|---|---|
| `Xenova/all-MiniLM-L6-v2` (today) | 22 MB | 384 | English-only | ~56 (en) | Replace. |
| `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | 118 MB | 384 | 50 | ~58 | Lightest multilingual. |
| `Xenova/multilingual-e5-small` | 118 MB | 384 | 100+ | ~57-59 | E5 family is stronger than paraphrase on retrieval. |
| **`Xenova/multilingual-e5-base`** | **278 MB** | **768** | **100+** | **~61** | **Recommended default.** ~30ms/embed on CPU. |
| `Xenova/multilingual-e5-large` | 560 MB | 1024 | 100+ | ~64-66 | Best local quality; heavy. |
| `Xenova/bge-m3` | ~580 MB | 1024 | 100+ | ~62-65 | Does dense + sparse + multi-vector — could replace our BM25 entirely. Worth investigating after the bilingual baseline. |

#### Online (API, opt-in)

| Model | $/1M tokens | Dim | Quality | Notes |
|---|---|---|---|---|
| OpenAI `text-embedding-3-small` | $0.02 | 1536 (truncatable) | ~62 | Cheap multilingual default for API-acceptant deployments. |
| OpenAI `text-embedding-3-large` | $0.13 | 3072 (truncatable) | ~66 | Top OAI tier. |
| Cohere `embed-multilingual-v3.0` | $0.10 | 1024 | ~64 | Designed multilingual from the ground up. |
| Voyage `voyage-3` | $0.06 | 1024 | ~68 | Often the MTEB #1; newest. |
| Azure OpenAI embeddings | (Azure pricing) | same | same | Same models as OpenAI but on the existing Azure path Recall already uses for LLMs. |

**Trade-offs.** Local pros: zero per-call cost, no network, corpus stays private, works offline, matches Recall's positioning. Cons: 12-25× larger model file vs current default; quality ceiling ~3-5 points below the top API tier.

Online pros: higher MTEB ceiling; one-line swap; no model file shipping. Cons: corpus content goes over the wire; per-call cost; network dependency.

**Decision:** default local, online opt-in. Same pattern Recall already uses for LLMs (`MemoryModel` defaults to local; users wire Azure/OpenAI/Anthropic on demand). Ship `multilingual-e5-base` as the new default; `embeddings` is already pluggable in `MemoryServiceConfig` so swapping to Voyage/Azure is one constructor line.

**The migration cost.** Changing the default embedding model invalidates the on-disk index — embeddings from one model aren't compatible with another. The index manifest needs to record the embedding model's name, refuse to mix, and point at a re-index command on mismatch. One-time cost per deployment.

### 2. Language detection (new component)

We need to tag each memory with its language at ingest time so dreaming + retrieval can route correctly. Three options ranked by speed/size:

| Approach | Speed | Size | Languages | When |
|---|---|---|---|---|
| **Unicode script heuristic** | <1μs | ~0 (20 LOC) | Script-distinguishable | English + Japanese / Korean / Chinese / Russian / Arabic / Hebrew / Thai / Hindi |
| **`franc`** | ~1ms | ~60 KB | 400+ | English + Spanish / French / German / Portuguese (same-script disambiguation) |
| `@uwdata/cld3-asm` | ~100μs | ~600 KB | 107 | Alternative to franc; faster, slightly less accurate on short text |

Recommended hybrid: script heuristic first (handles ~95% of detections in microseconds when languages differ in script), fall through to `franc` for Latin-script disambiguation:

```ts
function detectLanguage(text: string): string {
    const script = dominantScript(text);
    if (script === "hira" || script === "kata") return "ja-JP";
    if (script === "hangul") return "ko-KR";
    if (script === "han")  return "zh-CN"; // or zh-TW based on text
    if (script === "cyrillic") return "ru-RU";
    if (script === "arabic") return "ar";
    // Latin script — use franc to disambiguate
    return franc(text);  // → "eng", "spa", "fra", …
}
```

**Where it runs.**
- At ingest time: `MemoryFiles.writeDaily` (and similar) detect once, write `language: <BCP-47>` into the daily's frontmatter. One call per write, never re-detected on read.
- At query time: detect the query's language to route the recency-cue + temporal-reference extractors to the right language module. One call per query.
- At dream time: each candidate's source dailies have `language:` set already (from ingest). Dreaming reads them; the wiki page it produces gets tagged with the dominant language of its sources.

### 3. Localized text utilities (small surface)

| Surface | Where | What it does |
|---|---|---|
| Recency-cue extractor | `packages/core/src/temporal.ts:extractRecencyCue` | Returns `"latest"` / `"earliest"` / `null` from regex over English keywords (`latest|current|kickoff|originally…`) |
| Temporal reference extractor | `packages/core/src/temporal.ts:extractTemporalReference` | Regex with English month names + `yesterday`, `last week`, `N weeks ago` |
| Catalog query expansion stop words | `packages/core/src/query-expansion.ts:STOP_WORDS` | English stop-word set |
| Query decomposition split-points | `packages/core/src/query-expansion.ts:decomposeQuery` | Splits on `, and what|; what|and how` — English connectives |
| BM25 tokenizer | `vectra` ← `wink-eng-lite-web-model` | English tokenization + stop words |

Each one becomes a per-language module. A `LanguageUtilsJa` exports `extractRecencyCue` that knows `最新|現在|当初|`, `extractTemporalReference` that knows `昨日|先週|N週間前|`, etc.

For BM25: Vectra already accepts a `bm25Factory` option. We thread a language-aware factory through `VectraIndex`. Languages with a wink model (English, Spanish, French, German, Italian, Portuguese, Dutch, Korean) get a wink-based tokenizer. Languages without (most of CJK, Arabic, Hebrew, Hindi, Thai) either get a community ONNX tokenizer or skip BM25 entirely and rely on semantic-only retrieval — multilingual embeddings carry most of the load.

### What does **not** change

The win in deciding prompts stay English: this list stays mercifully short.

- **All prompts.** Agent system prompt, agent tool descriptions, dreaming analysis templates, compaction prompts, merge + grounding verifier prompts, wiki-preamble framing. All English. The LLM is happy to read Japanese dailies through English instructions and write Japanese wiki bodies when prompted to keep the source language.
- **Field names** in frontmatter (`name`, `description`, `category`, `sources`, `supersedes`, etc.) — machine-readable.
- **Wiki category enum values** (`entity` / `concept` / `project` / `reference` / `theme`) — machine-readable.
- **Slugs** stay `[a-z0-9-]+`. Non-ASCII content transliterates to ASCII slugs for filesystem portability.
- **ISO dates** everywhere.
- **JSON tool I/O shapes.**
- **Markdown structure conventions** (`## Rule`, `**Why:**`) — the LLM produces these because the English prompt says to. Keep them as machine-recognizable anchors.

## Architecture

### One shared embedding space, per-language utilities

The shape is simpler than "language pack" suggests because prompts stay English. We need:

1. **One multilingual embedding model** for the whole corpus — every memory and every query embed into the same space. Cross-lingual retrieval is automatic.
2. **A small set of per-language utility modules** (`LanguageUtilsEn`, `LanguageUtilsJa`, …) that provide the recency-cue, temporal-reference, query-decomposition, and BM25 implementations for that language.
3. **A language detector** the service calls at ingest + query time.

`MemoryServiceConfig` gains two fields:

```ts
export interface MemoryServiceConfig {
    // ... existing fields

    /**
     * Languages this deployment expects in its corpus. The first entry
     * is the "primary" — used for wiki page body language and for any
     * fallback when detection is uncertain. Default: ["en-US"].
     */
    languages?: string[];

    /**
     * Optional language detector override. Default: hybrid script
     * heuristic + franc.
     */
    languageDetector?: LanguageDetector;
}
```

Per-language utilities are registered keyed by BCP-47 tag:

```
packages/core/src/i18n/
├── detector.ts                 // hybrid script + franc
├── language-utils.ts           // interface
├── en.ts                       // moves all current English regex / stop words here
├── ja.ts                       // Japanese utilities (future)
├── es.ts                       // ...
└── index.ts                    // tag → LanguageUtils map
```

`LanguageUtils` shape:

```ts
export interface LanguageUtils {
    readonly tag: string;                             // "en-US", "ja-JP", …
    extractRecencyCue(query: string): RecencyCue;
    extractTemporalReference(q: string, now?: Date): Date | null;
    decomposeQuery(query: string): string[] | null;
    readonly stopWords: ReadonlySet<string>;
    /** Used by the catalog scorer to tokenize names/descriptions. */
    tokenize(text: string): string[];
    /** Optional BM25 tokenizer factory for Vectra. Pass `null` to opt out. */
    bm25Factory?: (() => unknown) | null;
}
```

The service uses the query's detected language to pick utilities at search time; falls back to the deployment's primary language if detection is unsure.

### Embedding model wiring

The embeddings model lives at the service level, not per-language. We swap the default constant in `packages/core/src/defaults/local-embeddings.ts` from `Xenova/all-MiniLM-L6-v2` to `Xenova/multilingual-e5-base` (subject to one more pass on size vs. quality with the team).

The model name lands in the index manifest so the service can refuse to read an index built with a different model:

```json
{
  "indexVersion": 2,
  "embeddingModel": "Xenova/multilingual-e5-base",
  "embeddingDim": 768
}
```

A mismatch on open throws with a clear message + suggests `recall reindex` (a new command — trivial; just calls `service.index()`).

### Detection at ingest

`MemoryFiles.writeDaily` and the equivalents for typed memories, weeklies, monthlies, and wiki pages call `detector.detect(content)` once per write, attach the result as `language: <BCP-47>` in frontmatter. Detection is fast enough (~1ms worst case) that it's amortized into normal write cost. The frontmatter field is durable and never re-detected on read.

For dailies that already exist (the bench's 500-day EA corpus), a one-time `recall detect-languages` command back-fills `language: en-US` on everything that doesn't have it set. Trivial; just iterates the manifest and writes the field.

### Detection at query

`MemoryService.search(query, opts)`:

1. If `opts.queryLanguage` is set, use it directly.
2. Otherwise call `detector.detect(query)` (one call, ~1ms).
3. Pick `LanguageUtils` keyed by the detected tag, falling back to the deployment's primary language when detection is uncertain (franc returns `und` for short or ambiguous queries).
4. Use that utils' `extractRecencyCue`, `extractTemporalReference`, etc. for ranking signals.

The retrieval itself still happens in the shared multilingual embedding space — language detection only affects how we interpret the *query's natural language*.

### Wiki pages in mixed-language corpora

Two viable shapes:

**A. One page per topic, written in the language of its dominant source.** A wiki page about "Condor financing structure" whose sources are all English dailies is written in English; the same topic with Japanese sources gets a Japanese page. Pages can cross-reference each other via `related: [<slug>]` even across languages.

**B. One page per topic per language.** `condor-financing-structure.en.md` and `condor-financing-structure.ja.md` as siblings; both indexed; search returns whichever matches better in the query's embedding space.

Lean A for v1 — it's simpler, the multilingual embedding handles cross-language match at search time, and the agent (which reads the wiki body) doesn't care which language the body is in as long as it can produce an answer in the user's language. The dream prompt can include a directive: "write the wiki body in the dominant language of the sources you're synthesizing from."

B is the right answer if we later need to support presenting wiki content in the user's preferred display language regardless of source — a UI concern more than a memory concern.

## Phasing

### Phase 1 — Multilingual embedding swap, English-only utilities (no behavior change observed)

Goal: lay the index foundation for multilingual without changing day-to-day behavior on the existing English bench.

Touchpoints:
- Add `language` field to daily / weekly / monthly / typed-memory / wiki frontmatter; default to `en-US` when missing.
- Index manifest records embedding model name + dimension; refuse to open on mismatch.
- Default embeddings flips to `Xenova/multilingual-e5-base`.
- Existing 500-day EA bench reindexes once; runs as before.

Effort: 1 day of plumbing + one bench run to confirm the multilingual embedding doesn't regress the English baseline.

### Phase 2 — Detector + per-language utilities + utils registry

Goal: the service routes recency-cue / temporal-reference / decomposition through the detected language's utilities.

Touchpoints:
- Add `LanguageUtils` interface and `en` implementation (lifts current regexes verbatim).
- Add hybrid script + `franc` detector.
- Wire detection at ingest + at query time.
- Bench reruns: should be a no-op since `en` utilities are byte-identical to current.

Effort: 1 day. Lands behind a default. Adds the `franc` dep (~60KB).

### Phase 3 — First non-English language pack + bilingual bench

Goal: a Japanese-or-Spanish utilities module + a smoke bench that proves cross-lingual retrieval works end-to-end.

Touchpoints:
- Translate / author `ja.ts` or `es.ts` LanguageUtils.
- Author a small bilingual persona for testing — 30-50 days, English + target-language sessions mixed.
- Bench profile + run; manual review of failures.

Effort: 2-3 days, mostly the bilingual corpus authoring and the manual triage of the first cross-lingual results.

### Phase 4 — Production bench corpora in target language

A standalone effort: translate the 500-day EA persona + arcs + Q&A pairs into the target language, or author a fresh non-English persona. Not strictly required to ship multilingual support but needed for proper measurement.

Out of scope of this spec; do once Phase 3 confirms the architecture holds.

## Open questions

- **Slug transliteration.** Slugs stay `[a-z0-9-]+`. For non-ASCII content (Japanese, Arabic, etc.), the slug-generator transliterates. Two reasonable libraries: `unidecode` or `transliteration`. Pick one in Phase 2.
- **BM25 for CJK / Arabic / Hebrew / Hindi / Thai.** No wink-lang model exists. Options: (a) skip BM25 for these languages and rely on semantic-only retrieval — acceptable since multilingual embeddings are strong; (b) plug in a community ONNX tokenizer; (c) use bge-m3 (which has its own sparse component, no separate BM25 needed).
- **Detection short-text accuracy.** `franc` is unreliable on text shorter than ~20 chars. For ingest this is rare (daily logs are long); for queries, we may want a min-length threshold below which we default to the deployment's primary language.
- **Locale of error messages.** The agent's `"Tool error: ..."` and `"memory_search: missing 'query' argument."` strings — the agent LLM sees these and may respond in its prose. Probably want them localized but it's a small surface; Phase 2 or later.
- **Identity file.** `IDENTITY.md` is free-form persona text. Authors write it in the target language; nothing about it needs special handling.
- **Date format in prose.** `[as of 2026-05-25]` is ISO and universal. The LLM receives ISO and produces ISO. If a user wants `[2026年5月25日時点]` for native readability, that's a presentation concern outside this spec.

## Non-trivial risks

- **Embedding-space migration.** Once we ship a multilingual default we can't silently swap embedding models on an existing index. The manifest version + refuse-on-mismatch is the contract; document the one-time `recall reindex` migration path clearly.
- **Multilingual embedding quality on English-only corpora.** `multilingual-e5-base` is ~5 MTEB points behind `all-MiniLM-L6-v2` on English-only retrieval. The bench currently scores ~93% with the English model; swapping to multilingual might drop us to ~90% on the same EA corpus. **Phase 1 must include an A/B bench to measure this** — if the regression is large, we need a different default (maybe `multilingual-e5-large` for English-heavy deployments, or auto-select based on the deployment's `languages` config).
- **Short queries / dailies.** Detection accuracy drops below ~20 characters. For queries this matters; we'd want a minimum-text-length cutoff that falls back to the primary language.
- **Bench fixtures.** Tests assume `en-US` content. The Phase 1 frontmatter addition should default missing `language:` to `en-US` so no test fixtures need editing.

## Recommended next step

Phase 1 alone, as a behavior-equivalent infrastructure change. The English bench's score number is the success criterion: if `multilingual-e5-base` matches the current English baseline within ~1-2 points, ship it as the new default and move to Phase 2. If it regresses meaningfully, that's the signal to either (a) keep English-only as default with multilingual opt-in via config, or (b) try `multilingual-e5-large` despite the size.
