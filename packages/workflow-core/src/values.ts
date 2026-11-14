import type {
  InputDeclaration,
  JsonValue,
  Predicate,
  ValueSpec,
} from './schema';
import { abortable, checkAbort, executionError } from './runtime';

export function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  )
    return false;
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]!))
    );
  }
  if (Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && jsonEqual(left[key]!, right[key]!),
    )
  );
}

export interface OutputScope {
  outputs: Map<string, JsonValue>;
  parent?: OutputScope;
}

export interface ResolutionContext {
  workflowInputs: Record<string, JsonValue>;
  environment: Record<string, JsonValue>;
  requestInputs?: Record<string, JsonValue>;
  scope: OutputScope;
  iteration?: number;
  bodyResult?: JsonValue;
  signal: AbortSignal;
  secret: (name: string, signal: AbortSignal) => Promise<string | undefined>;
}

export function valueType(value: JsonValue): InputDeclaration['type'] | 'null' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as InputDeclaration['type'];
}

export function resolveInputs(
  declarations: Record<string, InputDeclaration>,
  supplied: Record<string, JsonValue>,
  path: (string | number)[],
): Record<string, JsonValue> {
  for (const name of Object.keys(supplied)) {
    if (!Object.hasOwn(declarations, name)) {
      throw executionError(
        'UNKNOWN_INPUT',
        'Input "' + name + '" is not declared.',
        [...path, name],
      );
    }
  }
  const result: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const [name, declaration] of Object.entries(declarations)) {
    const value = Object.hasOwn(supplied, name)
      ? supplied[name]
      : declaration.default;
    if (value === undefined) {
      if (declaration.required)
        throw executionError(
          'MISSING_INPUT',
          'Required input "' + name + '" is missing.',
          [...path, name],
        );
    } else {
      if (valueType(value) !== declaration.type) {
        throw executionError(
          'TYPE_MISMATCH',
          'Input "' + name + '" must be a ' + declaration.type + '.',
          [...path, name],
        );
      }
      result[name] = structuredClone(value);
    }
  }
  return result;
}

export function readPointer(
  value: JsonValue | undefined,
  pointer: string,
  path: (string | number)[],
): JsonValue {
  let current = value;
  if (pointer !== '') {
    for (const token of pointer.slice(1).split('/')) {
      const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
      if (
        current === null ||
        typeof current !== 'object' ||
        (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(key)) ||
        !Object.hasOwn(current, key)
      ) {
        current = undefined;
        break;
      }
      current = Array.isArray(current) ? current[Number(key)] : current[key];
    }
  }
  if (current === undefined) {
    throw executionError(
      'MISSING_VALUE',
      'Required value is missing at JSON Pointer "' + pointer + '".',
      path,
      { pointer },
    );
  }
  return current;
}

function named(
  values: Record<string, JsonValue> | undefined,
  name: string,
  path: (string | number)[],
) {
  if (values === undefined || !Object.hasOwn(values, name)) {
    throw executionError(
      'MISSING_VALUE',
      'Required value "' + name + '" is not available.',
      path,
    );
  }
  return values[name]!;
}

