import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fixtureModes, type FixtureMode } from '@project-neo/fixture-api';
import type { RunEvent } from '@project-neo/workflow-core';
import { runExample } from './index';

function integer(value: string, name: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(name + ' must be a non-negative safe integer.');
  return number;
}
async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'success' },
      report: { type: 'string', default: 'tmp/runs/latest.json' },
      'interval-ms': { type: 'string', default: '1000' },
      'request-timeout-ms': { type: 'string' },
      'cancel-after-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'npm run demo -- [--mode ' +
        fixtureModes.join('|') +
        '] [--interval-ms 1000] [--request-timeout-ms 30000] [--report tmp/runs/latest.json] [--cancel-after-ms 100]',
    );
    return;
  }
  if (!fixtureModes.includes(values.mode as FixtureMode))
    throw new Error('Unknown fixture mode: ' + values.mode);
  const intervalMs = integer(values['interval-ms'], 'interval-ms');
  const requestTimeoutMs =
    values['request-timeout-ms'] === undefined
      ? undefined
      : integer(values['request-timeout-ms'], 'request-timeout-ms');
  if (requestTimeoutMs === 0)
    throw new Error('request-timeout-ms must be positive.');
  const cancelAfterMs =
    values['cancel-after-ms'] === undefined
      ? undefined
      : integer(values['cancel-after-ms'], 'cancel-after-ms');
  if (cancelAfterMs !== undefined && cancelAfterMs > 2_147_483_647) {
    throw new Error('cancel-after-ms cannot exceed 2147483647.');
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  const timer =
    cancelAfterMs === undefined ? undefined : setTimeout(stop, cancelAfterMs);
  function onEvent(event: RunEvent) {
    const payload = event.payload;
    if (
      [
        'node.started',
        'response.received',
        'condition.evaluated',
        'iteration.started',
        'assertion.failed',
        'run.finished',
      ].includes(event.type)
    ) {
      console.log(
        String(event.sequence).padStart(3, '0') +
          ' ' +
          event.type +
          (event.nodeId ? ' ' + event.nodeId : '') +
          ' ' +
          JSON.stringify(payload),
      );
    }
  }
  try {
    const result = await runExample({
      mode: values.mode as FixtureMode,
      intervalMs,
      signal: controller.signal,
      onEvent,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    });
    const target = resolve(values.report);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(result.report, null, 2) + '\n');
    const polls = result.observations.filter((request) =>
      /^\/jobs\/[^/]+$/.test(request.path),
    ).length;
    console.log(
      'Run ' +
        result.report.status +
        ': ' +
        polls +
        ' poll(s), ' +
        result.report.invocations.length +
        ' node invocation(s).',
    );
    console.log('Report: ' + target);
    process.exitCode =
      result.report.status === 'passed'
        ? 0
        : result.report.status === 'failed'
          ? 1
          : result.report.status === 'cancelled'
            ? 130
            : 2;
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', stop);
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
