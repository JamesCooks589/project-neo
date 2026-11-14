import type { JsonValue, RequestDefinition } from './schema';
import { executionError } from './runtime';
import type { PreparedRequest } from './transport';
import { type ResolutionContext, resolveValue } from './values';

export const sensitiveName =
  /authorization|password|token|secret|cookie|api[-_]?key/i;
const headerName = /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/;

function validateHeader(
  name: string,
  value: string,
  path: (string | number)[],
) {
  if (!headerName.test(name) || /[\r\n]/.test(value)) {
    throw executionError(
      'INVALID_HEADER',
      'Headers need a valid name and a value without line breaks.',
      path,
    );
  }
}

function stringValue(value: JsonValue, path: (string | number)[]): string {
  if (typeof value !== 'string')
    throw executionError(
      'TYPE_MISMATCH',
      'This field must resolve to a string.',
      path,
    );
  return value;
}

function scalar(value: JsonValue, path: (string | number)[]): string {
  if (value === null || typeof value === 'object') {
    throw executionError(
      'TYPE_MISMATCH',
      'URL and parameter values must be strings, numbers or booleans.',
      path,
    );
  }
  return String(value);
}

export async function prepareRequest(
  definition: RequestDefinition,
  context: ResolutionContext,
  rememberSecret: (value: string) => void,
): Promise<PreparedRequest> {
  const base = stringValue(
    await resolveValue(definition.url.base, context, ['url', 'base']),
    ['url', 'base'],
  );
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    throw executionError(
      'INVALID_URL',
      'The request base must be an absolute HTTP(S) URL.',
      ['url', 'base'],
    );
  }
  if (baseUrl.password) rememberSecret(baseUrl.password);
  if (
    !['http:', 'https:'].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw executionError(
      'INVALID_URL',
      'Use an HTTP(S) base without embedded credentials, query or fragment.',
      ['url', 'base'],
    );
  }
  const path = definition.url.path.replace(
    /\{([^{}]*)\}/g,
    (_match, name: string) => {
      const values = context.requestInputs;
      if (values === undefined || !Object.hasOwn(values, name)) {
        throw executionError(
          'MISSING_VALUE',
          'Path input "' + name + '" is missing.',
          ['url', 'path', name],
        );
      }
      const value = scalar(values[name]!, ['url', 'path', name]);
      if (value === '.' || value === '..')
        throw executionError(
          'INVALID_PATH_VALUE',
          'Dot-only path segments are not supported.',
          ['url', 'path', name],
        );
      return encodeURIComponent(value);
    },
  );
  // Appending to the pathname keeps //path from changing the request origin.
  baseUrl.pathname = baseUrl.pathname.replace(/\/$/, '') + path;
  const headers: PreparedRequest['headers'] = [];
  for (const [index, header] of definition.headers.entries()) {
    if (!header.enabled) continue;
    const value = scalar(
      await resolveValue(header.value, context, ['headers', index, 'value']),
      ['headers', index, 'value'],
    );
    validateHeader(header.name, value, ['headers', index]);
    if (sensitiveName.test(header.name)) rememberSecret(value);
    headers.push({ name: header.name, value });
  }
  for (const [index, query] of definition.query.entries()) {
    if (!query.enabled) continue;
    const value = scalar(
      await resolveValue(query.value, context, ['query', index, 'value']),
      ['query', index, 'value'],
    );
    if (sensitiveName.test(query.name)) rememberSecret(value);
    baseUrl.searchParams.append(query.name, value);
  }
  function setHeader(name: string, value: string) {
    validateHeader(name, value, ['auth']);
    for (let i = headers.length - 1; i >= 0; i--) {
      if (headers[i]!.name.toLowerCase() === name.toLowerCase())
        headers.splice(i, 1);
    }
    rememberSecret(value);
    headers.push({ name, value });
  }
  const auth = definition.auth;
  if (auth?.kind === 'basic') {
    const username = stringValue(
      await resolveValue(auth.username, context, ['auth', 'username']),
      ['auth', 'username'],
    );
    const password = stringValue(
      await resolveValue(auth.password, context, ['auth', 'password']),
      ['auth', 'password'],
    );
    rememberSecret(password);
    setHeader(
      'Authorization',
      'Basic ' +
        Buffer.from(username + ':' + password, 'utf8').toString('base64'),
    );
  } else if (auth?.kind === 'bearer') {
    const token = stringValue(
      await resolveValue(auth.token, context, ['auth', 'token']),
      ['auth', 'token'],
    );
    rememberSecret(token);
    setHeader('Authorization', 'Bearer ' + token);
  } else if (auth?.kind === 'apiKey') {
    const value = stringValue(
      await resolveValue(auth.value, context, ['auth', 'value']),
      ['auth', 'value'],
    );
    rememberSecret(value);
    if (auth.in === 'header') setHeader(auth.name, value);
    else baseUrl.searchParams.set(auth.name, value);
  }
  let body: string | undefined;
  if (definition.body !== undefined && definition.body.kind !== 'none') {
    const value = await resolveValue(definition.body.value, context, [
      'body',
      'value',
    ]);
    if (definition.body.kind === 'json') {
      body = JSON.stringify(value);
      if (
        !headers.some((header) => header.name.toLowerCase() === 'content-type')
      ) {
        headers.push({ name: 'Content-Type', value: 'application/json' });
      }
    } else body = stringValue(value, ['body', 'value']);
  }
  return {
    method: definition.method,
    url: baseUrl.toString(),
    headers,
    ...(body === undefined ? {} : { body }),
    timeoutMs: definition.timeoutMs,
  };
}
