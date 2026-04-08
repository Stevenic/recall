import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrpcMemoryAdapter, parseGrpcUrl, GRPC_DEFAULT_PORT } from '../src/grpc-memory-adapter.js';

// ---------------------------------------------------------------------------
// Unit tests — parseGrpcUrl, isGrpcUrl
// ---------------------------------------------------------------------------

describe('parseGrpcUrl', () => {
    it('parses host and port', () => {
        expect(parseGrpcUrl('grpc://10.0.0.1:9999')).toEqual({ host: '10.0.0.1', port: 9999 });
    });

    it('defaults port to GRPC_DEFAULT_PORT when omitted', () => {
        expect(parseGrpcUrl('grpc://myhost')).toEqual({ host: 'myhost', port: GRPC_DEFAULT_PORT });
    });

    it('parses localhost', () => {
        expect(parseGrpcUrl('grpc://127.0.0.1:50052')).toEqual({ host: '127.0.0.1', port: 50052 });
    });

    it('throws on invalid scheme', () => {
        expect(() => parseGrpcUrl('http://localhost:50052')).toThrow('Invalid gRPC URL');
    });

    it('throws on non-numeric port', () => {
        expect(() => parseGrpcUrl('grpc://localhost:abc')).toThrow('Invalid port');
    });
});

describe('GrpcMemoryAdapter.isGrpcUrl', () => {
    it('returns true for grpc:// URLs', () => {
        expect(GrpcMemoryAdapter.isGrpcUrl('grpc://localhost:50052')).toBe(true);
        expect(GrpcMemoryAdapter.isGrpcUrl('grpc://10.0.0.1')).toBe(true);
    });

    it('returns false for non-grpc URLs', () => {
        expect(GrpcMemoryAdapter.isGrpcUrl('./my-adapter.js')).toBe(false);
        expect(GrpcMemoryAdapter.isGrpcUrl('http://localhost')).toBe(false);
        expect(GrpcMemoryAdapter.isGrpcUrl('')).toBe(false);
    });
});

describe('GrpcMemoryAdapter constructor', () => {
    it('constructs with defaults', () => {
        const adapter = new GrpcMemoryAdapter();
        expect(adapter.name).toBe('grpc://127.0.0.1:50052');
        adapter.close();
    });

    it('constructs with custom config', () => {
        const adapter = new GrpcMemoryAdapter({ host: '10.0.0.5', port: 9000, name: 'my-system' });
        expect(adapter.name).toBe('my-system');
        adapter.close();
    });

    it('constructs from URL', () => {
        const adapter = GrpcMemoryAdapter.fromUrl('grpc://192.168.1.1:8080');
        expect(adapter.name).toBe('grpc://192.168.1.1:8080');
        adapter.close();
    });
});

// ---------------------------------------------------------------------------
// Integration tests — spin up a real gRPC server in-process
// ---------------------------------------------------------------------------

