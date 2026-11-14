import { describe, expect, test } from '@jest/globals';
import {
  bundleJsonSchema,
  jsonValueSchema,
  valueSpecSchema,
  validateWorkflowBundle,
  workflowBundleSchema,
} from '../src';
import { example, node, rawExample } from './helpers';

describe('draft workflow contract', () => {
  test('accepts the complete handover example without modifying its input', () => {
    const input = rawExample();
    const before = JSON.stringify(input);
    const result = validateWorkflowBundle(input);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    if (!result.ok) throw new Error('Example did not validate.');
    expect(result.value.requests[0]).toMatchObject({
      inputs: {},
      headers: [],
      query: [],
      timeoutMs: 30_000,
    });
    expect(
      node(result.value.workflow, 'create_job', 'request').bindings,
    ).toEqual({});
  });

  test.each([
    ['unsupported bundle version', { ...example(), bundleVersion: 2 }],
    [
      'unsupported workflow version',
      { ...example(), workflow: { ...example().workflow, schemaVersion: 2 } },
    ],
    ['unknown fields', { ...example(), executeScript: 'arbitrary code' }],
    [
      'no nodes',
      { ...example(), workflow: { ...example().workflow, nodes: [] } },
    ],
    [
      'missing run limits',
      { ...example(), workflow: { ...example().workflow, limits: undefined } },
    ],
  ])('rejects %s', (_description, input) => {
    const result = validateWorkflowBundle(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Unexpected success.');
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SCHEMA_ERROR',
          path: expect.any(Array),
        }),
      ]),
    );
  });

  test.each([0, -1, 1.5, Infinity, NaN])(
    'requires a positive integer repeat bound: %s',
    (maxIterations) => {
      const bundle = example();
      node(bundle.workflow, 'wait_for_job', 'repeat').maxIterations =
        maxIterations;
      expect(workflowBundleSchema.safeParse(bundle).success).toBe(false);
    },
  );

  test('requires a repeat bound rather than supplying a hidden default', () => {
    const repeat = node(example().workflow, 'wait_for_job', 'repeat');
    const { maxIterations: _omitted, ...unbounded } = repeat;
    const bundle = example();
    const input = {
      ...bundle,
      workflow: {
        ...bundle.workflow,
        nodes: bundle.workflow.nodes.map((item) =>
          item.id === repeat.id ? unbounded : item,
        ),
      },
    };
    expect(workflowBundleSchema.safeParse(input).success).toBe(false);
  });

  test.each([
    { maxRunDurationMs: 0, maxNodeInvocations: 40 },
    { maxRunDurationMs: 30_000, maxNodeInvocations: -1 },
    { maxRunDurationMs: 30_000, maxNodeInvocations: 2.5 },
  ])('requires finite, positive run limits: %j', (limits) => {
    const bundle = example();
    bundle.workflow.limits = limits;
    expect(workflowBundleSchema.safeParse(bundle).success).toBe(false);
  });

  test('rejects a negative polling interval', () => {
    const bundle = example();
    node(bundle.workflow, 'wait_for_job', 'repeat').intervalMs = -1;
    expect(workflowBundleSchema.safeParse(bundle).success).toBe(false);
  });

  test.each(['', '/response/json/jobId', '/a~1b/~0name', '/'])(
    'accepts JSON Pointer %j',
    (path) => {
      expect(
        valueSpecSchema.safeParse({
          kind: 'stepOutput',
          nodeId: 'source',
          path,
        }).success,
      ).toBe(true);
    },
  );

  test.each([
    'response.json.jobId',
    '$.response',
    '/bad~2escape',
    '/trailing~',
  ])('rejects non-pointer path %j', (path) => {
    expect(
      valueSpecSchema.safeParse({ kind: 'stepOutput', nodeId: 'source', path })
        .success,
    ).toBe(false);
  });

  test('retains JSON types and treats literal objects as data', () => {
    const value = {
      kind: 'object',
      entries: {
        count: { kind: 'literal', value: 3 },
        enabled: { kind: 'literal', value: false },
        missing: { kind: 'literal', value: null },
        items: {
          kind: 'array',
          items: [{ kind: 'literal', value: [1, true, { name: 'neo' }] }],
        },
        data: {
          kind: 'literal',
          value: { kind: 'stepOutput', nodeId: 'not_a_reference' },
        },
      },
    };
    expect(valueSpecSchema.parse(value)).toEqual(value);
    const bundle = example();
    bundle.requests[0]!.body = {
      kind: 'json',
      value: valueSpecSchema.parse(value),
    };
    expect(validateWorkflowBundle(bundle).ok).toBe(true);
  });

  test.each([undefined, () => 1, new Map(), Infinity, NaN, BigInt(1)])(
    'rejects non-JSON literal values: %s',
    (value) => {
      expect(jsonValueSchema.safeParse(value).success).toBe(false);
    },
  );

  test('rejects arbitrary script value kinds', () => {
    expect(
      valueSpecSchema.safeParse({ kind: 'script', code: 'return 42' }).success,
    ).toBe(false);
  });

  test('exports a versioned structural JSON Schema for external authors', () => {
    const schema = bundleJsonSchema();
    expect(schema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'urn:project-neo:workflow-bundle:1',
      title: 'Project Neo workflow bundle (draft v0.1)',
    });
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});
