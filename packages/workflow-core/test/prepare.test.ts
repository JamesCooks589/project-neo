import { describe, expect, test } from '@jest/globals';
import {
  prepareRequest,
  type ResolutionContext,
  requestDefinitionSchema,
} from '../src';

function context(): ResolutionContext {
  return {
    workflowInputs: {},
    environment: { baseUrl: 'https://fixture.test/api' },
    requestInputs: { id: 'a/b ?#', count: 3, enabled: false },
    scope: { outputs: new Map() },
    signal: new AbortController().signal,
    secret: async () => 'private-key-value',
  };
}
function definition() {
  return requestDefinitionSchema.parse({
    id: 'saved',
    revision: 1,
    name: 'Request',
    method: 'POST',
    inputs: { id: { type: 'string', required: true } },
    url: { base: { kind: 'environment', name: 'baseUrl' }, path: '/jobs/{id}' },
  });
}
const ignore = () => {};

describe('request preparation before dispatch', () => {
  test('encodes path inputs as one segment and serializes scalar query/header values', async () => {
    const request = definition();
    request.query = [
      {
        name: 'count',
        enabled: true,
        value: { kind: 'requestInput', name: 'count' },
      },
      {
        name: 'enabled',
        enabled: true,
        value: { kind: 'requestInput', name: 'enabled' },
      },
      {
        name: 'disabled',
        enabled: false,
        value: { kind: 'environment', name: 'missing' },
      },
    ];
    request.headers = [
      {
        name: 'x-count',
        enabled: true,
        value: { kind: 'requestInput', name: 'count' },
      },
      {
        name: 'x-disabled',
        enabled: false,
        value: { kind: 'environment', name: 'missing' },
      },
    ];
    const prepared = await prepareRequest(request, context(), ignore);
    const url = new URL(prepared.url);
    expect(url.pathname).toBe('/api/jobs/a%2Fb%20%3F%23');
    expect(url.searchParams.get('count')).toBe('3');
    expect(url.searchParams.get('enabled')).toBe('false');
    expect(prepared.headers).toEqual([{ name: 'x-count', value: '3' }]);
  });

  test('keeps a double-slash path on the selected origin', async () => {
    const request = definition();
    request.url.path = '//other.test/path';
    const result = await prepareRequest(request, context(), ignore);
    expect(new URL(result.url).origin).toBe('https://fixture.test');
  });

  test('preserves typed JSON bodies and supplies Content-Type only when omitted', async () => {
    const request = definition();
    request.body = {
      kind: 'json',
      value: {
        kind: 'object',
        entries: {
          number: { kind: 'requestInput', name: 'count' },
          boolean: { kind: 'requestInput', name: 'enabled' },
          list: { kind: 'literal', value: [1, { nested: true }] },
        },
      },
    };
    const first = await prepareRequest(request, context(), ignore);
    expect(JSON.parse(first.body!)).toEqual({
      number: 3,
      boolean: false,
      list: [1, { nested: true }],
    });
    expect(first.headers).toContainEqual({
      name: 'Content-Type',
      value: 'application/json',
    });
    request.headers = [
      {
        name: 'content-type',
        enabled: true,
        value: { kind: 'literal', value: 'application/custom+json' },
      },
    ];
    const second = await prepareRequest(request, context(), ignore);
    expect(second.headers).toHaveLength(1);
    expect(second.headers[0]!.value).toBe('application/custom+json');
  });

  test('accepts text and explicit empty bodies', async () => {
    const request = definition();
    request.body = {
      kind: 'text',
      value: { kind: 'literal', value: 'plain text' },
    };
    expect((await prepareRequest(request, context(), ignore)).body).toBe(
      'plain text',
    );
    request.body = { kind: 'none' };
    expect(
      (await prepareRequest(request, context(), ignore)).body,
    ).toBeUndefined();
  });

  test('prepares Basic auth and replaces duplicate explicit authorization headers', async () => {
    const request = definition();
    request.headers = [
      {
        name: 'Authorization',
        enabled: true,
        value: { kind: 'literal', value: 'old' },
      },
      {
        name: 'authorization',
        enabled: true,
        value: { kind: 'literal', value: 'also-old' },
      },
    ];
    request.auth = {
      kind: 'basic',
      username: { kind: 'literal', value: 'james' },
      password: { kind: 'secret', name: 'password' },
    };
    const remembered: string[] = [];
    const result = await prepareRequest(request, context(), (value) =>
      remembered.push(value),
    );
    expect(result.headers).toEqual([
      {
        name: 'Authorization',
        value:
          'Basic ' + Buffer.from('james:private-key-value').toString('base64'),
      },
    ]);
    expect(remembered).toContain('private-key-value');
  });

  test.each(['header', 'query'] as const)(
    'puts API-key auth in the selected %s location',
    async (location) => {
      const request = definition();
      request.auth = {
        kind: 'apiKey',
        name: 'api_key',
        in: location,
        value: { kind: 'secret', name: 'key' },
      };
      request.query = [
        {
          name: 'api_key',
          enabled: true,
          value: { kind: 'literal', value: 'old-key' },
        },
      ];
      const result = await prepareRequest(request, context(), ignore);
      if (location === 'header')
        expect(result.headers).toContainEqual({
          name: 'api_key',
          value: 'private-key-value',
        });
      else
        expect(new URL(result.url).searchParams.getAll('api_key')).toEqual([
          'private-key-value',
        ]);
    },
  );

  test.each([
    'ftp://fixture.test',
    'not-a-url',
    'http://user:password@fixture.test',
    'http://fixture.test?query=yes',
    'http://fixture.test#fragment',
  ])('rejects an invalid or ambiguous base URL: %s', async (baseUrl) => {
    await expect(
      prepareRequest(
        definition(),
        { ...context(), environment: { baseUrl } },
        ignore,
      ),
    ).rejects.toMatchObject({ issue: { code: 'INVALID_URL' } });
  });

  test('rejects missing, object and dot-only path values before any dispatch', async () => {
    for (const requestInputs of [{}, { id: {} }, { id: '..' }, { id: '.' }]) {
      await expect(
        prepareRequest(definition(), { ...context(), requestInputs }, ignore),
      ).rejects.toHaveProperty('issue');
    }
  });

  test('rejects non-string URL/text fields and non-scalar parameters', async () => {
    await expect(
      prepareRequest(
        definition(),
        { ...context(), environment: { baseUrl: 4 } },
        ignore,
      ),
    ).rejects.toMatchObject({ issue: { code: 'TYPE_MISMATCH' } });
    const request = definition();
    request.body = { kind: 'text', value: { kind: 'literal', value: false } };
    await expect(
      prepareRequest(request, context(), ignore),
    ).rejects.toMatchObject({ issue: { code: 'TYPE_MISMATCH' } });
    request.body = { kind: 'none' };
    request.query = [
      { name: 'value', enabled: true, value: { kind: 'literal', value: {} } },
    ];
    await expect(
      prepareRequest(request, context(), ignore),
    ).rejects.toMatchObject({ issue: { code: 'TYPE_MISMATCH' } });
  });

  test('rejects header line breaks and invalid header names during preparation', async () => {
    const request = definition();
    for (const [name, value] of [
      ['x-test', 'hello\r\ninjected: yes'],
      ['bad name', 'value'],
    ]) {
      request.headers = [
        {
          name: name!,
          enabled: true,
          value: { kind: 'literal', value: value! },
        },
      ];
      await expect(
        prepareRequest(request, context(), ignore),
      ).rejects.toMatchObject({ issue: { code: 'INVALID_HEADER' } });
    }
    request.headers = [];
    request.auth = {
      kind: 'bearer',
      token: { kind: 'literal', value: 'bad\r\ntoken' },
    };
    await expect(
      prepareRequest(request, context(), ignore),
    ).rejects.toMatchObject({
      issue: { code: 'INVALID_HEADER', path: ['auth'] },
    });
  });
});
