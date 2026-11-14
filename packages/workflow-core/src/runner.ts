import { randomUUID } from 'node:crypto';
import type {
  JsonValue,
  WorkflowBundle,
  WorkflowGraph,
  WorkflowNode,
} from './schema';
import { jsonValueSchema } from './schema';
import { type ValidationIssue, validateWorkflowBundle } from './validate';
import { prepareRequest } from './prepare';
import { Redactor } from './redact';
import {
  abortable,
  checkAbort,
  deadline,
  delay,
  errorIssue,
  executionError,
  type RuntimeIssue,
} from './runtime';
import type { HttpTransport } from './transport';
import {
  evaluatePredicate,
  type OutputScope,
  type ResolutionContext,
  resolveInputs,
  resolveValue,
} from './values';

export type RunStatus = 'passed' | 'failed' | 'errored' | 'cancelled';
export interface RunEvent {
  runId: string;
  sequence: number;
  timestamp: string;
  type: string;
  nodeId?: string;
  invocationId?: string;
  parentInvocationId?: string;
  iteration?: number;
  payload: JsonValue;
}
export interface Invocation {
  invocationId: string;
  nodeId: string;
  nodeType: WorkflowNode['type'];
  parentInvocationId?: string;
  iteration?: number;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'errored' | 'cancelled';
  selectedPort?: string;
  inputs?: JsonValue;
  output?: JsonValue;
  error?: RuntimeIssue;
}
export interface RunReport {
  runId: string;
  runnerVersion: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  snapshot: JsonValue;
  invocations: Invocation[];
  events: RunEvent[];
  skippedNodeIds: string[];
  warnings: RuntimeIssue[];
  error?: RuntimeIssue;
}
export interface RunOptions {
  http: HttpTransport;
  inputs?: Record<string, JsonValue>;
  environment?: Record<string, JsonValue>;
  signal?: AbortSignal;
  resolveSecret?: (
    name: string,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: RunEvent) => void;
}
export class WorkflowValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super('Workflow validation failed before execution.');
    this.name = 'WorkflowValidationError';
  }
}
class StopRun {
  constructor(
    readonly status: 'passed' | 'failed',
    readonly issue?: RuntimeIssue,
  ) {}
}
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
function freeze(value: unknown) {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
}

