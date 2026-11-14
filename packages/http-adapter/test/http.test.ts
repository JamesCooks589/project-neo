import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { startFixture } from '@project-neo/fixture-api';
import type { PreparedRequest } from '@project-neo/workflow-core';
import { createUndiciTransport } from '../src';

let fixture: Awaited<ReturnType<typeof startFixture>>;
let http: ReturnType<typeof createUndiciTransport>;
beforeAll(async () => {
  fixture = await startFixture();
  http = createUndiciTransport();
});
afterAll(async () => {
  await http.close();
  await fixture.close();
});
function request(path: string): PreparedRequest {
  return {
    method: 'GET',
    url: fixture.baseUrl + path,
    headers: [],
    timeoutMs: 1000,
  };
}
const signal = () => new AbortController().signal;

describe('real HTTP transport', () => {
  test('keeps raw bytes, parsed JSON and a bounded preview separate', async () => {
    const result = await http.execute(request('/health'), signal());
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: 'ok' });
    expect(Buffer.from(result.body.data, 'base64').toString('utf8')).toBe(
      '{"status":"ok"}',
    );
    expect(result.body).toMatchObject({
      byteLength: 15,
      previewTruncated: false,
      jsonParse: 'parsed',
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test.each([401, 500])(
    'preserves received HTTP %i as an inspectable response',
    async (status) => {
      expect(
        (await http.execute(request('/status/' + status), signal())).status,
      ).toBe(status);
    },
  );

  test('does not follow redirects', async () => {
    const before = fixture.observations.length;
    const result = await http.execute(request('/redirect'), signal());
    expect(result.status).toBe(302);
    expect(fixture.observations.slice(before)).toEqual([
      { method: 'GET', path: '/redirect' },
    ]);
  });

  test('preserves non-JSON and malformed JSON responses without making them transport errors', async () => {
    const text = await http.execute(request('/text'), signal());
    expect(text.body.jsonParse).toBe('not-json');
    expect(text.json).toBeUndefined();
    const invalid = await http.execute(request('/invalid-json'), signal());
    expect(invalid.status).toBe(200);
    expect(invalid.body.jsonParse).toBe('invalid-json');
    expect(Buffer.from(invalid.body.data, 'base64').toString('utf8')).toBe(
      '{broken',
    );
  });

  test('sends typed JSON and explicit headers unchanged', async () => {
    const body = {
      number: 4,
      boolean: false,
      object: { name: 'neo' },
      list: [1, true],
    };
    const result = await http.execute(
      {
        ...request('/echo?value=a%2Fb'),
        method: 'POST',
        headers: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'X-Test', value: 'yes' },
        ],
        body: JSON.stringify(body),
      },
      signal(),
    );
    expect(result.json).toMatchObject({
      body,
      url: '/echo?value=a%2Fb',
      headers: { 'x-test': 'yes' },
    });
  });

  test('reports response, parse and preview limits explicitly', async () => {
    const limited = createUndiciTransport({ maxResponseBytes: 10 });
    const previews = createUndiciTransport({
      maxPreviewBytes: 4,
      maxJsonBytes: 4,
    });
    try {
      await expect(
        limited.execute(request('/health'), signal()),
      ).rejects.toMatchObject({ issue: { code: 'RESPONSE_TOO_LARGE' } });
      const result = await previews.execute(request('/health'), signal());
      expect(result.body.preview).toBe('{"st');
      expect(result.body.previewTruncated).toBe(true);
      expect(result.body.jsonParse).toBe('limit-exceeded');
      expect(result.json).toBeUndefined();
      expect(Buffer.from(result.body.data, 'base64').byteLength).toBe(15);
    } finally {
      await limited.close();
      await previews.close();
    }
  });

  test('distinguishes a connection failure and does not retry it', async () => {
    const before = fixture.observations.length;
    await expect(
      http.execute(request('/disconnect'), signal()),
    ).rejects.toMatchObject({ issue: { code: 'TRANSPORT_ERROR' } });
    expect(fixture.observations.slice(before)).toEqual([
      { method: 'GET', path: '/disconnect' },
    ]);
  });

  test('rejects invalid adapter limits', () => {
    expect(() => createUndiciTransport({ maxResponseBytes: -1 })).toThrow();
    expect(() => createUndiciTransport({ maxJsonBytes: 1.5 })).toThrow();
  });
});
