# Headless runner and local fixture

Project Neo can now execute the complete example through real HTTP requests.
The desktop UI, persistence and MCP adapter remain future milestones.

## Run the example

Use Node.js 24 and npm 11 or 12:

```sh
npm ci
npm run demo
```

The command builds the packages, starts a temporary loopback API, creates a job,
checks HTTP 202, polls until completion, fetches the result, and asserts that it
contains record_123. Normal completion makes exactly three polls and one result
fetch. The fixture and HTTP client are closed before the command exits.

Progress appears in the terminal. The complete report is written to
tmp/runs/latest.json by default. Each run uses new job and run IDs.

On Windows PowerShell, use npm.cmd if script policy prevents npm.ps1 from running.

## Exercise controlled failures

```sh
npm run demo -- --mode rejected
npm run demo -- --mode never-complete --interval-ms 0
npm run demo -- --mode missing-id
npm run demo -- --mode wrong-result --interval-ms 0
npm run demo -- --mode disconnected
npm run demo -- --mode slow --request-timeout-ms 100
npm run demo -- --mode slow --cancel-after-ms 100
```

| Mode           | Behaviour                                                                          |
| -------------- | ---------------------------------------------------------------------------------- |
| success        | Completes on poll three; result contains record_123.                               |
| rejected       | Create returns 400; the false branch fails with no poll/result requests.           |
| never-complete | Exactly five polls, then the exhausted branch; no sixth poll or result fetch.      |
| missing-id     | Create returns 202 without jobId; resolution errors before follow-up dispatch.     |
| wrong-result   | Final assertion fails with actual and expected values.                             |
| slow           | Poll responses are delayed by 500 ms; a shorter request timeout produces an error. |
| disconnected   | The first poll connection closes without a response; the run errors.               |

CLI options:

| Option               | Default              | Purpose                                        |
| -------------------- | -------------------- | ---------------------------------------------- |
| --mode               | success              | Select a controlled fixture scenario.          |
| --interval-ms        | 1000                 | Change the example's polling interval.         |
| --request-timeout-ms | 30000                | Override saved request deadlines for this run. |
| --cancel-after-ms    | omitted              | Cancel locally after the specified time.       |
| --report             | tmp/runs/latest.json | Choose the JSON report destination.            |
| --help               |                      | Print usage.                                   |

Exit codes are 0 for passed, 1 for failed, 2 for errored/invalid arguments, and
130 for cancelled. Ctrl+C also requests cancellation and writes a final report.
Each invocation sends real requests to its newly started local fixture.

## What is recorded

- A frozen-at-start definition snapshot, request revisions, resolved workflow
  inputs, selected non-secret environment values and runner version.
- One invocation ID for every node execution, including each body node on each
  repeat attempt. Child invocations identify their owning repeat and iteration.
- Resolved bindings and prepared request details, response metadata and body
  representations, branch selections, predicate evidence and assertion failures.
- Ordered events with monotonic sequence numbers, timestamps and invocation IDs.
- Final passed, failed, errored or cancelled status, errors, skipped node IDs and
  observer warnings.

Snapshots are diagnostic copies with redaction applied; they are not importable
credentials-bearing run bundles. Later edits to the caller's definitions affect
the next run, never the active run.

HTTP bodies are represented independently as bounded original bytes encoded in
base64, a text preview, and optional parsed JSON. The adapter defaults to a 1 MiB
body limit, 1 MiB JSON parse limit and an 8 KiB preview. Exceeding the body limit
errors the run. Parsing/preview limits are reported explicitly. Non-JSON and
malformed JSON responses remain inspectable HTTP responses; a later JSON binding
can still fail when the required value is absent.

Resolved secrets, authentication values, sensitive header/field names and known
credential values are redacted in reports and live diagnostics. Encoded raw
bodies are omitted when redaction is needed, with a redacted marker and the
original byte count. Field-name detection is heuristic; arbitrary business data
is not automatically classified as sensitive.

Reading a saved JSON report performs no HTTP. No trace replay feature is provided.

## Execution boundaries

workflow-core exports runWorkflow and the request/value/predicate contracts. The
runner accepts an injected HttpTransport, optional secret resolver, cancellable
sleep adapter and synchronous event listener. It imports no React, Electron or
Undici. The HTTP adapter is a separate workspace.

Complete bundles are validated before any dispatch. Invalid definitions throw
WorkflowValidationError. Valid definitions with input, transport or runtime
problems produce an errored report with a specific error code.

The engine implements sequential exclusive branches and one level of explicit
bounded repetition. Each repeat iteration has a fresh output scope and can read
already completed ancestor outputs. Conditions use strict JSON equality and
short-circuit logical operators. Each run enforces request deadlines, a global
deadline and a node-invocation budget. Long waits are chunked to avoid Node timer
overflow. There is no delay after completion or exhaustion.

The Undici adapter installs no redirect/retry interceptor. HTTP 401/500 are
received responses; connection failures and timeouts are errors. Request
preparation resolves typed values, encodes path bindings as one segment, and
prevents missing bindings or invalid headers from dispatching malformed requests.

Cancellation aborts in-flight I/O where supported, interrupts waits and prevents
later dispatch. It does not undo an API side effect that already happened.
Injected adapters should honour their AbortSignal; the engine also stops awaiting
an uncooperative adapter. Listener exceptions are recorded as warnings.

## Run only the fixture API

```sh
npm run fixture
```

The standalone fixture binds to 127.0.0.1:4317. Set NEO_FIXTURE_PORT to use another
port (0 requests an ephemeral port). It keeps job counters local to each job and
stores no data after shutdown.

| Route                    | Purpose                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| GET /health              | Readiness check.                                                                              |
| POST /jobs               | Accept mode, completeAfterPolls (default 3), and delayMs (default 500). Return 202 and jobId. |
| GET /jobs/{jobId}        | Advance that job's poll counter and report processing/completed.                              |
| GET /jobs/{jobId}/result | Return 409 before completion, otherwise the fixture result.                                   |

Auxiliary echo, status, redirect, text, invalid-JSON and disconnect routes support
transport integration tests. The CLI demo starts its own ephemeral fixture;
it does not require this standalone process.
