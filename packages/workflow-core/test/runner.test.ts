import { describe, expect, jest, test } from '@jest/globals';
import {
  type HttpResponse,
  type HttpTransport,
  type JsonValue,
  type PreparedRequest,
  runWorkflow,
  WorkflowValidationError,
  delay,
} from '../src';
import { example, node } from './helpers';

function response(json: JsonValue, status = 200): HttpResponse {
  const body = JSON.stringify(json);
  return {
    status,
    headers: [{ name: 'content-type', value: 'application/json' }],
    body: {
      encoding: 'base64',
      data: Buffer.from(body).toString('base64'),
      byteLength: Buffer.byteLength(body),
      preview: body,
      previewTruncated: false,
      jsonParse: 'parsed',
    },
    json,
    durationMs: 1,
  };
}
function scripted() {
  const calls: PreparedRequest[] = [];
  let mode = 'success';
  let polls = 0;
  const http: HttpTransport = {
    async execute(request) {
      calls.push(structuredClone(request));
      const path = new URL(request.url).pathname;
      if (request.method === 'POST') {
        mode = (JSON.parse(request.body!) as { mode: string }).mode;
        if (mode === 'rejected') return response({ error: 'rejected' }, 400);
        return response(mode === 'missing-id' ? {} : { jobId: 'job_123' }, 202);
      }
      if (path === '/jobs/job_123') {
        polls += 1;
        return response({
          state:
            mode !== 'never-complete' && polls >= 3
              ? 'completed'
              : 'processing',
          attempt: polls,
        });
      }
      if (path === '/jobs/job_123/result') {
        return response({
          recordIds: [mode === 'wrong-result' ? 'wrong' : 'record_123'],
        });
      }
      return response({ error: 'unknown path' }, 404);
    },
  };
  return { http, calls };
}
function bundleWithMode(mode: string) {
  const bundle = example();
  bundle.requests[0]!.body = {
    kind: 'json',
    value: { kind: 'literal', value: { mode } },
  };
  node(bundle.workflow, 'wait_for_job', 'repeat').intervalMs = 0;
  return bundle;
}

