import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from '@jest/globals';
import { runExample } from '../src';
import type { RunReport } from '@project-neo/workflow-core';

describe('headless example against real local HTTP', () => {
  test.each([
    ['success', 'passed', 3, 1],
    ['rejected', 'failed', 0, 0],
    ['never-complete', 'failed', 5, 0],
    ['missing-id', 'errored', 0, 0],
    ['wrong-result', 'failed', 3, 1],
    ['disconnected', 'errored', 1, 0],
  ] as const)(
    'runs %s with the correct outcome and request counts',
    async (mode, status, polls, results) => {
      const result = await runExample({ mode, intervalMs: 0 });
      expect(result.report.status).toBe(status);
      expect(
        result.observations.filter((request) =>
          /^\/jobs\/[^/]+$/.test(request.path),
        ),
      ).toHaveLength(polls);
      expect(
        result.observations.filter((request) =>
          request.path.endsWith('/result'),
        ),
      ).toHaveLength(results);
      if (mode === 'disconnected')
        expect(result.report.error?.code).toBe('TRANSPORT_ERROR');
      if (mode === 'missing-id')
        expect(result.report.error).toMatchObject({
          code: 'MISSING_VALUE',
          path: ['bindings', 'jobId'],
        });
    },
  );

  test('times out a slow response and sends no result fetch', async () => {
    const result = await runExample({
      mode: 'slow',
      intervalMs: 0,
      requestTimeoutMs: 100,
    });
    expect(result.report.status).toBe('errored');
    expect(result.report.error?.code).toBe('REQUEST_TIMEOUT');
    expect(
      result.observations.some((request) => request.path.endsWith('/result')),
    ).toBe(false);
  });

  test('cancels before a subsequent poll is dispatched', async () => {
    const controller = new AbortController();
    const result = await runExample({
      mode: 'never-complete',
      intervalMs: 1000,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'iteration.waiting') controller.abort();
      },
    });
    expect(result.report.status).toBe('cancelled');
    expect(
      result.observations.filter((request) =>
        /^\/jobs\/[^/]+$/.test(request.path),
      ),
    ).toHaveLength(1);
    expect(
      result.observations.some((request) => request.path.endsWith('/result')),
    ).toBe(false);
  });

  test('provides a runnable CLI that writes a complete report and returns a useful exit status', () => {
    const target = resolve(
      __dirname,
      '../../../../tmp/cli-' + randomUUID() + '.json',
    );
    try {
      const result = spawnSync(
        process.execPath,
        [
          resolve(__dirname, '../src/cli.js'),
          '--interval-ms',
          '0',
          '--report',
          target,
        ],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Run passed: 3 poll(s)');
      const report = JSON.parse(readFileSync(target, 'utf8')) as RunReport;
      expect(report.status).toBe('passed');
      expect(report.events.at(-1)?.type).toBe('run.finished');
    } finally {
      try {
        unlinkSync(target);
      } catch {
        /* No report if the subprocess failed. */
      }
    }
  });

  test('the CLI distinguishes a failed workflow, timeout and bad arguments', () => {
    const target = resolve(
      __dirname,
      '../../../../tmp/cli-' + randomUUID() + '.json',
    );
    try {
      const failed = spawnSync(
        process.execPath,
        [
          resolve(__dirname, '../src/cli.js'),
          '--mode',
          'rejected',
          '--report',
          target,
        ],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(failed.status).toBe(1);
      const timeout = spawnSync(
        process.execPath,
        [
          resolve(__dirname, '../src/cli.js'),
          '--mode',
          'slow',
          '--request-timeout-ms',
          '100',
          '--report',
          target,
        ],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(timeout.status).toBe(2);
      expect(
        (JSON.parse(readFileSync(target, 'utf8')) as RunReport).error?.code,
      ).toBe('REQUEST_TIMEOUT');
      const invalid = spawnSync(
        process.execPath,
        [resolve(__dirname, '../src/cli.js'), '--mode', 'unknown'],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(invalid.status).toBe(2);
      expect(invalid.stderr).toContain('Unknown fixture mode');
    } finally {
      try {
        unlinkSync(target);
      } catch {
        /* No report if the subprocess failed. */
      }
    }
  });

  test('the CLI writes cancelled evidence and exits with status 130', () => {
    const target = resolve(
      __dirname,
      '../../../../tmp/cli-' + randomUUID() + '.json',
    );
    try {
      const result = spawnSync(
        process.execPath,
        [
          resolve(__dirname, '../src/cli.js'),
          '--mode',
          'slow',
          '--cancel-after-ms',
          '30',
          '--report',
          target,
        ],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(result.status).toBe(130);
      expect(
        (JSON.parse(readFileSync(target, 'utf8')) as RunReport).status,
      ).toBe('cancelled');
    } finally {
      try {
        unlinkSync(target);
      } catch {
        /* No report if the subprocess failed. */
      }
    }
  });
});
