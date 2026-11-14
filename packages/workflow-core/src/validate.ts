import {
  type InputDeclaration,
  type JsonValue,
  type Predicate,
  type RequestDefinition,
  type ValueSpec,
  type WorkflowBundle,
  type WorkflowGraph,
  type WorkflowNode,
  workflowBundleSchema,
} from './schema';

export interface ValidationIssue {
  code: string;
  message: string;
  path: (string | number)[];
  nodeId?: string;
  requestId?: string;
}

export type ValidationResult =
  | { ok: true; value: WorkflowBundle }
  | { ok: false; errors: ValidationIssue[] };

type Path = ValidationIssue['path'];
type ValueType = InputDeclaration['type'] | 'null';
type LocatedNode = { node: WorkflowNode; path: Path };
interface GraphContext {
  graph: WorkflowGraph;
  path: Path;
  parent: GraphContext | undefined;
  ownerId: string | undefined;
  nodes: Map<string, LocatedNode>;
  dominators: Map<string, Set<string>>;
}
interface ValueContext {
  graph?: GraphContext;
  nodeId?: string;
  request?: RequestDefinition;
  loop?: boolean;
  bodyResult?: boolean;
  requireEnvironment?: boolean;
}

const ports: Record<WorkflowNode['type'], readonly string[]> = {
  request: ['response'],
  condition: ['true', 'false'],
  assert: ['pass'],
  repeat: ['completed', 'exhausted'],
  end: [],
  return: [],
};

function jsonType(value: JsonValue): ValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as Exclude<ValueType, 'array' | 'null'>;
}

/**
 * Checks a complete runnable bundle without evaluating bindings or making I/O.
 * The returned value is a parsed copy with defaults, never the caller's object.
 */
