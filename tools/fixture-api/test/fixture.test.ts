import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { startFixture } from '../src';

let fixture: Awaited<ReturnType<typeof startFixture>>;
beforeAll(async () => {
  fixture = await startFixture();
});
afterAll(async () => {
  await fixture.close();
});

async function create(mode = 'success', completeAfterPolls = 3) {
  const response = await fetch(fixture.baseUrl + '/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, completeAfterPolls }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { jobId?: string },
  };
}

describe('controlled local API', () => {
  test('completes a job on its configured third poll and exposes its result', async () => {
    const created = await create();
    expect(created.status).toBe(202);
    const path = fixture.baseUrl + '/jobs/' + created.body.jobId;
    const early = await fetch(path + '/result');
    expect(early.status).toBe(409);
    await early.arrayBuffer();
    const states = [];
    for (let count = 0; count < 3; count++) {
      const response = await fetch(path);
      const body = (await response.json()) as { state: string };
      states.push(body.state);
    }
    expect(states).toEqual(['processing', 'processing', 'completed']);
    expect(await (await fetch(path + '/result')).json()).toEqual({
      recordIds: ['record_123'],
    });
  });

  test('keeps poll counters local to each job', async () => {
    const first = await create('success', 1);
    const second = await create('success', 2);
    const a = (await (
      await fetch(fixture.baseUrl + '/jobs/' + first.body.jobId)
    ).json()) as { state: string };
    const b = (await (
      await fetch(fixture.baseUrl + '/jobs/' + second.body.jobId)
    ).json()) as { state: string };
    expect(a.state).toBe('completed');
    expect(b.state).toBe('processing');
  });

  test('keeps servers isolated from each other', async () => {
    const created = await create();
    const other = await startFixture();
    try {
      const response = await fetch(
        other.baseUrl + '/jobs/' + created.body.jobId,
      );
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    } finally {
      await other.close();
    }
  });

  test('provides rejected and missing-ID fixture variants', async () => {
    expect((await create('rejected')).status).toBe(400);
    expect(await create('missing-id')).toEqual({ status: 202, body: {} });
  });

  test.each([
    ['text/plain', '{}', 415],
    ['application/json', '{broken', 400],
    ['application/json', '{"mode":"unknown"}', 400],
    ['application/json', '{"completeAfterPolls":0}', 400],
    ['application/json', '"' + 'x'.repeat(70_000) + '"', 413],
  ])(
    'rejects malformed fixture configuration (%s -> %s)',
    async (contentType, body, status) => {
      const response = await fetch(fixture.baseUrl + '/jobs', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
      });
      expect(response.status).toBe(status);
      await response.arrayBuffer();
    },
  );

  test('has a health route and reports invalid or unknown routes', async () => {
    expect(await (await fetch(fixture.baseUrl + '/health')).json()).toEqual({
      status: 'ok',
    });
    for (const [path, status] of [
      ['/status/100', 400],
      ['/unknown', 404],
    ] as const) {
      const response = await fetch(fixture.baseUrl + path);
      expect(response.status).toBe(status);
      await response.arrayBuffer();
    }
  });
});
