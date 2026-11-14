import { Agent, request } from 'undici';
import {
  executionError,
  jsonValueSchema,
  type HttpTransport,
  type JsonValue,
} from '@project-neo/workflow-core';

export interface TransportOptions {
  maxResponseBytes?: number;
  maxJsonBytes?: number;
  maxPreviewBytes?: number;
}

/** Raw, bounded responses; HTTP error status codes are ordinary responses. */
export function createUndiciTransport(
  options: TransportOptions = {},
): HttpTransport & { close(): Promise<void> } {
  const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  const maxJsonBytes = options.maxJsonBytes ?? 1_048_576;
  const maxPreviewBytes = options.maxPreviewBytes ?? 8_192;
  for (const [name, value] of Object.entries({
    maxResponseBytes,
    maxJsonBytes,
    maxPreviewBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(name + ' must be a non-negative safe integer.');
  }
  const agent = new Agent({ connect: { timeout: 10_000 } });
  return {
    async execute(prepared, signal) {
      const started = performance.now();
      try {
        const response = await request(prepared.url, {
          dispatcher: agent,
          method: prepared.method,
          headers: prepared.headers.flatMap((header) => [
            header.name,
            header.value,
          ]),
          ...(prepared.body === undefined ? {} : { body: prepared.body }),
          signal,
          // The runner owns the request deadline, including body consumption.
          headersTimeout: 0,
          bodyTimeout: 0,
          // No redirect or retry interceptor is installed on this agent.
        });
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > maxResponseBytes) {
            response.body.destroy();
            throw executionError(
              'RESPONSE_TOO_LARGE',
              'Response exceeded the configured byte limit.',
              [],
              { maxResponseBytes },
            );
          }
          chunks.push(buffer);
        }
        const body = Buffer.concat(chunks);
        const headers = Object.entries(response.headers).flatMap(
          ([name, values]) =>
            values === undefined
              ? []
              : (Array.isArray(values) ? values : [values]).map((value) => ({
                  name,
                  value,
                })),
        );
        const contentType =
          headers
            .find((header) => header.name === 'content-type')
            ?.value.toLowerCase() ?? '';
        let parsed: JsonValue | undefined;
        let jsonParse:
          'parsed' | 'not-json' | 'invalid-json' | 'limit-exceeded' =
          'not-json';
        if (
          contentType.split(';')[0]!.trim() === 'application/json' ||
          /\+json(?:;|$)/.test(contentType)
        ) {
          if (body.length > maxJsonBytes) jsonParse = 'limit-exceeded';
          else {
            try {
              parsed = jsonValueSchema.parse(JSON.parse(body.toString('utf8')));
              jsonParse = 'parsed';
            } catch {
              jsonParse = 'invalid-json';
            }
          }
        }
        return {
          status: response.statusCode,
          headers,
          body: {
            encoding: 'base64',
            data: body.toString('base64'),
            byteLength: body.length,
            preview: body.subarray(0, maxPreviewBytes).toString('utf8'),
            previewTruncated: body.length > maxPreviewBytes,
            jsonParse,
          },
          ...(parsed === undefined ? {} : { json: parsed }),
          durationMs: performance.now() - started,
        };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof Error && 'issue' in error) throw error;
        throw executionError(
          'TRANSPORT_ERROR',
          error instanceof Error ? error.message : 'HTTP transport failed.',
        );
      }
    },
    close: () => agent.destroy(),
  };
}