/** No UI or transport dependency. Adapters perform all external HTTP/secret I/O. */
export async function runWorkflow(
  input: unknown,
  options: RunOptions,
): Promise<RunReport> {
  const validation = validateWorkflowBundle(input);
  if (!validation.ok) throw new WorkflowValidationError(validation.errors);
  const bundle: WorkflowBundle = validation.value;
  freeze(bundle);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const redactor = new Redactor();
  const events: RunEvent[] = [];
  const invocations: Invocation[] = [];
  const warnings: RuntimeIssue[] = [];
  const secretCache = new Map<string, string | undefined>();
  const requests = new Map(
    bundle.requests.map((request) => [request.id, request]),
  );
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(executionError('CANCELLED', 'The run was cancelled.'));
  const runDeadline = deadline(
    bundle.workflow.limits.maxRunDurationMs,
    executionError('RUN_DEADLINE', 'The run deadline was exceeded.'),
  );
  const signal = AbortSignal.any([controller.signal, runDeadline.signal]);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let status: RunStatus = 'errored';
  let failure: RuntimeIssue | undefined;
  let workflowInputs: Record<string, JsonValue> = {};
  let environment: Record<string, JsonValue> = {};
  const rootScope: OutputScope = { outputs: new Map() };

  function emit(
    type: string,
    payload: JsonValue = {},
    invocation?: Invocation,
  ) {
    const event: RunEvent = {
      runId,
      sequence: events.length + 1,
      timestamp: new Date().toISOString(),
      type,
      payload,
      ...(invocation === undefined
        ? {}
        : {
            nodeId: invocation.nodeId,
            invocationId: invocation.invocationId,
            ...(invocation.parentInvocationId === undefined
              ? {}
              : { parentInvocationId: invocation.parentInvocationId }),
            ...(invocation.iteration === undefined
              ? {}
              : { iteration: invocation.iteration }),
          }),
    };
    events.push(event);
    try {
      options.onEvent?.({ ...event, payload: redactor.copy(event.payload) });
    } catch (error) {
      warnings.push({
        code: 'EVENT_LISTENER_ERROR',
        message: errorIssue(error).message,
      });
    }
  }

  async function secret(name: string, secretSignal: AbortSignal) {
    if (!secretCache.has(name)) {
      const value =
        options.resolveSecret === undefined
          ? undefined
          : await abortable(
              options.resolveSecret(name, secretSignal),
              secretSignal,
            );
      if (value !== undefined) redactor.remember(value);
      secretCache.set(name, value);
    }
    return secretCache.get(name);
  }

  type GraphResult = { value: JsonValue };
  async function executeGraph(
    graph: WorkflowGraph,
    scope: OutputScope,
    parentInvocationId?: string,
    iteration?: number,
  ): Promise<GraphResult> {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const transitions = new Map(
      graph.edges.map((edge) => [edge.from + ':' + edge.port, edge.to]),
    );
    let next = graph.entryNodeId;
    while (true) {
      checkAbort(signal);
      if (invocations.length >= bundle.workflow.limits.maxNodeInvocations) {
        throw executionError(
          'INVOCATION_LIMIT',
          'The global node invocation budget was exhausted.',
        );
      }
      const node = nodes.get(next)!;
      const invocation: Invocation = {
        invocationId: randomUUID(),
        nodeId: node.id,
        nodeType: node.type,
        startedAt: new Date().toISOString(),
        status: 'running',
        ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
        ...(iteration === undefined ? {} : { iteration }),
      };
      invocations.push(invocation);
      const context: ResolutionContext = {
        workflowInputs,
        environment,
        scope,
        signal,
        secret,
        ...(iteration === undefined ? {} : { iteration }),
      };
      emit('node.started', {}, invocation);
      try {
        checkAbort(signal);
        let output: JsonValue;
        let port: string;
        if (node.type === 'request') {
          const definition = requests.get(node.requestRef.id)!;
          const bindings: Record<string, JsonValue> = Object.create(
            null,
          ) as Record<string, JsonValue>;
          for (const [name, binding] of Object.entries(node.bindings)) {
            bindings[name] = await resolveValue(binding, context, [
              'bindings',
              name,
            ]);
          }
          const requestInputs = resolveInputs(definition.inputs, bindings, [
            'bindings',
          ]);
          invocation.inputs = { bindings: requestInputs };
          const prepared = await prepareRequest(
            definition,
            { ...context, requestInputs },
            redactor.remember,
          );
          redactor.discover(json(prepared));
          if (definition.body?.kind === 'json' && prepared.body !== undefined) {
            redactor.discover(JSON.parse(prepared.body) as JsonValue);
          }
          invocation.inputs = {
            bindings: requestInputs,
            request: json(prepared),
          };
          emit(
            'request.prepared',
            { method: prepared.method, url: prepared.url },
            invocation,
          );
          checkAbort(signal);
          const timeout = deadline(
            prepared.timeoutMs,
            executionError(
              'REQUEST_TIMEOUT',
              'The request deadline was exceeded.',
            ),
          );
          const requestSignal = AbortSignal.any([signal, timeout.signal]);
          try {
            emit(
              'request.dispatching',
              { method: prepared.method, url: prepared.url },
              invocation,
            );
            checkAbort(requestSignal);
            const response = structuredClone(
              await abortable(
                options.http.execute(prepared, requestSignal),
                requestSignal,
              ),
            );
            output = {
              response: {
                status: response.status,
                headers: json(response.headers),
                body: json(response.body),
                ...(response.json === undefined ? {} : { json: response.json }),
              },
              timing: { durationMs: response.durationMs },
            };
            redactor.discover(output);
            invocation.output = output;
            emit(
              'response.received',
              {
                status: response.status,
                durationMs: response.durationMs,
                bodyBytes: response.body.byteLength,
              },
              invocation,
            );
          } catch (error) {
            if (requestSignal.aborted) throw requestSignal.reason;
            throw error;
          } finally {
            timeout.dispose();
          }
          port = 'response';
        } else if (node.type === 'condition' || node.type === 'assert') {
          const evaluation = await evaluatePredicate(node.predicate, context, [
            'predicate',
          ]);
          output = { result: evaluation.result, evidence: evaluation.evidence };
          invocation.inputs = { predicate: json(node.predicate) };
          invocation.output = output;
          if (node.type === 'condition') {
            port = evaluation.result ? 'true' : 'false';
            emit(
              'condition.evaluated',
              {
                result: evaluation.result,
                port,
                evidence: evaluation.evidence,
              },
              invocation,
            );
          } else {
            emit(
              evaluation.result ? 'assertion.passed' : 'assertion.failed',
              evaluation.evidence,
              invocation,
            );
            if (!evaluation.result) {
              throw new StopRun('failed', {
                code: 'ASSERTION_FAILED',
                message: 'Assertion "' + node.id + '" failed.',
                details: evaluation.evidence,
              });
            }
            port = 'pass';
          }
        } else if (node.type === 'repeat') {
          let result: JsonValue = null;
          let iterations = 0;
          port = 'exhausted';
          for (let attempt = 1; attempt <= node.maxIterations; attempt++) {
            checkAbort(signal);
            emit(
              'iteration.started',
              { iteration: attempt, maxIterations: node.maxIterations },
              invocation,
            );
            const body = await executeGraph(
              node.body,
              { outputs: new Map(), parent: scope },
              invocation.invocationId,
              attempt,
            );
            result = body.value;
            iterations = attempt;
            const completion = await evaluatePredicate(
              node.until,
              {
                ...context,
                iteration: attempt,
                bodyResult: result,
              },
              ['until'],
            );
            emit(
              'iteration.completed',
              {
                iteration: attempt,
                completed: completion.result,
                evidence: completion.evidence,
              },
              invocation,
            );
            if (completion.result) {
              port = 'completed';
              break;
            }
            if (attempt < node.maxIterations) {
              emit(
                'iteration.waiting',
                { intervalMs: node.intervalMs, nextIteration: attempt + 1 },
                invocation,
              );
              checkAbort(signal);
              await abortable(
                (options.sleep ?? delay)(node.intervalMs, signal),
                signal,
              );
            }
          }
          output = { iterations, result };
        } else if (node.type === 'return') {
          const value = await resolveValue(node.value, context, ['value']);
          invocation.output = value;
          invocation.status = 'completed';
          invocation.finishedAt = new Date().toISOString();
          emit('node.completed', {}, invocation);
          return { value };
        } else {
          invocation.output = {
            outcome: node.outcome,
            ...(node.reason === undefined ? {} : { reason: node.reason }),
          };
          invocation.status =
            node.outcome === 'passed' ? 'completed' : 'failed';
          invocation.finishedAt = new Date().toISOString();
          emit('node.completed', { outcome: node.outcome }, invocation);
          throw new StopRun(
            node.outcome,
            node.outcome === 'failed'
              ? {
                  code: 'WORKFLOW_FAILED',
                  message:
                    node.reason ?? 'The workflow reached a failed end node.',
                }
              : undefined,
          );
        }
        checkAbort(signal);
        scope.outputs.set(node.id, output);
        invocation.output = output;
        invocation.selectedPort = port;
        invocation.status = 'completed';
        invocation.finishedAt = new Date().toISOString();
        emit('node.completed', { port }, invocation);
        next = transitions.get(node.id + ':' + port)!;
        emit('edge.selected', { port, to: next }, invocation);
      } catch (error) {
        // Successful terminal completion unwinds only the outer graph.
        if (!(error instanceof StopRun && error.status === 'passed')) {
          const stopped = signal.aborted ? signal.reason : error;
          invocation.status =
            stopped instanceof StopRun
              ? 'failed'
              : errorIssue(stopped).code === 'CANCELLED'
                ? 'cancelled'
                : 'errored';
          const issue =
            stopped instanceof StopRun ? stopped.issue : errorIssue(stopped);
          if (issue !== undefined) invocation.error = issue;
          invocation.finishedAt = new Date().toISOString();
          emit(
            'node.' + invocation.status,
            issue === undefined ? {} : json(issue),
            invocation,
          );
        }
        throw error;
      }
    }
  }

  emit('run.started', {
    workflowId: bundle.workflow.id,
    revision: bundle.workflow.revision,
  });
  try {
    checkAbort(signal);
    const parsedInputs = jsonValueSchema.safeParse(options.inputs ?? {});
    const parsedEnvironment = jsonValueSchema.safeParse(
      options.environment ?? {},
    );
    if (!parsedInputs.success || !parsedEnvironment.success) {
      throw executionError(
        'INVALID_INPUTS',
        'Run inputs and environment must contain finite JSON values.',
      );
    }
    const supplied = parsedInputs.data;
    const selectedEnvironment = parsedEnvironment.data;
    if (
      supplied === null ||
      Array.isArray(supplied) ||
      typeof supplied !== 'object' ||
      selectedEnvironment === null ||
      Array.isArray(selectedEnvironment) ||
      typeof selectedEnvironment !== 'object'
    ) {
      throw executionError(
        'INVALID_INPUTS',
        'Run inputs and environment must be JSON objects.',
      );
    }
    workflowInputs = resolveInputs(bundle.workflow.inputs, supplied, [
      'inputs',
    ]);
    environment = selectedEnvironment;
    freeze(workflowInputs);
    freeze(environment);
    redactor.discover(workflowInputs);
    redactor.discover(environment);
    for (const name of bundle.workflow.environmentRequirements) {
      if (!Object.hasOwn(environment, name))
        throw executionError(
          'MISSING_ENVIRONMENT',
          'Environment value "' + name + '" is required.',
          ['environment', name],
        );
    }
    await executeGraph(bundle.workflow, rootScope);
  } catch (error) {
    const stopped = signal.aborted ? signal.reason : error;
    if (stopped instanceof StopRun) {
      status = stopped.status;
      failure = stopped.issue;
    } else {
      failure = errorIssue(stopped);
      status = failure.code === 'CANCELLED' ? 'cancelled' : 'errored';
    }
  } finally {
    runDeadline.dispose();
    options.signal?.removeEventListener('abort', cancel);
  }
  emit('run.finished', {
    status,
    ...(failure === undefined ? {} : { error: json(failure) }),
  });
  const allNodeIds: string[] = [];
  function collect(graph: WorkflowGraph) {
    for (const node of graph.nodes) {
      allNodeIds.push(node.id);
      if (node.type === 'repeat') collect(node.body);
    }
  }
  collect(bundle.workflow);
  const executed = new Set(invocations.map((invocation) => invocation.nodeId));
  return {
    runId,
    runnerVersion: '0.1.0',
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    snapshot: redactor.copy(
      json({ bundle, inputs: workflowInputs, environment }),
    ),
    invocations: invocations.map((invocation) => ({
      ...invocation,
      ...(invocation.inputs === undefined
        ? {}
        : { inputs: redactor.copy(invocation.inputs) }),
      ...(invocation.output === undefined
        ? {}
        : { output: redactor.copy(invocation.output) }),
      ...(invocation.error === undefined
        ? {}
        : {
            error: redactor.copy(
              json(invocation.error),
            ) as unknown as RuntimeIssue,
          }),
    })),
    events: events.map((event) => ({
      ...event,
      payload: redactor.copy(event.payload),
    })),
    skippedNodeIds: allNodeIds.filter((id) => !executed.has(id)),
    warnings: warnings.map(
      (warning) => redactor.copy(json(warning)) as unknown as RuntimeIssue,
    ),
    ...(failure === undefined
      ? {}
      : { error: redactor.copy(json(failure)) as unknown as RuntimeIssue }),
  };
}
