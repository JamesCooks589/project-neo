import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';
import Ajv2020 from 'ajv/dist/2020';
import { nodeSchema, validateWorkflowBundle } from '../src';
import { example, node, rawExample } from './helpers';

const exportedSchema: object = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../schemas/workflow-bundle.schema.json'),
    'utf8',
  ),
);
const validateJson = new Ajv2020({ strict: true, allErrors: true }).compile(
  exportedSchema,
);

describe('portable contract', () => {
  test('the committed JSON Schema accepts the complete example in an independent validator', () => {
    expect(validateJson(rawExample())).toBe(true);
    expect(validateJson.errors).toBeNull();
  });

  test('external authors receive structural checks for pointers and repeat bounds', () => {
    const bundle = example();
    const repeat = node(bundle.workflow, 'wait_for_job', 'repeat');
    repeat.maxIterations = 0;
    node(repeat.body, 'return_poll', 'return').value = {
      kind: 'stepOutput',
      nodeId: 'poll_request',
      path: 'response.json',
    };
    expect(validateJson(bundle)).toBe(false);
    expect(
      validateJson.errors?.some((error) => error.keyword === 'pattern'),
    ).toBe(true);
    expect(
      validateJson.errors?.some(
        (error) => error.keyword === 'exclusiveMinimum',
      ),
    ).toBe(true);
  });

  test('semantic graph checks remain necessary after JSON Schema validation', () => {
    const bundle = example();
    bundle.workflow.edges[0]!.to = 'missing';
    expect(validateJson(bundle)).toBe(true);
    expect(validateWorkflowBundle(bundle).ok).toBe(false);
  });

  test('default bindings are isolated between separately parsed nodes', () => {
    const definition = {
      id: 'request',
      type: 'request',
      requestRef: { id: 'saved_request' },
    };
    const first = nodeSchema.parse(definition);
    const second = nodeSchema.parse(definition);
    if (first.type !== 'request' || second.type !== 'request')
      throw new Error('Unexpected node type.');
    first.bindings.changed = { kind: 'literal', value: true };
    expect(second.bindings).toEqual({});
    expect(definition).not.toHaveProperty('bindings');
  });
});
