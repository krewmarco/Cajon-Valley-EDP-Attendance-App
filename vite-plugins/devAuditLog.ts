// vite-plugins/devAuditLog.ts
// Dev-server sink for the `local` audit provider. Appends every audit event
// to logs/dev-audit.jsonl (one JSON object per line) for review while testing:
//
//   POST   /__dev/audit-log   append an event (any client, so LAN tablets can log)
//   GET    /__dev/audit-log   all events as a JSON array   (this machine only)
//   DELETE /__dev/audit-log   clear the log                 (this machine only)
//
// Only active under `vite` (serve); production builds have no endpoint.
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';
import { DEV_AUDIT_ENDPOINT } from '../src/services/audit/localAuditProvider';

const MAX_BODY_BYTES = 1_000_000;

function isLoopback(address: string | undefined): boolean {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function send(res: ServerResponse, status: number, body?: unknown): void {
    res.statusCode = status;
    if (body === undefined) {
        res.end();
        return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                resolve(null);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

export function readDevAuditLog(logFile: string): unknown[] {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

export function createDevAuditLogHandler(logFile: string) {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (req.method === 'POST') {
            const raw = await readBody(req);
            if (raw === null) return send(res, 413, { error: 'Event too large' });

            let event: Record<string, unknown>;
            try {
                event = JSON.parse(raw);
            } catch {
                return send(res, 400, { error: 'Body must be JSON' });
            }
            if (!event || typeof event !== 'object' || typeof event.event_type !== 'string') {
                return send(res, 400, { error: 'Missing event_type' });
            }

            fs.mkdirSync(path.dirname(logFile), { recursive: true });
            fs.appendFileSync(logFile, JSON.stringify({ received_at: new Date().toISOString(), ...event }) + '\n');
            return send(res, 204);
        }

        if (req.method === 'GET' || req.method === 'DELETE') {
            // The log holds student data; only this machine may read or clear it
            if (!isLoopback(req.socket.remoteAddress)) return send(res, 403, { error: 'Local access only' });
            if (req.method === 'GET') return send(res, 200, readDevAuditLog(logFile));
            fs.rmSync(logFile, { force: true });
            return send(res, 204);
        }

        res.setHeader('Allow', 'GET, POST, DELETE');
        return send(res, 405, { error: 'Method not allowed' });
    };
}

export function devAuditLog({ logFile = 'logs/dev-audit.jsonl' }: { logFile?: string } = {}): Plugin {
    return {
        name: 'edp-dev-audit-log',
        apply: 'serve',
        configureServer(server) {
            const file = path.resolve(server.config.root, logFile);
            server.middlewares.use(DEV_AUDIT_ENDPOINT, createDevAuditLogHandler(file));
            server.config.logger.info(`  Dev audit log: ${path.relative(process.cwd(), file)} (${DEV_AUDIT_ENDPOINT})`);
        },
    };
}
