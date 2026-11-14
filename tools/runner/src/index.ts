import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startFixture, type FixtureMode } from '@project-neo/fixture-api';
import { createUndiciTransport } from '@project-neo/http-adapter';
import {
  type RunEvent,
  runWorkflow,
  validateWorkflowBundle,
} from '@project-neo/workflow-core';

export interface ExampleOptions {
  mode?: FixtureMode;
  intervalMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

export async function runExample(options: ExampleOptions = {}) {
  const raw: unknown = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../../examples/job-polling.bundle.json'),
      'utf8',
    ),
  );
  const validation = validateWorkflowBundle(raw);
  if (!validation.ok)
    throw new Error(
      'The bundled example is invalid: ' + JSON.stringify(validation.errors),
    );
  const bundle = validation.value;
  const create = bundle.requests.find(
    (request) => request.id === 'req_create_job',
  )!;
  create.body = {
    kind: 'json',
    value: {
      kind: 'literal',
      value: { mode: options.mode ?? 'success', completeAfterPolls: 3 },
    },
  };
  const repeat = bundle.workflow.nodes.find((node) => node.type === 'repeat');
  if (repeat?.type !== 'repeat')
    throw new Error('The example has no repeat node.');
  if (options.intervalMs !== undefined) repeat.intervalMs = options.intervalMs;
  if (options.requestTimeoutMs !== undefined) {
    for (const request of bundle.requests)
      request.timeoutMs = options.requestTimeoutMs;
  }
  const fixture = await startFixture();
  const http = createUndiciTransport();
  try {
    const report = await runWorkflow(bundle, {
      http,
      environment: { baseUrl: fixture.baseUrl },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    return { report, observations: [...fixture.observations] };
  } finally {
    await http.close();
    await fixture.close();
  }
}
