import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
  abortable,
  deadline,
  delay,
  evaluatePredicate,
  executionError,
  jsonEqual,
  readPointer,
  resolveInputs,
  resolveValue,
  type ResolutionContext,
} from '../src';

function context(): ResolutionContext {
  return {
    workflowInputs: { count: 3 },
    environment: { flag: false },
    requestInputs: { id: 'a/b' },
    scope: {
      outputs: new Map([['previous', { 'a/b': { '~key': [null, 42] } }]]),
    },
    signal: new AbortController().signal,
    secret: async () => 'secret-value',
  };
}
afterEach(() => {
  jest.useRealTimers();
});

describe('runtime value resolution', () => {
  test('composes typed values without string interpolation or prototype mutation', async () => {
    const result = await resolveValue(
      {
        kind: 'object',
        entries: {
          count: { kind: 'workflowInput', name: 'count' },
          enabled: { kind: 'environment', name: 'flag' },
          list: {
            kind: 'array',
            items: [
              { kind: 'literal', value: [1, 'two'] },
              { kind: 'literal', value: null },
            ],
          },
          data: {
            kind: 'literal',
            value: { kind: 'stepOutput', nodeId: 'not-a-reference' },
          },
        },
      },
      context(),
    );
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      count: 3,
      enabled: false,
      list: [[1, 'two'], null],
      data: { kind: 'stepOutput', nodeId: 'not-a-reference' },
    });
    expect(
      await resolveValue({ kind: 'requestInput', name: 'id' }, context()),
    ).toBe('a/b');
    expect(
      await resolveValue({ kind: 'secret', name: 'token' }, context()),
    ).toBe('secret-value');
  });

  test('reads escaped pointers and permits null as a present value', async () => {
    const ctx = context();
    expect(
      await resolveValue(
        { kind: 'stepOutput', nodeId: 'previous', path: '/a~1b/~0key/1' },
        ctx,
      ),
    ).toBe(42);
    expect(
      await resolveValue(
        { kind: 'stepOutput', nodeId: 'previous', path: '/a~1b/~0key/0' },
        ctx,
      ),
    ).toBeNull();
    expect(readPointer({ '': 'empty key' }, '/', [])).toBe('empty key');
    expect(() => readPointer([1], '/01', [])).toThrow();
    expect(() => readPointer([1], '/length', [])).toThrow();
    expect(() => readPointer({}, '/constructor', [])).toThrow();
  });

  test('reads earlier ancestor outputs through a fresh body scope', async () => {
    const ctx = context();
    ctx.scope = { outputs: new Map(), parent: ctx.scope };
    expect(
      await resolveValue(
        { kind: 'stepOutput', nodeId: 'previous', path: '/a~1b/~0key/1' },
        ctx,
      ),
    ).toBe(42);
    await expect(
      resolveValue({ kind: 'stepOutput', nodeId: 'missing', path: '' }, ctx, [
        'bindings',
        'id',
      ]),
    ).rejects.toMatchObject({
      issue: { code: 'MISSING_VALUE', path: ['bindings', 'id'] },
    });
  });

  test('exposes only the current loop context and body result', async () => {
    const ctx = { ...context(), iteration: 3, bodyResult: { completed: true } };
    expect(
      await resolveValue({ kind: 'loopContext', path: '/iteration' }, ctx),
    ).toBe(3);
    expect(
      await resolveValue({ kind: 'bodyResult', path: '/completed' }, ctx),
    ).toBe(true);
    await expect(
      resolveValue({ kind: 'bodyResult', path: '' }, context()),
    ).rejects.toMatchObject({ issue: { code: 'MISSING_VALUE' } });
  });

  test('distinguishes missing values and missing secrets', async () => {
    await expect(
      resolveValue({ kind: 'workflowInput', name: 'missing' }, context()),
    ).rejects.toMatchObject({ issue: { code: 'MISSING_VALUE' } });
    await expect(
      resolveValue(
        { kind: 'requestInput', name: 'id' },
        { ...context(), requestInputs: {} },
      ),
    ).rejects.toMatchObject({ issue: { code: 'MISSING_VALUE' } });
    await expect(
      resolveValue(
        { kind: 'secret', name: 'missing' },
        { ...context(), secret: async () => undefined },
      ),
    ).rejects.toMatchObject({ issue: { code: 'MISSING_SECRET' } });
  });

  test('validates supplied inputs and applies isolated defaults', () => {
    const declarations = {
      required: { type: 'string' as const, required: true },
      optional: { type: 'array' as const, required: false, default: [1] },
    };
    const first = resolveInputs(declarations, { required: 'yes' }, ['inputs']);
    expect(first).toEqual({ required: 'yes', optional: [1] });
    (first.optional as number[]).push(2);
    expect(declarations.optional.default).toEqual([1]);
    expect(() => resolveInputs(declarations, {}, [])).toThrow();
    expect(() => resolveInputs(declarations, { required: 1 }, [])).toThrow();
    expect(() =>
      resolveInputs(declarations, { required: 'yes', unknown: true }, []),
    ).toThrow();
    expect(
      resolveInputs({ optional: { type: 'string', required: false } }, {}, []),
    ).toEqual({});
  });
});

