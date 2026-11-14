import { z } from 'zod';

export const CONTRACT_VERSION = 1;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type ValueSpec =
  | { kind: 'literal'; value: JsonValue }
  | { kind: 'workflowInput'; name: string }
  | { kind: 'requestInput'; name: string }
  | { kind: 'environment'; name: string }
  | { kind: 'secret'; name: string }
  | { kind: 'stepOutput'; nodeId: string; path: string }
  | { kind: 'loopContext'; path: string }
  | { kind: 'bodyResult'; path: string }
  | { kind: 'object'; entries: Record<string, ValueSpec> }
  | { kind: 'array'; items: ValueSpec[] };

export type Predicate =
  | {
      op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';
      left: ValueSpec;
      right: ValueSpec;
    }
  | { op: 'exists'; value: ValueSpec }
  | { op: 'and' | 'or'; args: Predicate[] }
  | { op: 'not'; arg: Predicate };

interface NodeIdentity {
  id: string;
  name?: string | undefined;
}

export type WorkflowNode =
  | (NodeIdentity & {
      type: 'request';
      requestRef: { id: string };
      bindings: Record<string, ValueSpec>;
    })
  | (NodeIdentity & { type: 'condition' | 'assert'; predicate: Predicate })
  | (NodeIdentity & {
      type: 'repeat';
      maxIterations: number;
      intervalMs: number;
      body: WorkflowGraph;
      until: Predicate;
    })
  | (NodeIdentity & {
      type: 'end';
      outcome: 'passed' | 'failed';
      reason?: string | undefined;
    })
  | (NodeIdentity & { type: 'return'; value: ValueSpec });

export interface WorkflowGraph {
  entryNodeId: string;
  nodes: WorkflowNode[];
  edges: { from: string; port: string; to: string }[];
}

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_-]*$/,
    'Use letters, digits, underscores or hyphens; start with a letter or underscore.',
  );

// RFC 6901: empty pointer, or slash-delimited tokens with only ~0 / ~1 escapes.
const pointerSchema = z
  .string()
  .regex(/^(?:\/(?:[^~/]|~[01])*)*$/, 'Expected an RFC 6901 JSON Pointer.');

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const valueSpecSchema: z.ZodType<ValueSpec> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('literal'), value: jsonValueSchema }),
    z.strictObject({
      kind: z.literal('workflowInput'),
      name: identifierSchema,
    }),
    z.strictObject({ kind: z.literal('requestInput'), name: identifierSchema }),
    z.strictObject({ kind: z.literal('environment'), name: identifierSchema }),
    z.strictObject({ kind: z.literal('secret'), name: identifierSchema }),
    z.strictObject({
      kind: z.literal('stepOutput'),
      nodeId: identifierSchema,
      path: pointerSchema,
    }),
    z.strictObject({ kind: z.literal('loopContext'), path: pointerSchema }),
    z.strictObject({ kind: z.literal('bodyResult'), path: pointerSchema }),
    z.strictObject({
      kind: z.literal('object'),
      entries: z.record(z.string(), valueSpecSchema),
    }),
    z.strictObject({
      kind: z.literal('array'),
      items: z.array(valueSpecSchema),
    }),
  ]),
);

export const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.strictObject({
      op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains']),
      left: valueSpecSchema,
      right: valueSpecSchema,
    }),
    z.strictObject({ op: z.literal('exists'), value: valueSpecSchema }),
    z.strictObject({
      op: z.enum(['and', 'or']),
      args: z.array(predicateSchema).min(1),
    }),
    z.strictObject({ op: z.literal('not'), arg: predicateSchema }),
  ]),
);

export const inputDeclarationSchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
  required: z.boolean().default(false),
  default: jsonValueSchema.optional(),
});

const inputDeclarationsSchema = z.record(
  identifierSchema,
  inputDeclarationSchema,
);
const parameterSchema = z.strictObject({
  name: z.string().min(1),
  value: valueSpecSchema,
  enabled: z.boolean().default(true),
});

