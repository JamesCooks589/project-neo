import { describe, expect, test } from '@jest/globals';
import { type WorkflowBundle, validateWorkflowBundle } from '../src';
import { errorsFor, example, node } from './helpers';

function rejects(code: string, change: (bundle: WorkflowBundle) => void) {
  const bundle = example();
  change(bundle);
  expect(errorsFor(bundle)).toEqual(
    expect.arrayContaining([expect.objectContaining({ code })]),
  );
}

describe('control flow validation', () => {
  test('uses connections rather than node array order', () => {
    const bundle = example();
    bundle.workflow.nodes.reverse();
    node(bundle.workflow, 'wait_for_job', 'repeat').body.nodes.reverse();
    expect(validateWorkflowBundle(bundle).ok).toBe(true);
  });

  test('rejects duplicate saved request IDs', () => {
    rejects('DUPLICATE_ID', (bundle) =>
      bundle.requests.push(structuredClone(bundle.requests[0]!)),
    );
  });

  test('rejects duplicate node IDs in the same graph', () => {
    rejects('DUPLICATE_ID', (bundle) =>
      bundle.workflow.nodes.push(structuredClone(bundle.workflow.nodes[0]!)),
    );
  });

  test('requires globally unique IDs across loop boundaries', () => {
    rejects('DUPLICATE_ID', (bundle) => {
      node(bundle.workflow, 'wait_for_job', 'repeat').body.nodes[0]!.id =
        'create_job';
    });
  });

  test('rejects a missing entry', () => {
    rejects('INVALID_ENTRY', (bundle) => {
      bundle.workflow.entryNodeId = 'unknown';
    });
  });

  test('rejects nodes disconnected from the entry', () => {
    rejects('UNREACHABLE_NODE', (bundle) => {
      bundle.workflow.nodes.push({
        id: 'orphan',
        type: 'end',
        outcome: 'passed',
      });
    });
  });

  test.each(['from', 'to'] as const)(
    'rejects missing edge %s nodes',
    (field) => {
      rejects('DANGLING_EDGE', (bundle) => {
        bundle.workflow.edges[0]![field] = 'unknown';
      });
    },
  );

  test('rejects an edge into a loop body', () => {
    rejects('DANGLING_EDGE', (bundle) => {
      bundle.workflow.edges[0]!.to = 'poll_request';
    });
  });

  test('rejects ports not exposed by the source node', () => {
    rejects('INVALID_PORT', (bundle) => {
      bundle.workflow.edges[0]!.port = 'true';
    });
  });

  test('rejects output from terminal nodes', () => {
    rejects('INVALID_PORT', (bundle) => {
      bundle.workflow.edges.push({
        from: 'passed',
        port: 'response',
        to: 'failed',
      });
    });
  });

  test.each(['true', 'false', 'completed', 'exhausted', 'response', 'pass'])(
    'requires the %s connection',
    (port) => {
      rejects('MISSING_CONNECTION', (bundle) => {
        bundle.workflow.edges = bundle.workflow.edges.filter(
          (edge) => edge.port !== port,
        );
      });
    },
  );

  test('rejects multiple destinations on one port', () => {
    rejects('MULTIPLE_CONNECTIONS', (bundle) => {
      bundle.workflow.edges.push({
        from: 'job_accepted',
        port: 'true',
        to: 'failed',
      });
    });
  });

  test('rejects duplicate edges, even if the destination is identical', () => {
    rejects('MULTIPLE_CONNECTIONS', (bundle) =>
      bundle.workflow.edges.push({ ...bundle.workflow.edges[0]! }),
    );
  });

  test('rejects self cycles', () => {
    rejects('UNSUPPORTED_CYCLE', (bundle) => {
      bundle.workflow.edges[0]!.to = 'create_job';
    });
  });

  test('detects cycles even in unreachable components', () => {
    rejects('UNSUPPORTED_CYCLE', (bundle) => {
      for (const id of ['cycle_a', 'cycle_b']) {
        bundle.workflow.nodes.push({
          id,
          type: 'request',
          requestRef: { id: 'req_create_job' },
          bindings: {},
        });
      }
      bundle.workflow.edges.push(
        { from: 'cycle_a', port: 'response', to: 'cycle_b' },
        { from: 'cycle_b', port: 'response', to: 'cycle_a' },
      );
    });
  });

  test('detects a cycle inside a repeat body', () => {
    rejects('UNSUPPORTED_CYCLE', (bundle) => {
      node(bundle.workflow, 'wait_for_job', 'repeat').body.edges[0]!.to =
        'poll_request';
    });
  });

  test('rejects return nodes in the outer graph', () => {
    rejects('INVALID_TERMINAL', (bundle) => {
      bundle.workflow.nodes = bundle.workflow.nodes.map((item) =>
        item.id === 'passed'
          ? {
              id: item.id,
              type: 'return',
              value: { kind: 'literal', value: true },
            }
          : item,
      );
    });
  });

  test('requires repeat body paths to return', () => {
    rejects('INVALID_TERMINAL', (bundle) => {
      const body = node(bundle.workflow, 'wait_for_job', 'repeat').body;
      body.nodes = body.nodes.map((item) =>
        item.id === 'return_poll'
          ? { id: item.id, type: 'end', outcome: 'passed' }
          : item,
      );
    });
  });

  test('rejects nested repeats in this draft', () => {
    rejects('NESTED_REPEAT', (bundle) => {
      const repeat = node(bundle.workflow, 'wait_for_job', 'repeat');
      const nested = structuredClone(repeat);
      nested.id = 'nested';
      repeat.body.nodes.push(nested);
    });
  });

  test('reports useful node and field locations', () => {
    const bundle = example();
    bundle.workflow.edges[0]!.port = 'invalid';
    expect(errorsFor(bundle)).toContainEqual({
      code: 'INVALID_PORT',
      nodeId: 'create_job',
      path: ['workflow', 'edges', 0, 'port'],
      message: expect.any(String),
    });
  });
});
