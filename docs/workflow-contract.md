# Workflow contract: draft v0.1

The source contract is in packages/workflow-core/src/schema.ts. The generated
structural JSON Schema is in schemas/workflow-bundle.schema.json.
examples/job-polling.bundle.json contains all three saved requests and the complete
create-job, branch, bounded-poll, result and assertion graph.

This milestone validates definitions. It does not execute requests or predicates.
The execution semantics below are the contract the next runner milestone will
implement.

## Public API

After building, the private npm workspace exports:

- workflowBundleSchema, workflowSchema, requestDefinitionSchema, nodeSchema,
  graphSchema, valueSpecSchema and predicateSchema for structural checks.
- validateWorkflowBundle(input) for structural and semantic checks on a complete
  bundle.
- bundleJsonSchema() for a JSON-serializable structural schema.
- TypeScript types for definitions, values, predicates and validation results.

Validation returns either an object with ok: true and a parsed value, or ok: false
and an errors array. Each error includes code, message and a path array; semantic
errors also identify a node or saved request when relevant. Defaults are applied
to a parsed copy. The input object is not modified.

For example, a broken edge produces a DANGLING_EDGE issue at a path such as
["workflow", "edges", 0]. An unavailable binding can produce
UNAVAILABLE_STEP_OUTPUT at ["workflow", "nodes", 3, "bindings", "jobId"].

## Bundle and saved requests

A bundle contains bundleVersion: 1, requests and one workflow. The workflow
contains schemaVersion: 1, identity/revision, input declarations, environment
requirements, an entry node, nodes, edges and explicit run limits. Revision
numbers start at one. Revision conflict handling belongs to the future
application service.

A request node refers to a saved request by ID and supplies bindings for its
declared inputs. Saved request templates use requestInput references; the node
bindings use workflowInput or earlier stepOutput references. Per-node bindings
do not change the reusable saved request.

Saved requests support standard HTTP methods, an HTTP(S) base, a slash-prefixed
path, ordered header/query entries, JSON/text bodies, authentication configuration
and a positive timeout. Path placeholders such as /jobs/{jobId} must name
declared request inputs. Query parameters are separate from the path. Runtime URL
encoding, dispatch and authentication are not implemented yet.

## Graphs

| Node      | Required output ports | Meaning                                               |
| --------- | --------------------- | ----------------------------------------------------- |
| request   | response              | Prepare and dispatch one saved request.               |
| condition | true, false           | Select exactly one branch.                            |
| assert    | pass                  | Continue on success; a false assertion fails the run. |
| repeat    | completed, exhausted  | Execute a bounded body using do-until semantics.      |
| end       | none                  | Finish the outer workflow with passed or failed.      |
| return    | none                  | Return one body value to its owning repeat node.      |

IDs are globally unique across the workflow and all repeat bodies. Connections
stay inside their graph. Every required output port has exactly one destination,
and all nodes must be reachable from that graph's entry. Ordinary back-edges,
self-cycles, parallel forks and nested repeats are rejected. Moving a node or
changing array order has no execution meaning.

A repeat requires positive maxIterations, non-negative intervalMs, a body graph
and an until predicate. After each body return, the predicate inspects bodyResult.
Completion and exhaustion have no trailing delay. Each iteration will have a
fresh scope; no implicit previous-iteration state is supported.

## Values and scope

| kind           | Meaning / valid location                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| literal        | Ordinary JSON, kept as data with no interpolation or reference evaluation inside it.                                           |
| object / array | Recursive typed composition using entries or items.                                                                            |
| workflowInput  | A declared workflow input; outside saved request templates.                                                                    |
| requestInput   | A declared saved request input; inside its template only.                                                                      |
| environment    | A named non-secret environment value. Used requests and workflow expressions must declare the name in environmentRequirements. |
| secret         | A local credential reference; runtime resolution and redaction are future work.                                                |
| stepOutput     | An available node ID and JSON Pointer path.                                                                                    |
| loopContext    | Current iteration metadata, inside a body or its until predicate.                                                              |
| bodyResult     | The current body return value, only inside the owning until predicate.                                                         |

Input types are string, number, boolean, array and object. Defaults and statically
known bindings must match without coercion. Numbers, booleans, objects, arrays and
null remain JSON values. An empty pointer selects an entire output; /a~1b/~0c
selects keys containing a slash and a tilde.

Graph dominance determines guaranteed availability. A source must complete on
every path before the consumer. A loop body can read guaranteed upstream
ancestor outputs and earlier outputs from its own iteration. Outer nodes read
the repeat's exported output, not the nodes inside its body.

The same availability rule applies inside exists. At runtime exists will handle
missing response fields; it does not make future or skipped-branch nodes into
valid static sources. Runtime response paths and unknown data types are not
validated by this milestone.

## Predicates

Supported operators are eq, neq, gt, gte, lt, lte, exists, contains, and, or and
not. Equality uses JSON values without string/number coercion. Numeric comparison
operands must be numbers. contains takes an array and a primitive JSON value.
Boolean groups must contain at least one predicate. Future evaluation will
short-circuit and/or in declared order.

## JSON Schema and verification

Run npm run schema:export after changing structural schemas. The generated file
describes accepted input, including optional fields with defaults. Run npm run
schema:check to detect a stale export.

JSON Schema alone does not check graph reachability, port cardinality, scope,
input defaults or request cross-references. Use validateWorkflowBundle for those
checks. A successful result still does not prove that an API will return a
particular response shape or that a chosen environment contains run-time values.