describe('predicate execution', () => {
  test('JSON equality ignores key order and object prototypes, and never coerces types', () => {
    expect(jsonEqual({ a: 1, b: [null] }, { b: [null], a: 1 })).toBe(true);
    expect(
      jsonEqual(
        Object.assign(Object.create(null) as Record<string, number>, { a: 1 }),
        { a: 1 },
      ),
    ).toBe(true);
    expect(jsonEqual(1, '1')).toBe(false);
    expect(jsonEqual(-0, 0)).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual([1], { 0: 1 })).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });

  test.each([
    ['eq', 2, 2, true],
    ['neq', 2, '2', true],
    ['gt', 3, 2, true],
    ['gte', 2, 2, true],
    ['lt', 1, 2, true],
    ['lte', 2, 2, true],
    ['contains', [null, false, 1], false, true],
  ] as const)(
    'evaluates %s and records expected and actual values',
    async (op, left, right, result) => {
      const actual = await evaluatePredicate(
        {
          op,
          left: {
            kind: 'literal',
            value: typeof left === 'object' && left !== null ? [...left] : left,
          },
          right: { kind: 'literal', value: right },
        },
        context(),
      );
      expect(actual.result).toBe(result);
      expect(actual.evidence).toMatchObject({
        actual: left,
        expected: right,
        result,
      });
    },
  );

  test('short-circuits logical operators and records only evaluated evidence', async () => {
    const missing = {
      op: 'exists' as const,
      value: { kind: 'secret' as const, name: 'missing' },
    };
    const secret = jest.fn<ResolutionContext['secret']>(async () => {
      throw new Error('Must not run.');
    });
    const truth = {
      op: 'eq' as const,
      left: { kind: 'literal' as const, value: 1 },
      right: { kind: 'literal' as const, value: 1 },
    };
    expect(
      (
        await evaluatePredicate(
          { op: 'or', args: [truth, missing] },
          { ...context(), secret },
        )
      ).result,
    ).toBe(true);
    expect(
      (
        await evaluatePredicate(
          { op: 'and', args: [{ op: 'not', arg: truth }, missing] },
          { ...context(), secret },
        )
      ).result,
    ).toBe(false);
    expect(secret).not.toHaveBeenCalled();
    expect(
      (await evaluatePredicate({ op: 'and', args: [truth, truth] }, context()))
        .result,
    ).toBe(true);
    expect(
      (
        await evaluatePredicate(
          { op: 'or', args: [{ op: 'not', arg: truth }] },
          context(),
        )
      ).result,
    ).toBe(false);
  });

  test('exists handles absent response paths but does not swallow secret/transport errors', async () => {
    expect(
      (
        await evaluatePredicate(
          {
            op: 'exists',
            value: { kind: 'stepOutput', nodeId: 'previous', path: '/missing' },
          },
          context(),
        )
      ).result,
    ).toBe(false);
    expect(
      (
        await evaluatePredicate(
          { op: 'exists', value: { kind: 'literal', value: null } },
          context(),
        )
      ).result,
    ).toBe(true);
    await expect(
      evaluatePredicate(
        { op: 'exists', value: { kind: 'secret', name: 'missing' } },
        { ...context(), secret: async () => undefined },
      ),
    ).rejects.toMatchObject({ issue: { code: 'MISSING_SECRET' } });
  });

  test('rejects incorrect dynamic operand types instead of comparing false', async () => {
    await expect(
      evaluatePredicate(
        {
          op: 'gt',
          left: { kind: 'environment', name: 'flag' },
          right: { kind: 'literal', value: 0 },
        },
        context(),
      ),
    ).rejects.toMatchObject({ issue: { code: 'TYPE_MISMATCH' } });
    await expect(
      evaluatePredicate(
        {
          op: 'contains',
          left: { kind: 'literal', value: [] },
          right: { kind: 'literal', value: {} },
        },
        context(),
      ),
    ).rejects.toMatchObject({ issue: { code: 'TYPE_MISMATCH' } });
  });
});

describe('cancellable time and adapter boundaries', () => {
  test('cancellable delays stop immediately and clean up their timer', async () => {
    const controller = new AbortController();
    const promise = delay(1_000, controller.signal);
    controller.abort(executionError('CANCELLED', 'cancelled'));
    await expect(promise).rejects.toMatchObject({
      issue: { code: 'CANCELLED' },
    });
    await delay(0, new AbortController().signal);
    expect(() => delay(0, controller.signal)).toThrow();
  });

  test('long delays and deadlines do not overflow Node timers', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const promise = delay(3_000_000_000, controller.signal);
    const expires = deadline(
      3_000_000_000,
      executionError('EXPIRED', 'expired'),
    );
    await jest.advanceTimersByTimeAsync(2_147_483_647);
    expect(expires.signal.aborted).toBe(false);
    controller.abort(new Error('stop'));
    await expect(promise).rejects.toThrow('stop');
    expires.dispose();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('abortable observes late adapter rejection even when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      abortable(Promise.reject(new Error('late rejection')), controller.signal),
    ).rejects.toThrow('cancelled');
  });
});
