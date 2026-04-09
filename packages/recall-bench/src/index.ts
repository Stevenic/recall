/**
 * @recall/bench — public API
 */

// Types
export type {
    MemorySystemAdapter,
    DayMetadata,
    JudgeModel,
    JudgeScore,
    QAPair,
    Category,
    Difficulty,
    TimeRangeKey,
    HarnessConfig,
    QuestionResult,
    CategoryScore,
    TimeRangeResult,
    HeatmapCell,
    PersonaResult,
    BenchmarkResult,
} from './types.js';

export { TIME_RANGES, CATEGORIES } from './types.js';

// Harness
export { BenchmarkHarness } from './harness.js';

// Dataset loading
export { loadPersona, filterQAByRange, listPersonas } from './dataset.js';
export type { PersonaDataset, DayEntry } from './dataset.js';

// Generator
export { DayGenerator, loadPersonaDefinition, loadArcs } from './generator.js';
export {
    computePhase,
    computeDensity,
    getActiveArcs,
    getDirectives,
    getCorrectionStates,
    selectArcDays,
    identifyGapDays,
    computeCalendarDate,
    formatDate,
    getDayOfWeek,
    buildSystemPrompt,
    buildUserMessage,
    buildArcUserMessage,
    buildGapUserMessage,
} from './generator.js';
export type {
    PersonaDefinition,
    ArcDefinition,
    ArcType,
    ArcPhase,
    ArcDirective,
    ActiveArc,
    DensityHint,
    Directive,
    CorrectionPhase,
    CorrectionState,
    ArcSummary,
    DayContext,
    RecentDay,
    GeneratorModel,
    GeneratorModelOptions,
    GeneratorModelResult,
    GeneratorConfig,
    GeneratedDay,
    GenerationResult,
    PersonaCreatorConfig,
    CreatedPersona,
    ConversationTurn,
    GeneratedConversation,
    ConversationGeneratorConfig,
    ConversationGenerationResult,
} from './generator-types.js';

// CLI Generator Model (built-in agent support)
export { CliGeneratorModel, isCliAgentName, CLI_AGENT_NAMES } from './cli-generator-model.js';
export type { CliAgentName, CliGeneratorModelConfig } from './cli-generator-model.js';

// Persona Creator
export { PersonaCreator, parsePersonaYaml, parseArcsYaml, serializePersonaYaml, serializeArcsYaml } from './persona-creator.js';

// Conversation Generator
export { ConversationGenerator, parseConversationJson, serializeConversation, serializeConversationJson } from './conversation-generator.js';

// gRPC Memory Adapter
export { GrpcMemoryAdapter, parseGrpcUrl, GRPC_DEFAULT_PORT } from './grpc-memory-adapter.js';
export type { GrpcMemoryAdapterConfig } from './grpc-memory-adapter.js';

// Reporting
export {
    formatTextReport,
    formatJsonReport,
    toHeatmapGrid,
    toSummaryTable,
} from './report.js';
export type { HeatmapGrid, SummaryRow } from './report.js';
