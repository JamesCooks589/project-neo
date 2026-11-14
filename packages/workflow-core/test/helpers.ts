import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type ValidationIssue,
  type WorkflowBundle,
  type WorkflowGraph,
  type WorkflowNode,
  validateWorkflowBundle,
} from '../src';

export function rawExample(): unknown {
  return JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../../examples/job-polling.bundle.json'),
      'utf8',
    ),
  );
}

export function example(): WorkflowBundle {
  const result = validateWorkflowBundle(rawExample());
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

export function node<T extends WorkflowNode['type']>(
  graph: WorkflowGraph,
  id: string,
  type: T,
) {
  const found = graph.nodes.find((item) => item.id === id);
  if (found?.type !== type)
    throw new Error('Test example node not found: ' + id);
  return found as WorkflowNode & { type: T };
}

export function errorsFor(input: unknown): ValidationIssue[] {
  const result = validateWorkflowBundle(input);
  if (result.ok) throw new Error('Expected validation to fail.');
  return result.errors;
}