export const requestDefinitionSchema = z.strictObject({
  id: identifierSchema,
  revision: z.number().int().positive(),
  name: z.string().min(1),
  method: z.enum([
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
    'TRACE',
  ]),
  inputs: inputDeclarationsSchema.default({}),
  url: z.strictObject({
    base: valueSpecSchema,
    path: z.string().regex(/^\//, 'Paths must start with a slash.'),
  }),
  headers: z.array(parameterSchema).default([]),
  query: z.array(parameterSchema).default([]),
  body: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('none') }),
      z.strictObject({ kind: z.literal('json'), value: valueSpecSchema }),
      z.strictObject({ kind: z.literal('text'), value: valueSpecSchema }),
    ])
    .optional(),
  auth: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('none') }),
      z.strictObject({
        kind: z.literal('basic'),
        username: valueSpecSchema,
        password: valueSpecSchema,
      }),
      z.strictObject({ kind: z.literal('bearer'), token: valueSpecSchema }),
      z.strictObject({
        kind: z.literal('apiKey'),
        name: z.string().min(1),
        in: z.enum(['header', 'query']),
        value: valueSpecSchema,
      }),
    ])
    .optional(),
  timeoutMs: z.number().int().positive().default(30_000),
});

const nodeIdentity = {
  id: identifierSchema,
  name: z.string().min(1).optional(),
};

export const graphSchema: z.ZodType<WorkflowGraph> = z.lazy(() =>
  z.strictObject({
    entryNodeId: identifierSchema,
    nodes: z.array(nodeSchema).min(1),
    edges: z.array(
      z.strictObject({
        from: identifierSchema,
        port: z.string().min(1),
        to: identifierSchema,
      }),
    ),
  }),
);

export const nodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject({
      ...nodeIdentity,
      type: z.literal('request'),
      requestRef: z.strictObject({ id: identifierSchema }),
      bindings: z.record(identifierSchema, valueSpecSchema).default({}),
    }),
    z.strictObject({
      ...nodeIdentity,
      type: z.literal('condition'),
      predicate: predicateSchema,
    }),
    z.strictObject({
      ...nodeIdentity,
      type: z.literal('assert'),
      predicate: predicateSchema,
    }),
    z.strictObject({
      ...nodeIdentity,
      type: z.literal('repeat'),
      maxIterations: z.number().int().positive(),
      intervalMs: z.number().int().nonnegative(),
      body: graphSchema,
      until: predicateSchema,
    }),
    z.strictObject({
      ...nodeIdentity,
      type: z.literal('end'),
      outcome: z.enum(['passed', 'failed']),
      reason: z.string().optional(),
    }),
    z.strictObject({
      ...nodeIdentity,
      type: z.literal('return'),
      value: valueSpecSchema,
    }),
  ]),
);

export const workflowSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_VERSION),
  id: identifierSchema,
  revision: z.number().int().positive(),
  name: z.string().min(1),
  inputs: inputDeclarationsSchema.default({}),
  environmentRequirements: z.array(identifierSchema).default([]),
  entryNodeId: identifierSchema,
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(
    z.strictObject({
      from: identifierSchema,
      port: z.string().min(1),
      to: identifierSchema,
    }),
  ),
  limits: z.strictObject({
    maxRunDurationMs: z.number().int().positive(),
    maxNodeInvocations: z.number().int().positive(),
  }),
});

export const workflowBundleSchema = z.strictObject({
  bundleVersion: z.literal(CONTRACT_VERSION),
  requests: z.array(requestDefinitionSchema),
  workflow: workflowSchema,
});

export type InputDeclaration = z.infer<typeof inputDeclarationSchema>;
export type RequestDefinition = z.infer<typeof requestDefinitionSchema>;
export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowBundle = z.infer<typeof workflowBundleSchema>;

export function bundleJsonSchema() {
  return {
    ...z.toJSONSchema(workflowBundleSchema, { io: 'input' }),
    $id: 'urn:project-neo:workflow-bundle:1',
    title: 'Project Neo workflow bundle (draft v0.1)',
    description:
      'Structural schema only. Use validateWorkflowBundle for graph, scope and type checks.',
  };
}
