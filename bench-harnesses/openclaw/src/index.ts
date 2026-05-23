/**
 * @openclaw/recall-bench-openclaw — public API
 *
 * Default export is a `MemorySystemAdapter` instance configured from
 * environment variables, suitable for the recall-bench CLI's `--adapter <path>`.
 * Named exports give programmatic users richer control.
 */

import { OpenClawMemoryAdapter, type OpenClawAdapterConfig } from "./adapter.js";

export { OpenClawMemoryAdapter } from "./adapter.js";
export type { OpenClawAdapterConfig } from "./adapter.js";
export type { SynthesisModel } from "./synthesis.js";
export type { DayMetadata, MemorySystemAdapter } from "./types.js";

/**
 * Construct a configured adapter. Prefer this over `new OpenClawMemoryAdapter`
 * if you want a stable factory call site.
 */
export function createOpenClawAdapter(
  config: OpenClawAdapterConfig = {},
): OpenClawMemoryAdapter {
  return new OpenClawMemoryAdapter(config);
}

/**
 * Read adapter config from environment variables. Returns an empty object
 * when no relevant variables are set, so callers can spread it over
 * hard-coded config without overwriting explicit fields.
 */
export function configFromEnv(): OpenClawAdapterConfig {
  const cfg: OpenClawAdapterConfig = {};
  const provider = process.env.RECALL_OC_EMBED_PROVIDER;
  if (provider === "openai" || provider === "auto") cfg.embeddingProvider = provider;
  const embeddingModel = process.env.RECALL_OC_EMBED_MODEL;
  if (embeddingModel) cfg.embeddingModel = embeddingModel;
  const synthesisModel = process.env.RECALL_OC_SYNTHESIS_MODEL;
  if (synthesisModel) cfg.synthesisModel = synthesisModel;
  const maxResults = process.env.RECALL_OC_MAX_RESULTS;
  if (maxResults) {
    const parsed = parseInt(maxResults, 10);
    if (Number.isFinite(parsed) && parsed > 0) cfg.maxSearchResults = parsed;
  }
  const minScore = process.env.RECALL_OC_MIN_SCORE;
  if (minScore) {
    const parsed = parseFloat(minScore);
    if (Number.isFinite(parsed)) cfg.minScore = parsed;
  }
  return cfg;
}

/** Default-export instance used by `recall-bench run --adapter <path-to-this-module>`. */
const defaultAdapter = createOpenClawAdapter(configFromEnv());
export default defaultAdapter;
