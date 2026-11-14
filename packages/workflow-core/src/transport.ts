import type { JsonValue, RequestDefinition } from './schema';

export interface HeaderEntry {
  name: string;
  value: string;
}
export interface PreparedRequest {
  method: RequestDefinition['method'];
  url: string;
  headers: HeaderEntry[];
  body?: string;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  headers: HeaderEntry[];
  body: {
    encoding: 'base64';
    data: string;
    byteLength: number;
    preview: string;
    previewTruncated: boolean;
    jsonParse: 'parsed' | 'not-json' | 'invalid-json' | 'limit-exceeded';
  };
  json?: JsonValue;
  durationMs: number;
}

export interface HttpTransport {
  execute(request: PreparedRequest, signal: AbortSignal): Promise<HttpResponse>;
}
