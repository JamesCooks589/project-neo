import { describe, expect, test } from '@jest/globals';
import {
  type InputDeclaration,
  type JsonValue,
  type Predicate,
  type ValueSpec,
  type WorkflowBundle,
  validateWorkflowBundle,
} from '../src';
import { errorsFor, example, node } from './helpers';

function rejects(code: string, change: (bundle: WorkflowBundle) => void) {
  const bundle = example();
  change(bundle);
  expect(errorsFor(bundle)).toEqual(
    expect.arrayContaining([expect.objectContaining({ code })]),
  );
}

function setBinding(bundle: WorkflowBundle, binding: ValueSpec) {
  node(bundle.workflow, 'download_result', 'request').bindings.jobId = binding;
}

describe('saved request inputs and templates', () => {
  test('requires referenced saved requests to be present', () => {
    rejects('UNKNOWN_REQUEST', (bundle) => {
      bundle.requests.shift();
    });
  });

  test('requires bindings for required inputs', () => {
    rejects('MISSING_INPUT', (bundle) => {
      delete node(bundle.workflow, 'download_result', 'request').bindings.jobId;
    });
  });

  test('accepts a required input supplied by a default', () => {
    const bundle = example();
    bundle.requests[2]!.inputs.jobId!.default = 'job_123';
    delete node(bundle.workflow, 'download_result', 'request').bindings.jobId;
    expect(validateWorkflowBundle(bundle).ok).toBe(true);
  });

  test('rejects undeclared bindings, including inherited object property names', () => {
    rejects('UNKNOWN_INPUT', (bundle) => {
      Object.defineProperty(
        node(bundle.workflow, 'download_result', 'request').bindings,
        'toString',
        {
          value: { kind: 'literal', value: 'invalid' },
          enumerable: true,
        },
      );
    });
  });

  test('rejects literal binding type mismatches', () => {
    rejects('TYPE_MISMATCH', (bundle) =>
      setBinding(bundle, { kind: 'literal', value: 123 }),
    );
  });

  test('checks input types supplied by workflow references', () => {
    rejects('TYPE_MISMATCH', (bundle) => {
      bundle.workflow.inputs.count = { type: 'number', required: true };
      setBinding(bundle, { kind: 'workflowInput', name: 'count' });
    });
  });

  test('checks composed object and array binding types', () => {
    rejects('TYPE_MISMATCH', (bundle) =>
      setBinding(bundle, { kind: 'object', entries: {} }),
    );
    rejects('TYPE_MISMATCH', (bundle) =>
      setBinding(bundle, { kind: 'array', items: [] }),
    );
  });

  test('checks saved request and workflow input defaults', () => {
    rejects('TYPE_MISMATCH', (bundle) => {
      bundle.requests[1]!.inputs.jobId!.default = 12;
    });
    rejects('TYPE_MISMATCH', (bundle) => {
      bundle.workflow.inputs.expectedRecordId!.default = false;
    });
  });

  test.each<[InputDeclaration['type'], JsonValue]>([
    ['string', 'hello'],
    ['number', 42],
    ['boolean', false],
    ['array', [1, 'two']],
    ['object', { enabled: true }],
  ])('accepts a typed %s default', (type, value) => {
    const bundle = example();
    bundle.workflow.inputs.typed = {
      type,
      default: structuredClone(value),
      required: false,
    };
    expect(validateWorkflowBundle(bundle).ok).toBe(true);
  });

  test('requires referenced workflow inputs to exist', () => {
    rejects('UNKNOWN_INPUT', (bundle) =>
      setBinding(bundle, { kind: 'workflowInput', name: 'missing' }),
    );
  });

  test('separates workflow bindings from saved request templates', () => {
    rejects('INVALID_REFERENCE_SCOPE', (bundle) =>
      setBinding(bundle, { kind: 'requestInput', name: 'jobId' }),
    );
    rejects('INVALID_REFERENCE_SCOPE', (bundle) => {
      bundle.requests[0]!.body = {
        kind: 'json',
        value: { kind: 'workflowInput', name: 'expectedRecordId' },
      };
    });
    rejects('INVALID_REFERENCE_SCOPE', (bundle) => {
      bundle.requests[0]!.body = {
        kind: 'json',
        value: { kind: 'stepOutput', nodeId: 'create_job', path: '' },
      };
    });
  });

  test('requires requestInput references to be declared', () => {
    rejects('UNKNOWN_INPUT', (bundle) => {
      bundle.requests[0]!.body = {
        kind: 'json',
        value: { kind: 'requestInput', name: 'missing' },
      };
    });
  });

  test('validates nested request template values, query, headers and basic auth', () => {
    const bundle = example();
    const request = bundle.requests[2]!;
    request.body = {
      kind: 'text',
      value: { kind: 'requestInput', name: 'jobId' },
    };
    request.query = [
      {
        name: 'id',
        enabled: true,
        value: { kind: 'requestInput', name: 'jobId' },
      },
    ];
    request.headers = [
      {
        name: 'x-test',
        enabled: true,
        value: {
          kind: 'object',
          entries: {
            nested: {
              kind: 'array',
              items: [{ kind: 'requestInput', name: 'jobId' }],
            },
          },
        },
      },
    ];
    request.auth = {
      kind: 'basic',
      username: { kind: 'literal', value: 'fixture-user' },
      password: { kind: 'secret', name: 'fixturePassword' },
    };
    expect(validateWorkflowBundle(bundle).ok).toBe(true);
    request.query[0]!.value = { kind: 'requestInput', name: 'missing' };
    expect(errorsFor(bundle)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNKNOWN_INPUT',
          requestId: 'req_get_result',
          path: ['requests', 2, 'query', 0, 'value', 'name'],
        }),
      ]),
    );
  });

  test('validates bearer and API-key auth references', () => {
    const bundle = example();
    bundle.requests[0]!.auth = {
      kind: 'bearer',
      token: { kind: 'secret', name: 'token' },
    };
    bundle.requests[1]!.auth = {
      kind: 'apiKey',
      name: 'key',
      in: 'header',
      value: { kind: 'secret', name: 'key' },
    };
    bundle.requests[2]!.auth = { kind: 'none' };
    expect(validateWorkflowBundle(bundle).ok).toBe(true);
    bundle.requests[1]!.auth.value = { kind: 'requestInput', name: 'missing' };
    expect(errorsFor(bundle)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNKNOWN_INPUT' }),
      ]),
    );
  });

  test.each(['/{missing}', '/{jobId', '/jobs?query=value', '/jobs#fragment'])(
    'rejects invalid path template %s',
    (path) => {
      const bundle = example();
      bundle.requests[1]!.url.path = path;
      expect(validateWorkflowBundle(bundle).ok).toBe(false);
    },
  );

  test.each(['ftp://example.test', 'not-a-url'])(
    'rejects invalid literal HTTP base %s',
    (value) => {
      rejects('INVALID_URL_BASE', (bundle) => {
        bundle.requests[0]!.url.base = { kind: 'literal', value };
      });
    },
  );

  test('accepts a literal HTTP base', () => {
    const bundle = example();
    bundle.requests[0]!.url.base = {
      kind: 'literal',
      value: 'https://example.test',
    };
    expect(validateWorkflowBundle(bundle).ok).toBe(true);
  });

  test('rejects statically non-string URL bases and text bodies', () => {
    rejects('TYPE_MISMATCH', (bundle) => {
      bundle.requests[0]!.url.base = { kind: 'literal', value: 42 };
    });
    rejects('TYPE_MISMATCH', (bundle) => {
      bundle.requests[0]!.body = {
        kind: 'text',
        value: { kind: 'literal', value: false },
      };
    });
  });

  test('supports an explicit empty request body', () => {
    const bundle = example();
    bundle.requests[0]!.body = { kind: 'none' };
    expect(validateWorkflowBundle(bundle).ok).toBe(true);
  });

  test('requires used environment references to be declared', () => {
    rejects('UNDECLARED_ENVIRONMENT', (bundle) => {
      bundle.workflow.environmentRequirements = [];
    });
    rejects('UNDECLARED_ENVIRONMENT', (bundle) =>
      setBinding(bundle, { kind: 'environment', name: 'missing' }),
    );
  });

  test('allows unused library requests with other environment requirements', () => {
    const bundle = example();
    bundle.requests.push({
      ...structuredClone(bundle.requests[0]!),
      id: 'unused_request',
      url: {
        base: { kind: 'environment', name: 'otherBaseUrl' },
        path: '/other',
      },
    });
    expect(validateWorkflowBundle(bundle).ok).toBe(true);
  });

  test('rejects duplicate environment requirements', () => {
    rejects('DUPLICATE_ENVIRONMENT', (bundle) => {
      bundle.workflow.environmentRequirements.push('baseUrl');
    });
  });
});