describe('headless interpreter', () => {
  test('runs the whole workflow and keeps separate invocations and ordered events', async () => {
    const { http, calls } = scripted();
    const sleep = jest.fn(async () => {});
    const report = await runWorkflow(bundleWithMode('success'), {
      http,
      environment: { baseUrl: 'http://fixture.test' },
      sleep,
    });
    expect(report.status).toBe('passed');
    expect(calls).toHaveLength(5);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(report.invocations).toHaveLength(15);
    const polls = report.invocations.filter(
      (invocation) => invocation.nodeId === 'poll_request',
    );
    expect(polls.map((invocation) => invocation.iteration)).toEqual([1, 2, 3]);
    expect(
      new Set(polls.map((invocation) => invocation.invocationId)).size,
    ).toBe(3);
    expect(polls[0]!.output).toMatchObject({
      response: { json: { attempt: 1, state: 'processing' } },
    });
    expect(polls[2]!.output).toMatchObject({
      response: { json: { attempt: 3, state: 'completed' } },
    });
    expect(
      polls.every((invocation) => invocation.parentInvocationId !== undefined),
    ).toBe(true);
    expect(report.events.map((event) => event.sequence)).toEqual(
      report.events.map((_, index) => index + 1),
    );
    expect(report.events.at(-1)).toMatchObject({
      type: 'run.finished',
      payload: { status: 'passed' },
    });
    expect(report.skippedNodeIds).toEqual(['failed']);
    expect(
      report.invocations.every(
        (invocation) =>
          invocation.status === 'completed' && invocation.finishedAt,
      ),
    ).toBe(true);
  });

  test.each([
    ['rejected', 'failed', 1, 'WORKFLOW_FAILED'],
    ['never-complete', 'failed', 6, 'WORKFLOW_FAILED'],
    ['missing-id', 'errored', 1, 'MISSING_VALUE'],
    ['wrong-result', 'failed', 5, 'ASSERTION_FAILED'],
  ])(
    'classifies %s without dispatching inappropriate downstream work',
    async (mode, status, count, code) => {
      const { http, calls } = scripted();
      const sleep = jest.fn(async () => {});
      const report = await runWorkflow(bundleWithMode(mode), {
        http,
        environment: { baseUrl: 'http://fixture.test' },
        sleep,
      });
      expect(report.status).toBe(status);
      expect(report.error?.code).toBe(code);
      expect(calls).toHaveLength(count);
      if (mode === 'never-complete') {
        expect(sleep).toHaveBeenCalledTimes(4);
        expect(
          report.invocations.find(
            (invocation) => invocation.nodeId === 'wait_for_job',
          )?.selectedPort,
        ).toBe('exhausted');
      }
      if (mode === 'missing-id') {
        expect(report.error?.path).toEqual(['bindings', 'jobId']);
        expect(
          report.invocations.find(
            (invocation) => invocation.nodeId === 'poll_request',
          )?.status,
        ).toBe('errored');
      }
      if (mode === 'wrong-result') {
        expect(JSON.stringify(report.error?.details)).toContain('record_123');
        expect(JSON.stringify(report.error?.details)).toContain('wrong');
      }
    },
  );

  test('can assert that a received HTTP 401 is expected', async () => {
    const bundle = example();
    bundle.workflow.nodes = [
      node(bundle.workflow, 'create_job', 'request'),
      {
        id: 'expected_401',
        type: 'assert',
        predicate: {
          op: 'eq',
          left: {
            kind: 'stepOutput',
            nodeId: 'create_job',
            path: '/response/status',
          },
          right: { kind: 'literal', value: 401 },
        },
      },
      { id: 'passed', type: 'end', outcome: 'passed' },
    ];
    bundle.workflow.edges = [
      { from: 'create_job', port: 'response', to: 'expected_401' },
      { from: 'expected_401', port: 'pass', to: 'passed' },
    ];
    const report = await runWorkflow(bundle, {
      http: { execute: async () => response({ message: 'unauthorized' }, 401) },
      environment: { baseUrl: 'http://fixture.test' },
    });
    expect(report.status).toBe('passed');
  });

  test('rejects malformed graphs before calling HTTP', async () => {
    const { http, calls } = scripted();
    await expect(runWorkflow({}, { http })).rejects.toBeInstanceOf(
      WorkflowValidationError,
    );
    expect(calls).toHaveLength(0);
  });

  test('checks actual inputs and environment before dispatch', async () => {
    const { http, calls } = scripted();
    const missing = await runWorkflow(example(), { http });
    expect(missing.error?.code).toBe('MISSING_ENVIRONMENT');
    const wrong = await runWorkflow(example(), {
      http,
      environment: { baseUrl: 'http://fixture.test' },
      inputs: { expectedRecordId: 123 },
    });
    expect(wrong.error?.code).toBe('TYPE_MISMATCH');
    const invalid = await runWorkflow(example(), {
      http,
      environment: { baseUrl: Infinity },
    });
    expect(invalid.error?.code).toBe('INVALID_INPUTS');
    expect(calls).toHaveLength(0);
  });

  test('freezes the active definitions while edits affect the next run', async () => {
    const bundle = bundleWithMode('success');
    const first = scripted();
    const report = await runWorkflow(bundle, {
      http: first.http,
      environment: { baseUrl: 'http://fixture.test' },
      onEvent(event) {
        if (
          event.type === 'response.received' &&
          event.nodeId === 'create_job'
        ) {
          bundle.requests[2]!.url.path = '/edited';
          bundle.requests[2]!.revision = 2;
        }
      },
    });
    expect(report.status).toBe('passed');
    expect(first.calls.at(-1)!.url).toContain('/jobs/job_123/result');
    const second = scripted();
    const next = await runWorkflow(bundle, {
      http: second.http,
      environment: { baseUrl: 'http://fixture.test' },
    });
    expect(second.calls.at(-1)!.url).toContain('/edited');
    expect(next.status).toBe('failed');
    expect(JSON.stringify(report.snapshot)).not.toContain('/edited');
  });

  test('captures response values independently of later adapter mutations', async () => {
    const base = scripted();
    let previous: HttpResponse | undefined;
    const http: HttpTransport = {
      async execute(request, signal) {
        if (
          previous?.json !== null &&
          typeof previous?.json === 'object' &&
          !Array.isArray(previous.json)
        ) {
          previous.json.jobId = 'changed-after-return';
        }
        const result = await base.http.execute(request, signal);
        previous = result;
        return result;
      },
    };
    const report = await runWorkflow(bundleWithMode('success'), {
      http,
      environment: { baseUrl: 'http://fixture.test' },
    });
    expect(report.status).toBe('passed');
    expect(report.invocations[0]!.output).toMatchObject({
      response: { json: { jobId: 'job_123' } },
    });
  });

  test('honours the global invocation budget even inside a repeat', async () => {
    const bundle = bundleWithMode('success');
    bundle.workflow.limits.maxNodeInvocations = 3;
    const { http, calls } = scripted();
    const report = await runWorkflow(bundle, {
      http,
      environment: { baseUrl: 'http://fixture.test' },
    });
    expect(report.status).toBe('errored');
    expect(report.error?.code).toBe('INVOCATION_LIMIT');
    expect(report.invocations).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });

  test('applies a request deadline even when an injected adapter ignores cancellation', async () => {
    const bundle = bundleWithMode('success');
    bundle.requests[0]!.timeoutMs = 30;
    const http: HttpTransport = { execute: () => new Promise(() => {}) };
    const report = await runWorkflow(bundle, {
      http,
      environment: { baseUrl: 'http://fixture.test' },
    });
    expect(report.status).toBe('errored');
    expect(report.error?.code).toBe('REQUEST_TIMEOUT');
    expect(report.invocations).toHaveLength(1);
  });

  test('applies the run deadline while waiting between polls', async () => {
    const bundle = bundleWithMode('never-complete');
    bundle.workflow.limits.maxRunDurationMs = 50;
    const { http, calls } = scripted();
    const report = await runWorkflow(bundle, {
      http,
      environment: { baseUrl: 'http://fixture.test' },
      sleep: () => new Promise(() => {}),
    });
    expect(report.status).toBe('errored');
    expect(report.error?.code).toBe('RUN_DEADLINE');
    expect(calls).toHaveLength(2);
  });

  test('cancels an already-aborted run before any node or HTTP dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    const { http, calls } = scripted();
    const report = await runWorkflow(example(), {
      http,
      signal: controller.signal,
    });
    expect(report.status).toBe('cancelled');
    expect(report.invocations).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('cancellation between preparation and dispatch prevents sending the request', async () => {
    const controller = new AbortController();
    const { http, calls } = scripted();
    const report = await runWorkflow(example(), {
      http,
      environment: { baseUrl: 'http://fixture.test' },
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'request.prepared') controller.abort();
      },
    });
    expect(report.status).toBe('cancelled');
    expect(calls).toHaveLength(0);
  });

  test('cancels in-flight work and dispatches no later node', async () => {
    const controller = new AbortController();
    let calls = 0;
    const http: HttpTransport = {
      async execute(_request, signal) {
        calls++;
        controller.abort();
        await delay(1000, signal);
        return response({});
      },
    };
    const report = await runWorkflow(example(), {
      http,
      environment: { baseUrl: 'http://fixture.test' },
      signal: controller.signal,
    });
    expect(report.status).toBe('cancelled');
    expect(calls).toBe(1);
    expect(report.invocations[0]!.status).toBe('cancelled');
  });

  test('cancels during a delay and prevents the next poll', async () => {
    const controller = new AbortController();
    const { http, calls } = scripted();
    const report = await runWorkflow(bundleWithMode('never-complete'), {
      http,
      environment: { baseUrl: 'http://fixture.test' },
      signal: controller.signal,
      sleep: async (ms, signal) => {
        controller.abort();
        await delay(ms, signal);
      },
    });
    expect(report.status).toBe('cancelled');
    expect(calls).toHaveLength(2);
  });

  test('redacts secrets, echoed credentials and raw bodies in stored and live diagnostics', async () => {
    const bundle = bundleWithMode('success');
    for (const request of bundle.requests)
      request.auth = {
        kind: 'bearer',
        token: { kind: 'secret', name: 'apiToken' },
      };
    const token = 'private-token-123456';
    const resolver = jest.fn(async () => token);
    const base = scripted();
    const observed: string[] = [];
    const http: HttpTransport = {
      async execute(request, signal) {
        expect(request.headers).toContainEqual({
          name: 'Authorization',
          value: 'Bearer ' + token,
        });
        return base.http.execute(request, signal);
      },
    };
    const report = await runWorkflow(bundle, {
      http,
      resolveSecret: resolver,
      environment: { baseUrl: 'http://fixture.test' },
      onEvent: (event) => {
        observed.push(JSON.stringify(event));
      },
    });
    expect(report.status).toBe('passed');
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain(token);
    expect(observed.join('')).not.toContain(token);
    expect(JSON.stringify(report)).toContain('[REDACTED]');
    expect(report.invocations[0]!.output).toMatchObject({
      response: { body: { redacted: true, data: '[REDACTED]' } },
    });
    expect(JSON.stringify(report.snapshot)).toContain('apiToken');
  });

  test('redacts literal credential-shaped JSON body fields without changing sent data', async () => {
    const bundle = bundleWithMode('success');
    const body = { mode: 'success', accessToken: 'literal-private-value' };
    bundle.requests[0]!.body = {
      kind: 'json',
      value: { kind: 'literal', value: body },
    };
    const { http, calls } = scripted();
    const report = await runWorkflow(bundle, {
      http,
      environment: { baseUrl: 'http://fixture.test' },
    });
    expect(calls[0]!.body).toContain(body.accessToken);
    expect(JSON.stringify(report)).not.toContain(body.accessToken);
  });

  test('redacts credentials observed in response JSON, including its encoded raw body', async () => {
    const base = scripted();
    const credential = 'server-created-private-token';
    const http: HttpTransport = {
      async execute(request, signal) {
        const result = await base.http.execute(request, signal);
        return request.method === 'POST'
          ? response({ jobId: 'job_123', accessToken: credential }, 202)
          : result;
      },
    };
    const report = await runWorkflow(bundleWithMode('success'), {
      http,
      environment: { baseUrl: 'http://fixture.test' },
    });
    expect(report.status).toBe('passed');
    expect(JSON.stringify(report)).not.toContain(credential);
    expect(report.invocations[0]!.output).toMatchObject({
      response: {
        json: { accessToken: '[REDACTED]' },
        body: { redacted: true, data: '[REDACTED]' },
      },
    });
  });

  test('listener failures are diagnostics and do not change execution outcome', async () => {
    const { http } = scripted();
    const report = await runWorkflow(bundleWithMode('success'), {
      http,
      environment: { baseUrl: 'http://fixture.test' },
      onEvent: () => {
        throw new Error('observer failed');
      },
    });
    expect(report.status).toBe('passed');
    expect(report.warnings[0]!.code).toBe('EVENT_LISTENER_ERROR');
  });
});
