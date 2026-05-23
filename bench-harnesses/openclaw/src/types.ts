/**
 * Local types.
 *
 * The recall-bench `MemorySystemAdapter` and `DayMetadata` shapes are inlined
 * here (rather than depending on the `@recall/bench` package) so this harness
 * lives self-contained inside the OpenClaw monorepo. These shapes are stable
 * and small; mirror them when recall-bench changes them.
 *
 * OpenClaw memory types (`MemorySearchManager`, `MemorySearchResult`,
 * `OpenClawConfig`, …) come from `openclaw/plugin-sdk/...` and are referenced
 * directly where needed — no local re-declarations.
 */

// ---------------------------------------------------------------------------
// recall-bench contract — mirrors @recall/bench's MemorySystemAdapter
// ---------------------------------------------------------------------------

export interface DayMetadata {
  /** Day number within the persona's memory stream (1-1000) */
  dayNumber: number;
  /** Synthetic calendar date (ISO 8601) */
  date: string;
  /** Persona ID this day belongs to */
  personaId: string;
  /** IDs of narrative arcs active on this day */
  activeArcs: string[];
}

export interface MemorySystemAdapter {
  /** Human-readable name of the system under test */
  name: string;
  /** Initialize the memory system to a clean state */
  setup(): Promise<void>;
  /** Ingest a single day's memory. Called in chronological order. */
  ingestDay(day: number, content: string, metadata: DayMetadata): Promise<void>;
  /** Signal that ingestion is complete. System may do final processing. */
  finalizeIngestion(): Promise<void>;
  /** Ask a question and get an answer */
  query(question: string): Promise<string>;
  /** Clean up resources */
  teardown(): Promise<void>;
}