describe('output availability and loop scope', () => {
  test('accepts an upstream outer result inside a loop', () => {
    expect(validateWorkflowBundle(example()).ok).toBe(true);
  });

  test('rejects a reference to a missing node', () => {
    rejects('UNKNOWN_STEP_OUTPUT', (bundle) =>
      setBinding(bundle, { kind: 'stepOutput', nodeId: 'missing', path: '' }),
    );
  });

  test('rejects self and future output references', () => {
    rejects('UNAVAILABLE_STEP_OUTPUT', (bundle) =>
      setBinding(bundle, {
        kind: 'stepOutput',
        nodeId: 'download_result',
        path: '',
      }),
    );
    rejects('UNAVAILABLE_STEP_OUTPUT', (bundle) => {
      node(bundle.workflow, 'job_accepted', 'condition').predicate = {
        op: 'exists',
        value: { kind: 'stepOutput', nodeId: 'download_result', path: '' },
      };
    });
  });

  test('rejects a result from a branch that may be skipped', () => {
    rejects('UNAVAILABLE_STEP_OUTPUT', (bundle) => {
      bundle.workflow.nodes.push({
        id: 'rejected_branch',
        type: 'request',
        requestRef: { id: 'req_create_job' },
        bindings: {},
      });
      bundle.workflow.edges.find(
        (edge) => edge.from === 'job_accepted' && edge.port === 'false',
      )!.to = 'rejected_branch';
      bundle.workflow.edges.push({
        from: 'rejected_branch',
        port: 'response',
        to: 'download_result',
      });
      setBinding(bundle, {
        kind: 'stepOutput',
        nodeId: 'rejected_branch',
        path: '/response/json/jobId',
      });
    });
  });

  test('rejects reaching from outside a repeat into its body', () => {
    rejects('INVALID_REFERENCE_SCOPE', (bundle) =>
      setBinding(bundle, {
        kind: 'stepOutput',
        nodeId: 'poll_request',
        path: '/response/json/jobId',
      }),
    );
  });

  test('requires until to use bodyResult rather than a body node', () => {
    rejects('INVALID_REFERENCE_SCOPE', (bundle) => {
      node(bundle.workflow, 'wait_for_job', 'repeat').until = {
        op: 'exists',
        value: { kind: 'stepOutput', nodeId: 'poll_request', path: '' },
      };
    });
  });

  test('accepts repeat exports outside the body', () => {
    const bundle = example();
    setBinding(bundle, {
      kind: 'stepOutput',
      nodeId: 'wait_for_job',
      path: '/result/response/json/jobId',
    });
    expect(validateWorkflowBundle(bundle).ok).toBe(true);
  });

  test('exposes current loop context in the body and completion predicate', () => {
    const bundle = example();
    const repeat = node(bundle.workflow, 'wait_for_job', 'repeat');
    node(repeat.body, 'poll_status_ok', 'assert').predicate = {
      op: 'gt',
      left: { kind: 'loopContext', path: '/iteration' },
      right: { kind: 'literal', value: 0 },
    };
    repeat.until = { op: 'exists', value: { kind: 'loopContext', path: '' } };
    expect(validateWorkflowBundle(bundle).ok).toBe(true);
  });

  test('rejects loop-only values outside their supported scope', () => {
    rejects('INVALID_REFERENCE_SCOPE', (bundle) =>
      setBinding(bundle, { kind: 'loopContext', path: '/iteration' }),
    );
    rejects('INVALID_REFERENCE_SCOPE', (bundle) =>
      setBinding(bundle, { kind: 'bodyResult', path: '' }),
    );
    rejects('INVALID_REFERENCE_SCOPE', (bundle) => {
      const body = node(bundle.workflow, 'wait_for_job', 'repeat').body;
      node(body, 'poll_request', 'request').bindings.jobId = {
        kind: 'bodyResult',
        path: '',
      };
    });
  });

  test('does not mutate the caller after semantic validation fails', () => {
    const bundle = example();
    setBinding(bundle, { kind: 'stepOutput', nodeId: 'missing', path: '' });
    const before = structuredClone(bundle);
    errorsFor(bundle);
    expect(bundle).toEqual(before);
  });
});

