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

// Reporting
export {
    formatTextReport,
    formatJsonReport,
    toHeatmapGrid,
    toSummaryTable,
} from './report.js';
export type { HeatmapGrid, SummaryRow } from './report.js';
