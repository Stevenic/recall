/**
 * GrpcMemoryAdapter — implements MemorySystemAdapter by connecting to
 * a remote memory system over gRPC.
 *
 * This lets any language implement the MemoryBenchService proto and
 * participate in recall-bench evaluations.
 *
 * Usage:
 *   const adapter = new GrpcMemoryAdapter({ host: '127.0.0.1', port: 50052 });
 *   // or
 *   const adapter = GrpcMemoryAdapter.fromUrl('grpc://127.0.0.1:50052');
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { MemorySystemAdapter, DayMetadata } from './types.js';

// ---------------------------------------------------------------------------
// Proto loading — dynamic, no codegen required
// ---------------------------------------------------------------------------

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const PROTO_PATH = resolve(__dirname_local, '..', 'proto', 'memory_bench_service.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
});
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
const recallBench = protoDescriptor.recall.bench;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GrpcMemoryAdapterConfig {
    /** Host to connect to. Default: '127.0.0.1' */
    host?: string;
    /** Port to connect to. Default: 50052 */
    port?: number;
    /** Timeout per RPC call in ms. Default: 120000 (2 min) */
    timeout?: number;
    /** Human-readable name override. If not set, fetched from Healthcheck. */
    name?: string;
}

/** Default port — 50052 to avoid colliding with vectra's 50051. */
export const GRPC_DEFAULT_PORT = 50052;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GrpcMemoryAdapter implements MemorySystemAdapter {
    public name: string;
    private readonly _client: any;
    private readonly _timeout: number;

    constructor(config: GrpcMemoryAdapterConfig = {}) {
        const host = config.host ?? '127.0.0.1';
        const port = config.port ?? GRPC_DEFAULT_PORT;
        this._timeout = config.timeout ?? 120_000;
        this.name = config.name ?? `grpc://${host}:${port}`;

        this._client = new recallBench.MemoryBenchService(
            `${host}:${port}`,
            grpc.credentials.createInsecure(),
        );
    }

    /**
     * Parse a URL like `grpc://host:port` into a GrpcMemoryAdapter.
     */
    static fromUrl(url: string, config?: Omit<GrpcMemoryAdapterConfig, 'host' | 'port'>): GrpcMemoryAdapter {
        const parsed = parseGrpcUrl(url);
        return new GrpcMemoryAdapter({ ...config, ...parsed });
    }

    /**
     * Check if a string looks like a gRPC URL (grpc://...).
     */
    static isGrpcUrl(value: string): boolean {
        return value.startsWith('grpc://');
    }

    async setup(): Promise<void> {
        // First do a healthcheck to get the system name and verify connectivity
        try {
            const resp = await this._unary<{ name: string; ready: boolean }>('healthcheck', {});
            if (resp.name && this.name.startsWith('grpc://')) {
                this.name = resp.name;
            }
        } catch {
            // Healthcheck is optional — if it fails, proceed with setup
        }
        await this._unary('setup', {});
    }

    async ingestDay(day: number, content: string, metadata: DayMetadata): Promise<void> {
        await this._unary('ingestDay', {
            dayNumber: day,
            content,
            metadata: {
                dayNumber: metadata.dayNumber,
                date: metadata.date,
                personaId: metadata.personaId,
                activeArcs: metadata.activeArcs,
            },
        });
    }

    async finalizeIngestion(): Promise<void> {
        await this._unary('finalizeIngestion', {});
    }

    async query(question: string): Promise<string> {
        const resp = await this._unary<{ answer: string }>('query', { question });
        return resp.answer;
    }

    async teardown(): Promise<void> {
        await this._unary('teardown', {});
    }

    /**
     * Close the underlying gRPC channel. Call this when completely done.
     */
    close(): void {
        this._client.close();
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private _unary<T = any>(method: string, request: any): Promise<T> {
        const deadline = new Date(Date.now() + this._timeout);
        return new Promise((resolve, reject) => {
            this._client[method](request, { deadline }, (err: grpc.ServiceError | null, response: T) => {
                if (err) {
                    reject(new Error(`gRPC ${method} failed: ${err.message} (code: ${err.code})`));
                } else {
                    resolve(response);
                }
            });
        });
    }
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

export function parseGrpcUrl(url: string): { host: string; port: number } {
    if (!url.startsWith('grpc://')) {
        throw new Error(`Invalid gRPC URL: ${url}. Expected format: grpc://host:port`);
    }
    const hostPort = url.slice('grpc://'.length);
    const colonIdx = hostPort.lastIndexOf(':');
    if (colonIdx === -1) {
        return { host: hostPort, port: GRPC_DEFAULT_PORT };
    }
    const host = hostPort.slice(0, colonIdx);
    const port = parseInt(hostPort.slice(colonIdx + 1), 10);
    if (isNaN(port)) {
        throw new Error(`Invalid port in gRPC URL: ${url}`);
    }
    return { host, port };
}