export function validateWorkflowBundle(input: unknown): ValidationResult {
  const parsed = workflowBundleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: 'SCHEMA_ERROR',
        message: issue.message,
        path: issue.path.map((part) =>
          typeof part === 'number' ? part : String(part),
        ),
      })),
    };
  }

  const bundle = parsed.data;
  const errors: ValidationIssue[] = [];
  const requests = new Map<string, RequestDefinition>();
  const graphs: GraphContext[] = [];
  const nodeGraphs = new Map<string, GraphContext>();
  const requirements = new Set(bundle.workflow.environmentRequirements);

  function issue(
    code: string,
    message: string,
    path: Path,
    context: ValueContext = {},
  ) {
    errors.push({
      code,
      message,
      path,
      ...(context.nodeId === undefined ? {} : { nodeId: context.nodeId }),
      ...(context.request === undefined
        ? {}
        : { requestId: context.request.id }),
    });
  }

  function indexGraph(
    graph: WorkflowGraph,
    path: Path,
    parent?: GraphContext,
    ownerId?: string,
  ): GraphContext {
    const context: GraphContext = {
      graph,
      path,
      parent,
      ownerId,
      nodes: new Map(),
      dominators: new Map(),
    };
    graphs.push(context);
    graph.nodes.forEach((node, index) => {
      const nodePath = [...path, 'nodes', index];
      if (nodeGraphs.has(node.id)) {
        issue(
          'DUPLICATE_ID',
          'Node IDs must be unique across the entire workflow.',
          [...nodePath, 'id'],
          { nodeId: node.id },
        );
      } else {
        nodeGraphs.set(node.id, context);
      }
      // Preserve the first occurrence so invalid duplicates cannot shadow a node.
      if (!context.nodes.has(node.id))
        context.nodes.set(node.id, { node, path: nodePath });
      if (node.type === 'repeat') {
        if (parent !== undefined) {
          issue(
            'NESTED_REPEAT',
            'Only one level of repetition is supported.',
            nodePath,
            { nodeId: node.id },
          );
        }
        indexGraph(node.body, [...nodePath, 'body'], context, node.id);
      }
    });
    return context;
  }

  function validateGraph(context: GraphContext) {
    const { graph, nodes, path } = context;
    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();
    const connections = new Map<string, Map<string, number>>();
    for (const id of nodes.keys()) {
      outgoing.set(id, []);
      incoming.set(id, []);
      connections.set(id, new Map());
    }
    if (!nodes.has(graph.entryNodeId)) {
      issue('INVALID_ENTRY', 'The entry must identify a node in this graph.', [
        ...path,
        'entryNodeId',
      ]);
    }
    graph.edges.forEach((edge, index) => {
      const edgePath = [...path, 'edges', index];
      const source = nodes.get(edge.from);
      if (source === undefined || !nodes.has(edge.to)) {
        issue(
          'DANGLING_EDGE',
          'Connections must stay inside their graph and name existing nodes.',
          edgePath,
        );
        return;
      }
      if (!ports[source.node.type].includes(edge.port)) {
        issue(
          'INVALID_PORT',
          'This node does not expose the selected output port.',
          [...edgePath, 'port'],
          { nodeId: edge.from },
        );
        return;
      }
      const counts = connections.get(edge.from)!;
      const count = (counts.get(edge.port) ?? 0) + 1;
      counts.set(edge.port, count);
      if (count > 1) {
        issue(
          'MULTIPLE_CONNECTIONS',
          'Each output port may have only one destination.',
          edgePath,
          { nodeId: edge.from },
        );
      }
      outgoing.get(edge.from)!.push(edge.to);
      incoming.get(edge.to)!.push(edge.from);
    });
    for (const { node, path: nodePath } of nodes.values()) {
      for (const port of ports[node.type]) {
        if (!connections.get(node.id)!.has(port)) {
          issue(
            'MISSING_CONNECTION',
            'Required output port "' + port + '" is not connected.',
            nodePath,
            { nodeId: node.id },
          );
        }
      }
      if (
        (context.parent === undefined && node.type === 'return') ||
        (context.parent !== undefined && node.type === 'end')
      ) {
        issue(
          'INVALID_TERMINAL',
          'Outer graphs end with end nodes; repeat bodies end with return nodes.',
          nodePath,
          { nodeId: node.id },
        );
      }
    }

    const reachable = new Set<string>();
    const pending = nodes.has(graph.entryNodeId) ? [graph.entryNodeId] : [];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      pending.push(...outgoing.get(id)!);
    }
    if (nodes.has(graph.entryNodeId)) {
      for (const { node, path: nodePath } of nodes.values()) {
        if (!reachable.has(node.id)) {
          issue(
            'UNREACHABLE_NODE',
            'This node cannot be reached from the graph entry.',
            nodePath,
            { nodeId: node.id },
          );
        }
      }
    }

    // Kahn's algorithm detects cycles, including disconnected cycles. Positions
    // and array order never determine execution or output availability.
    const degrees = new Map(
      [...incoming].map(([id, predecessors]) => [id, predecessors.length]),
    );
    const ready = [...degrees]
      .filter(([, count]) => count === 0)
      .map(([id]) => id);
    const order: string[] = [];
    for (let index = 0; index < ready.length; index++) {
      const id = ready[index]!;
      order.push(id);
      for (const next of outgoing.get(id)!) {
        const degree = degrees.get(next)! - 1;
        degrees.set(next, degree);
        if (degree === 0) ready.push(next);
      }
    }
    if (order.length !== nodes.size) {
      issue(
        'UNSUPPORTED_CYCLE',
        'Use a bounded repeat body instead of a back-edge.',
        [...path, 'edges'],
      );
    }
    for (const id of order) {
      if (!reachable.has(id)) continue;
      const predecessors = incoming
        .get(id)!
        .filter((candidate) => reachable.has(candidate));
      let dominators = new Set<string>();
      if (id !== graph.entryNodeId && predecessors.length > 0) {
        dominators = new Set(context.dominators.get(predecessors[0]!));
        for (const predecessor of predecessors.slice(1)) {
          const previous = context.dominators.get(predecessor);
          dominators = new Set(
            [...dominators].filter((candidate) => previous?.has(candidate)),
          );
        }
      }
      dominators.add(id);
      context.dominators.set(id, dominators);
    }
  }

  function availableBefore(graph: GraphContext, nodeId: string): Set<string> {
    const available = new Set(graph.dominators.get(nodeId));
    available.delete(nodeId);
    if (graph.parent !== undefined && graph.ownerId !== undefined) {
      for (const ancestor of availableBefore(graph.parent, graph.ownerId))
        available.add(ancestor);
    }
    return available;
  }

  function checkValue(
    value: ValueSpec,
    path: Path,
    context: ValueContext,
  ): ValueType | undefined {
    switch (value.kind) {
      case 'literal':
        return jsonType(value.value);
      case 'object':
        for (const [name, child] of Object.entries(value.entries)) {
          checkValue(child, [...path, 'entries', name], context);
        }
        return 'object';
      case 'array':
        value.items.forEach((child, index) =>
          checkValue(child, [...path, 'items', index], context),
        );
        return 'array';
      case 'secret':
        return 'string';
      case 'environment':
        if (
          context.requireEnvironment !== false &&
          !requirements.has(value.name)
        ) {
          issue(
            'UNDECLARED_ENVIRONMENT',
            'Declare this environment name in environmentRequirements.',
            [...path, 'name'],
            context,
          );
        }
        return undefined;
      case 'workflowInput':
      case 'requestInput': {
        const declarations =
          value.kind === 'requestInput'
            ? context.request?.inputs
            : bundle.workflow.inputs;
        if (
          (value.kind === 'workflowInput' && context.request !== undefined) ||
          (value.kind === 'requestInput' && context.request === undefined)
        ) {
          issue(
            'INVALID_REFERENCE_SCOPE',
            'Saved requests consume requestInput bindings; workflow expressions consume workflowInput.',
            path,
            context,
          );
          return undefined;
        }
        if (
          declarations === undefined ||
          !Object.hasOwn(declarations, value.name)
        ) {
          issue(
            'UNKNOWN_INPUT',
            'The referenced input is not declared.',
            [...path, 'name'],
            context,
          );
          return undefined;
        }
        return declarations[value.name]!.type;
      }
      case 'loopContext':
      case 'bodyResult':
        if (
          !(value.kind === 'loopContext' ? context.loop : context.bodyResult)
        ) {
          issue(
            'INVALID_REFERENCE_SCOPE',
            value.kind + ' is not available at this location.',
            path,
            context,
          );
        }
        return undefined;
      case 'stepOutput': {
        if (context.graph === undefined || context.nodeId === undefined) {
          issue(
            'INVALID_REFERENCE_SCOPE',
            'Saved request templates cannot refer to workflow nodes.',
            path,
            context,
          );
          return undefined;
        }
        const source = nodeGraphs.get(value.nodeId);
        if (source === undefined) {
          issue(
            'UNKNOWN_STEP_OUTPUT',
            'The referenced node does not exist.',
            [...path, 'nodeId'],
            context,
          );
          return undefined;
        }
        let scope: GraphContext | undefined = context.graph;
        while (scope !== undefined && scope !== source) scope = scope.parent;
        if (scope === undefined) {
          issue(
            'INVALID_REFERENCE_SCOPE',
            'Read a repeat node output rather than reaching into its body or a sibling body.',
            path,
            context,
          );
        } else if (
          !availableBefore(context.graph, context.nodeId).has(value.nodeId)
        ) {
          issue(
            'UNAVAILABLE_STEP_OUTPUT',
            'The source must complete on every path before this node; future, self and skipped-branch outputs are unavailable.',
            path,
            context,
          );
        }
        return undefined;
      }
    }
  }

  function checkPredicate(
    predicate: Predicate,
    path: Path,
    context: ValueContext,
  ) {
    if ('args' in predicate) {
      predicate.args.forEach((child, index) =>
        checkPredicate(child, [...path, 'args', index], context),
      );
    } else if (predicate.op === 'not') {
      checkPredicate(predicate.arg, [...path, 'arg'], context);
    } else if (predicate.op === 'exists') {
      checkValue(predicate.value, [...path, 'value'], context);
    } else {
      const left = checkValue(predicate.left, [...path, 'left'], context);
      const right = checkValue(predicate.right, [...path, 'right'], context);
      if (['gt', 'gte', 'lt', 'lte'].includes(predicate.op)) {
        for (const [name, type] of [
          ['left', left],
          ['right', right],
        ] as const) {
          if (type !== undefined && type !== 'number') {
            issue(
              'TYPE_MISMATCH',
              'Numeric comparisons require numbers without coercion.',
              [...path, name],
              context,
            );
          }
        }
      } else if (predicate.op === 'contains') {
        if (left !== undefined && left !== 'array') {
          issue(
            'TYPE_MISMATCH',
            'contains requires a JSON array on the left.',
            [...path, 'left'],
            context,
          );
        }
        if (right === 'array' || right === 'object') {
          issue(
            'TYPE_MISMATCH',
            'contains requires a primitive JSON value on the right.',
            [...path, 'right'],
            context,
          );
        }
      }
    }
  }

  function checkDeclarations(
    declarations: Record<string, InputDeclaration>,
    path: Path,
    context: ValueContext,
  ) {
    for (const [name, declaration] of Object.entries(declarations)) {
      if (
        declaration.default !== undefined &&
        jsonType(declaration.default) !== declaration.type
      ) {
        issue(
          'TYPE_MISMATCH',
          'The default must match the declared input type.',
          [...path, name, 'default'],
          context,
        );
      }
    }
  }

  bundle.requests.forEach((request, index) => {
    if (requests.has(request.id)) {
      issue(
        'DUPLICATE_ID',
        'Saved request IDs must be unique.',
        ['requests', index, 'id'],
        { request },
      );
    } else {
      requests.set(request.id, request);
    }
  });
  const root = indexGraph(bundle.workflow, ['workflow']);
  for (const graph of graphs) validateGraph(graph);
  if (requirements.size !== bundle.workflow.environmentRequirements.length) {
    issue('DUPLICATE_ENVIRONMENT', 'Environment requirements must be unique.', [
      'workflow',
      'environmentRequirements',
    ]);
  }
  checkDeclarations(bundle.workflow.inputs, ['workflow', 'inputs'], {});
  const usedRequests = new Set(
    graphs.flatMap((graph) =>
      graph.graph.nodes
        .filter((node) => node.type === 'request')
        .map((node) => node.requestRef.id),
    ),
  );

  bundle.requests.forEach((request, index) => {
    const path: Path = ['requests', index];
    const context: ValueContext = {
      request,
      requireEnvironment: usedRequests.has(request.id),
    };
    checkDeclarations(request.inputs, [...path, 'inputs'], context);
    const baseType = checkValue(
      request.url.base,
      [...path, 'url', 'base'],
      context,
    );
    if (baseType !== undefined && baseType !== 'string') {
      issue(
        'TYPE_MISMATCH',
        'A URL base must resolve to a string.',
        [...path, 'url', 'base'],
        context,
      );
    } else if (
      request.url.base.kind === 'literal' &&
      typeof request.url.base.value === 'string'
    ) {
      try {
        const url = new URL(request.url.base.value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
          throw new Error('scheme');
      } catch {
        issue(
          'INVALID_URL_BASE',
          'A literal URL base must be an absolute HTTP(S) URL.',
          [...path, 'url', 'base'],
          context,
        );
      }
    }
    const placeholders = [...request.url.path.matchAll(/\{([^{}]*)\}/g)];
    if (/[{}?#]/.test(request.url.path.replace(/\{[^{}]*\}/g, ''))) {
      issue(
        'INVALID_URL_PATH',
        'Use balanced input placeholders and separate query parameters from the path.',
        [...path, 'url', 'path'],
        context,
      );
    }
    for (const match of placeholders) {
      if (!Object.hasOwn(request.inputs, match[1]!)) {
        issue(
          'UNKNOWN_INPUT',
          'Every path placeholder must name a declared request input.',
          [...path, 'url', 'path'],
          context,
        );
      }
    }
    for (const field of ['headers', 'query'] as const) {
      request[field].forEach((parameter, parameterIndex) => {
        checkValue(
          parameter.value,
          [...path, field, parameterIndex, 'value'],
          context,
        );
      });
    }
    if (request.body !== undefined && request.body.kind !== 'none') {
      const type = checkValue(
        request.body.value,
        [...path, 'body', 'value'],
        context,
      );
      if (
        request.body.kind === 'text' &&
        type !== undefined &&
        type !== 'string'
      ) {
        issue(
          'TYPE_MISMATCH',
          'A text body must resolve to a string.',
          [...path, 'body', 'value'],
          context,
        );
      }
    }
    const auth = request.auth;
    if (auth?.kind === 'basic') {
      checkValue(auth.username, [...path, 'auth', 'username'], context);
      checkValue(auth.password, [...path, 'auth', 'password'], context);
    } else if (auth?.kind === 'bearer') {
      checkValue(auth.token, [...path, 'auth', 'token'], context);
    } else if (auth?.kind === 'apiKey') {
      checkValue(auth.value, [...path, 'auth', 'value'], context);
    }
  });

  for (const graph of graphs) {
    for (const { node, path } of graph.nodes.values()) {
      const context: ValueContext = {
        graph,
        nodeId: node.id,
        loop: graph !== root,
      };
      if (node.type === 'request') {
        const request = requests.get(node.requestRef.id);
        if (request === undefined) {
          issue(
            'UNKNOWN_REQUEST',
            'The saved request is not included in this bundle.',
            [...path, 'requestRef', 'id'],
            context,
          );
        }
        for (const [name, binding] of Object.entries(node.bindings)) {
          const type = checkValue(
            binding,
            [...path, 'bindings', name],
            context,
          );
          if (request !== undefined) {
            if (!Object.hasOwn(request.inputs, name)) {
              issue(
                'UNKNOWN_INPUT',
                'This saved request does not declare this binding.',
                [...path, 'bindings', name],
                context,
              );
            } else if (
              type !== undefined &&
              type !== request.inputs[name]!.type
            ) {
              issue(
                'TYPE_MISMATCH',
                'The binding must match the saved request input type.',
                [...path, 'bindings', name],
                context,
              );
            }
          }
        }
        if (request !== undefined) {
          for (const [name, declaration] of Object.entries(request.inputs)) {
            if (
              declaration.required &&
              declaration.default === undefined &&
              !Object.hasOwn(node.bindings, name)
            ) {
              issue(
                'MISSING_INPUT',
                'Required request input "' +
                  name +
                  '" has no binding or default.',
                [...path, 'bindings', name],
                context,
              );
            }
          }
        }
      } else if (node.type === 'condition' || node.type === 'assert') {
        checkPredicate(node.predicate, [...path, 'predicate'], context);
      } else if (node.type === 'return') {
        checkValue(node.value, [...path, 'value'], context);
      } else if (node.type === 'repeat') {
        checkPredicate(node.until, [...path, 'until'], {
          ...context,
          loop: true,
          bodyResult: true,
        });
      }
    }
  }
  return errors.length === 0
    ? { ok: true, value: bundle }
    : { ok: false, errors };
}
