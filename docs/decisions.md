# Implementation decisions

## 2026-11-14: first workflow-core milestone

- **Project and licence:** Project Neo is the working name. James Cooks selected MIT.
- **Runtime:** Node.js 24 and npm workspaces, with exact direct dependency versions and a committed lockfile. Node 24 is also the CI target.
- **Package boundary:** Start with one private package, workflow-core. Add adapters when there is working behaviour to put in them.
- **TypeScript:** Strict checking, including unchecked-index and exact-optional-property checks. Use the current stable TypeScript 7 release resolved during setup.
- **Module output:** Compile the core and tests to CommonJS using NodeNext resolution. Jest tests the emitted code, with a separate strict type-check command. No additional TypeScript test transformer is needed. The eventual Electron integration can revisit module distribution.
- **Contract:** Adopt bundleVersion 1 and schemaVersion 1 as an evolving draft, based on the handover example. They are not a published compatibility promise.
- **Identifiers and references:** Stable IDs and input/environment/secret names start with a letter or underscore, followed by letters, digits, underscores or hyphens, with at most 128 characters. Display names are separate. Output paths use RFC 6901 JSON Pointer.
- **Graph rules:** Sequential execution, exclusive branches, explicit repeat bodies, and one repeat nesting level. Each required port has exactly one destination. Outer graphs and repeat bodies are acyclic.
- **Availability:** A referenced output must be guaranteed to complete before its consumer on every incoming path. Loop bodies may also read guaranteed upstream ancestor outputs. This is conservative static checking; it does not infer the truth of user predicates.
- **Limits and defaults:** Require explicit positive run duration/invocation limits and repeat bounds. Default request timeouts to 30 seconds; default optional inputs, bindings, headers and query collections to empty. Input declarations default to optional. A required input may be supplied by a default.
- **Validation boundaries:** Structural schemas reject unknown fields. Semantic validation checks graph, references, scope and statically known types. Dynamic response paths and types require a future runner. Validation never dispatches HTTP.
- **Portability:** Commit a generated JSON Schema and the complete job-polling example. CI checks that the exported schema matches the Zod source.
- **Verification:** Use Jest for current contract/validator behaviour. Playwright will exercise real desktop flows once the UI exists. Docker will support the fixture API and headless tooling in a later milestone.
- **Schema portability:** Test the committed JSON Schema with Ajv independently of Zod. Express the URL path prefix with a standard pattern rather than a library-specific format.

## Dependency follow-up: 2026-11-14

The runtime dependency audit is clean. The development dependency audit reports
19 low/moderate findings inherited through Jest's dependency tree. A compatible
audit fix was applied; the remaining suggested forced fix would downgrade Jest
to version 25, so it was not applied. Review these findings when updating Jest;
use npm audit to inspect them and npm audit --omit=dev for the runtime tree.

## Still open

SQLite driver, Electron packaging targets, MCP process bridge, editor design,
final branding and release policy remain open. Storage, the desktop application
and MCP integration are not implemented yet.

## 2026-11-14: headless execution and fixture

- **Boundaries:** Keep interpretation, values, predicates and event contracts in
  workflow-core. Use a separate Undici 8 HTTP adapter and separate fixture/runner
  tooling workspaces. Build in dependency order, including fixture types used by
  transport tests.
- **Real execution:** Adopt the validated example without changing its JSON
  contract. Use sequential exclusive branching and fresh repeat-body scopes.
  Successful runs make three polls; never-completing jobs stop after five.
- **Snapshots and history:** Capture a parsed definition copy and input/environment
  configuration before execution. Retain a unique invocation for every node
  attempt and monotonically ordered events. Export redacted diagnostic copies.
- **Failures:** Received HTTP statuses are ordinary responses. Assertion/end
  failures are failed, transport/input/time-limit problems are errored, and
  cancellation is cancelled. Invalid definitions reject before dispatch.
- **Timing:** Enforce saved request deadlines, a global run deadline and an
  invocation budget. Use cancellable delays, chunk long timers, and stop awaiting
  uncooperative injected adapters when aborted. No trailing loop delay.
- **HTTP:** Use an agent without redirect/retry interceptors. Keep raw bounded
  bytes, parsed JSON and display previews separate. Default limits are 1 MiB for
  responses/JSON parsing and 8 KiB for previews.
- **Request preparation:** Resolve inputs before dispatch, encode dynamic path
  segments, reject dot-only dynamic segments and invalid headers, and keep base
  URL credentials/query/fragments out of the base. Auth configuration overrides
  duplicate corresponding headers/query values.
- **Credentials:** Resolve secret references through an injected local resolver,
  caching values per run. Redact auth values, sensitive field/header names and
  known secrets in live/stored diagnostics. Omit encoded bodies when redaction is
  needed; field-name recognition remains heuristic.
- **Fixture:** Bind to loopback, keep counters per job and create a fresh fixture
  for the self-contained demo. Add predictable rejection, exhaustion, missing-ID,
  wrong-result, slow-response and disconnection variants.
- **CLI:** Provide npm run demo and npm run fixture. Save complete reports under
  tmp/runs by default. Use exit codes 0/1/2/130 for passed/failed/errored/cancelled.