export async function resolveValue(
  spec: ValueSpec,
  context: ResolutionContext,
  path: (string | number)[] = [],
): Promise<JsonValue> {
  checkAbort(context.signal);
  switch (spec.kind) {
    case 'literal':
      return structuredClone(spec.value);
    case 'workflowInput':
      return named(context.workflowInputs, spec.name, path);
    case 'requestInput':
      return named(context.requestInputs, spec.name, path);
    case 'environment':
      return named(context.environment, spec.name, path);
    case 'secret': {
      const value = await abortable(
        context.secret(spec.name, context.signal),
        context.signal,
      );
      if (value === undefined || value === '')
        throw executionError(
          'MISSING_SECRET',
          'Secret reference "' + spec.name + '" could not be resolved.',
          path,
        );
      return value;
    }
    case 'stepOutput': {
      let scope: OutputScope | undefined = context.scope;
      while (scope !== undefined && !scope.outputs.has(spec.nodeId))
        scope = scope.parent;
      return readPointer(scope?.outputs.get(spec.nodeId), spec.path, path);
    }
    case 'loopContext':
      return readPointer(
        context.iteration === undefined
          ? undefined
          : { iteration: context.iteration },
        spec.path,
        path,
      );
    case 'bodyResult':
      return readPointer(context.bodyResult, spec.path, path);
    case 'array': {
      const values: JsonValue[] = [];
      for (const [index, child] of spec.items.entries()) {
        values.push(
          await resolveValue(child, context, [...path, 'items', index]),
        );
      }
      return values;
    }
    case 'object': {
      const result: Record<string, JsonValue> = Object.create(null) as Record<
        string,
        JsonValue
      >;
      for (const [name, child] of Object.entries(spec.entries)) {
        result[name] = await resolveValue(child, context, [
          ...path,
          'entries',
          name,
        ]);
      }
      return result;
    }
  }
}

export interface PredicateResult {
  result: boolean;
  evidence: JsonValue;
}

export async function evaluatePredicate(
  predicate: Predicate,
  context: ResolutionContext,
  path: (string | number)[] = [],
): Promise<PredicateResult> {
  if ('args' in predicate) {
    const children: JsonValue[] = [];
    for (const [index, child] of predicate.args.entries()) {
      const evaluation = await evaluatePredicate(child, context, [
        ...path,
        'args',
        index,
      ]);
      children.push(evaluation.evidence);
      if (
        (predicate.op === 'and' && !evaluation.result) ||
        (predicate.op === 'or' && evaluation.result)
      ) {
        return {
          result: evaluation.result,
          evidence: {
            op: predicate.op,
            result: evaluation.result,
            children,
            shortCircuited: index < predicate.args.length - 1,
          },
        };
      }
    }
    const result = predicate.op === 'and';
    return {
      result,
      evidence: { op: predicate.op, result, children, shortCircuited: false },
    };
  }
  if (predicate.op === 'not') {
    const child = await evaluatePredicate(predicate.arg, context, [
      ...path,
      'arg',
    ]);
    return {
      result: !child.result,
      evidence: { op: 'not', result: !child.result, child: child.evidence },
    };
  }
  if (predicate.op === 'exists') {
    try {
      const actual = await resolveValue(predicate.value, context, [
        ...path,
        'value',
      ]);
      return { result: true, evidence: { op: 'exists', result: true, actual } };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('issue' in error) ||
        (error.issue as { code: string }).code !== 'MISSING_VALUE'
      )
        throw error;
      return { result: false, evidence: { op: 'exists', result: false } };
    }
  }
  const actual = await resolveValue(predicate.left, context, [...path, 'left']);
  const expected = await resolveValue(predicate.right, context, [
    ...path,
    'right',
  ]);
  let result: boolean;
  switch (predicate.op) {
    case 'eq':
      result = jsonEqual(actual, expected);
      break;
    case 'neq':
      result = !jsonEqual(actual, expected);
      break;
    case 'contains':
      if (
        !Array.isArray(actual) ||
        (expected !== null && typeof expected === 'object')
      ) {
        throw executionError(
          'TYPE_MISMATCH',
          'contains requires an array and a primitive JSON value.',
          path,
        );
      }
      result = actual.some((value) => jsonEqual(value, expected));
      break;
    default:
      if (typeof actual !== 'number' || typeof expected !== 'number') {
        throw executionError(
          'TYPE_MISMATCH',
          'Numeric comparisons require numbers without coercion.',
          path,
        );
      }
      switch (predicate.op) {
        case 'gt':
          result = actual > expected;
          break;
        case 'gte':
          result = actual >= expected;
          break;
        case 'lt':
          result = actual < expected;
          break;
        case 'lte':
          result = actual <= expected;
          break;
      }
  }
  return { result, evidence: { op: predicate.op, result, actual, expected } };
}
