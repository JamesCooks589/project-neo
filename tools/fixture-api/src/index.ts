import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import type { JsonValue } from '@project-neo/workflow-core';

export const fixtureModes = [
  'success',
  'rejected',
  'never-complete',
  'missing-id',
  'wrong-result',
  'slow',
  'disconnected',
] as const;
export type FixtureMode = (typeof fixtureModes)[number];
const createSchema = z.strictObject({
  mode: z.enum(fixtureModes).default('success'),
  completeAfterPolls: z.number().int().min(1).max(100).default(3),
  delayMs: z.number().int().min(0).max(10_000).default(500),
});
interface Job {
  mode: FixtureMode;
  polls: number;
  completeAfterPolls: number;
  delayMs: number;
}
export interface Observation {
  method: string;
  path: string;
}
class FixtureError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function readJson(request: IncomingMessage) {
  if (
    !(request.headers['content-type'] ?? '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    throw new FixtureError(415, 'Use application/json.');
  }
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65_536) {
        reject(new FixtureError(413, 'Request body exceeds 64 KiB.'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new FixtureError(400, 'Request body is not valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}
function respond(response: ServerResponse, status: number, value: JsonValue) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

/** Isolated per-server state, job-local poll counters, and loopback binding. */
export async function startFixture(options: { port?: number } = {}) {
  const jobs = new Map<string, Job>();
  const observations: Observation[] = [];
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (error instanceof FixtureError)
        respond(response, error.status, { error: error.message });
      else if (error instanceof z.ZodError)
        respond(response, 400, { error: 'Invalid job configuration.' });
      else respond(response, 500, { error: 'Fixture error.' });
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const path = new URL(request.url ?? '/', 'http://fixture.local').pathname;
    observations.push({ method: request.method ?? 'GET', path });
    if (path === '/health' && request.method === 'GET') {
      respond(response, 200, { status: 'ok' });
      return;
    }
    if (path === '/echo' && request.method === 'POST') {
      const body = await readJson(request);
      respond(response, 200, {
        body: body as JsonValue,
        url: request.url ?? '/',
        headers: request.headers as Record<string, string>,
      });
      return;
    }
    if (path.startsWith('/status/') && request.method === 'GET') {
      const status = Number(path.slice('/status/'.length));
      if (!Number.isInteger(status) || status < 200 || status > 599)
        throw new FixtureError(400, 'Invalid status.');
      respond(response, status, { status });
      return;
    }
    if (path === '/text') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('plain response');
      return;
    }
    if (path === '/invalid-json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{broken');
      return;
    }
    if (path === '/redirect') {
      response.writeHead(302, { location: '/health' });
      response.end();
      return;
    }
    if (path === '/disconnect') {
      request.socket.destroy();
      return;
    }
    if (path === '/jobs' && request.method === 'POST') {
      const configuration = createSchema.parse(await readJson(request));
      if (configuration.mode === 'rejected') {
        respond(response, 400, { error: 'Job rejected by fixture.' });
        return;
      }
      if (jobs.size >= 1_000)
        throw new FixtureError(429, 'Fixture job limit reached.');
      const jobId = randomUUID();
      jobs.set(jobId, { ...configuration, polls: 0 });
      respond(
        response,
        202,
        configuration.mode === 'missing-id' ? {} : { jobId },
      );
      return;
    }
    const match = /^\/jobs\/([^/]+)(\/result)?$/.exec(path);
    if (match && request.method === 'GET') {
      const jobId = match[1]!;
      const job = jobs.get(jobId);
      if (job === undefined) throw new FixtureError(404, 'Unknown job.');
      if (job.mode === 'disconnected') {
        request.socket.destroy();
        return;
      }
      if (job.mode === 'slow') {
        const abort = new AbortController();
        const closed = () => abort.abort();
        response.once('close', closed);
        try {
          await wait(job.delayMs, undefined, { signal: abort.signal });
        } catch {
          return;
        } finally {
          response.off('close', closed);
        }
      }
      if (response.destroyed) return;
      const completed =
        job.mode !== 'never-complete' && job.polls >= job.completeAfterPolls;
      if (match[2]) {
        if (!completed) throw new FixtureError(409, 'Job is not complete.');
        respond(response, 200, {
          recordIds:
            job.mode === 'wrong-result' ? ['record_other'] : ['record_123'],
        });
      } else {
        job.polls += 1;
        respond(response, 200, {
          jobId,
          state:
            job.mode !== 'never-complete' && job.polls >= job.completeAfterPolls
              ? 'completed'
              : 'processing',
          polls: job.polls,
        });
      }
      return;
    }
    throw new FixtureError(404, 'Unknown fixture route.');
  }
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Fixture did not expose a TCP port.');
  return {
    baseUrl: 'http://127.0.0.1:' + address.port,
    observations,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