describe('structured predicates', () => {
  function withPredicate(predicate: Predicate) {
    const bundle = example();
    node(bundle.workflow, 'result_valid', 'assert').predicate = predicate;
    return bundle;
  }

  test.each(['gt', 'gte', 'lt', 'lte'] as const)(
    'checks numeric %s operands without coercion',
    (op) => {
      expect(
        validateWorkflowBundle(
          withPredicate({
            op,
            left: { kind: 'literal', value: 1 },
            right: { kind: 'literal', value: 2 },
          }),
        ).ok,
      ).toBe(true);
      expect(
        errorsFor(
          withPredicate({
            op,
            left: { kind: 'literal', value: '1' },
            right: { kind: 'literal', value: true },
          }),
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'TYPE_MISMATCH' }),
        ]),
      );
    },
  );

  test('does not coerce equality operands during validation', () => {
    expect(
      validateWorkflowBundle(
        withPredicate({
          op: 'neq',
          left: { kind: 'literal', value: 1 },
          right: { kind: 'literal', value: '1' },
        }),
      ).ok,
    ).toBe(true);
  });

  test('requires an array and primitive for contains', () => {
    expect(
      validateWorkflowBundle(
        withPredicate({
          op: 'contains',
          left: { kind: 'literal', value: [null, false, 1] },
          right: { kind: 'literal', value: null },
        }),
      ).ok,
    ).toBe(true);
    expect(
      errorsFor(
        withPredicate({
          op: 'contains',
          left: { kind: 'literal', value: 'abc' },
          right: { kind: 'literal', value: {} },
        }),
      ),
    ).toHaveLength(2);
  });

  test('checks references in nested and/or/not predicates', () => {
    const predicate: Predicate = {
      op: 'or',
      args: [
        {
          op: 'not',
          arg: {
            op: 'exists',
            value: { kind: 'workflowInput', name: 'unknown' },
          },
        },
      ],
    };
    expect(errorsFor(withPredicate(predicate))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNKNOWN_INPUT' }),
      ]),
    );
  });
});