describe('GrpcMemoryAdapter integration', () => {
    let server: grpc.Server;
    let port: number;
    let adapter: GrpcMemoryAdapter;

    // Track calls the server receives
    const calls: Array<{ method: string; request: any }> = [];
    let storedDays: Array<{ day: number; content: string; metadata: any }> = [];
    let systemName = 'test-memory-system';

    beforeAll(async () => {
        // Load the proto
        const __filename_local = fileURLToPath(import.meta.url);
        const __dirname_local = dirname(__filename_local);
        const protoPath = resolve(__dirname_local, '..', 'proto', 'memory_bench_service.proto');
        const pkgDef = protoLoader.loadSync(protoPath, {
            keepCase: false,
            longs: Number,
            enums: String,
            defaults: true,
            oneofs: true,
        });
        const proto = grpc.loadPackageDefinition(pkgDef) as any;

        // Create server with handlers
        server = new grpc.Server();
        server.addService(proto.recall.bench.MemoryBenchService.service, {
            healthcheck: (_call: any, callback: any) => {
                calls.push({ method: 'healthcheck', request: {} });
                callback(null, { name: systemName, ready: true });
            },
            setup: (_call: any, callback: any) => {
                calls.push({ method: 'setup', request: {} });
                storedDays = [];
                callback(null, {});
            },
            ingestDay: (call: any, callback: any) => {
                const req = call.request;
                calls.push({ method: 'ingestDay', request: req });
                storedDays.push({ day: req.dayNumber, content: req.content, metadata: req.metadata });
                callback(null, {});
            },
            finalizeIngestion: (_call: any, callback: any) => {
                calls.push({ method: 'finalizeIngestion', request: {} });
                callback(null, {});
            },
            query: (call: any, callback: any) => {
                const req = call.request;
                calls.push({ method: 'query', request: req });
                // Return a simple answer based on stored days
                const answer = `Found ${storedDays.length} days. Question: ${req.question}`;
                callback(null, { answer });
            },
            teardown: (_call: any, callback: any) => {
                calls.push({ method: 'teardown', request: {} });
                callback(null, {});
            },
        });

        // Bind to random port
        port = await new Promise<number>((resolve, reject) => {
            server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
                if (err) reject(err);
                else resolve(boundPort);
            });
        });

        adapter = new GrpcMemoryAdapter({ host: '127.0.0.1', port, timeout: 5000 });
    });

    afterAll(() => {
        adapter.close();
        server.forceShutdown();
    });

    it('setup calls server and picks up system name from healthcheck', async () => {
        calls.length = 0;
        await adapter.setup();
        expect(adapter.name).toBe('test-memory-system');
        const methods = calls.map(c => c.method);
        expect(methods).toContain('healthcheck');
        expect(methods).toContain('setup');
    });

    it('ingestDay sends day content and metadata to server', async () => {
        calls.length = 0;
        await adapter.ingestDay(42, '# Day 42\nSomething happened', {
            dayNumber: 42,
            date: '2024-02-11',
            personaId: 'test-persona',
            activeArcs: ['arc-1', 'arc-2'],
        });
        const ingest = calls.find(c => c.method === 'ingestDay');
        expect(ingest).toBeDefined();
        expect(ingest!.request.dayNumber).toBe(42);
        expect(ingest!.request.content).toBe('# Day 42\nSomething happened');
        expect(ingest!.request.metadata.personaId).toBe('test-persona');
        expect(ingest!.request.metadata.activeArcs).toEqual(['arc-1', 'arc-2']);
    });

    it('finalizeIngestion calls server', async () => {
        calls.length = 0;
        await adapter.finalizeIngestion();
        expect(calls.some(c => c.method === 'finalizeIngestion')).toBe(true);
    });

    it('query returns answer from server', async () => {
        const answer = await adapter.query('What happened on day 42?');
        expect(answer).toContain('Found');
        expect(answer).toContain('What happened on day 42?');
    });

    it('teardown calls server', async () => {
        calls.length = 0;
        await adapter.teardown();
        expect(calls.some(c => c.method === 'teardown')).toBe(true);
    });

    it('full lifecycle: setup → ingest → finalize → query → teardown', async () => {
        calls.length = 0;

        await adapter.setup();
        await adapter.ingestDay(1, 'Day 1 content', {
            dayNumber: 1, date: '2024-01-01', personaId: 'p1', activeArcs: [],
        });
        await adapter.ingestDay(2, 'Day 2 content', {
            dayNumber: 2, date: '2024-01-02', personaId: 'p1', activeArcs: ['a1'],
        });
        await adapter.finalizeIngestion();
        const answer = await adapter.query('What happened?');
        await adapter.teardown();

        expect(answer).toContain('Found 2 days');
        const methods = calls.map(c => c.method);
        expect(methods).toEqual([
            'healthcheck', 'setup',
            'ingestDay', 'ingestDay',
            'finalizeIngestion',
            'query',
            'teardown',
        ]);
    });
});
