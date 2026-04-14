// --- Interfaces ---
export type {
    FileStorage,
    FileDetails,
    ListFilesFilter,
} from "./interfaces/storage.js";

export type {
    EmbeddingsModel,
    EmbeddingsResponse,
    EmbeddingsResponseStatus,
} from "./interfaces/embeddings.js";

export type {
    MemoryIndex,
    CreateIndexOptions,
    DocumentMetadata,
    QueryOptions,
    SearchResult,
    IndexStats,
    MetadataFilter,
    MetadataTypes,
    ScoringWeights,
} from "./interfaces/index.js";

export { ResultType } from "./interfaces/index.js";

export type {
    MemoryModel,
    CompleteOptions,
    CompletionResult,
    CompletionError,
} from "./interfaces/model.js";

// --- Core services ---
export { MemoryFiles } from "./files.js";
export type { ListOptions, MemoryFileManifest } from "./files.js";

export { SearchService } from "./search.js";
export type { SearchOptions, MultiSearchOptions } from "./search.js";

export { Compactor } from "./compactor.js";
export type {
    CompactionConfig,
    WisdomConfig,
    CompactOptions,
    CompactionResult,
} from "./compactor.js";

export { MemoryService } from "./service.js";
export type {
    MemoryServiceConfig,
    MemoryStatus,
    MigrationReport,
    WatchConfig,
} from "./service.js";

// --- Utilities ---
export { chunkMarkdown } from "./chunker.js";
export type { Chunk, ChunkOptions } from "./chunker.js";

export {
    parseCatalogEntry,
    scoreCatalogEntry,
    matchCatalog,
} from "./catalog.js";
export type { CatalogEntry } from "./catalog.js";

export { expandQuery } from "./query-expansion.js";

export {
    computeSalienceWeights,
    countEntities,
    countDecisionMarkers,
    countTokens,
} from "./salience.js";
export type { SalienceWeights, SalienceEntry } from "./salience.js";

export {
    extractTemporalReference,
    extractAllTemporalReferences,
    temporalAffinity,
    extractDateFromUri,
} from "./temporal.js";
export type { TemporalReference } from "./temporal.js";

export type { HierarchicalMemoryConfig } from "./hierarchical-config.js";

// --- Dreaming ---
export { DreamEngine } from "./dream-engine.js";
export { SearchLogger } from "./search-logger.js";
export {
    collectSignals,
    collectHitFrequencySignals,
    collectGapSignals,
    collectEntitySignals,
    collectStalenessSignals,
    collectWisdomDriftSignals,
    extractEntitiesLightweight,
} from "./signal-collector.js";
export type { SignalCollectorConfig } from "./signal-collector.js";
export type {
    DreamingConfig,
    DreamScoringWeights,
    AnalysisTemplates,
    SearchLogEntry,
    DreamCandidate,
    DreamCandidateType,
    DreamOptions,
    DreamResult,
    InsightRecord,
    ContradictionRecord,
    GapRecord,
    AnalysisResult,
    DreamStatus,
    DreamState,
} from "./dreaming-config.js";
export {
    DEFAULT_SCORING_WEIGHTS,
    DEFAULT_MAX_CANDIDATES,
    DEFAULT_SIGNAL_WINDOW_DAYS,
    DEFAULT_STALENESS_THRESHOLD_DAYS,
} from "./dreaming-config.js";

// --- Default implementations ---
export { LocalFileStorage } from "./defaults/local-file-storage.js";
export { VirtualFileStorage } from "./defaults/virtual-file-storage.js";
export { VectraIndex } from "./defaults/vectra-index.js";
export type { VectraIndexConfig } from "./defaults/vectra-index.js";
export { LocalEmbeddings } from "./defaults/local-embeddings.js";
export { CliAgentModel } from "./defaults/cli-agent-model.js";
export type {
    CliAgentModelConfig,
    CliAgentName,
} from "./defaults/cli-agent-model.js";
