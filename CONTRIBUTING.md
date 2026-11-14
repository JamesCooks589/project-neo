# Contributing

Project Neo has a working headless runner and local HTTP fixture. The next
planned milestone is the desktop shell, shared application service and local
persistence around that engine.

## Set up and verify

Use Node.js 24 and npm 11 or 12, then run:

```sh
npm ci
npm run check
```

Use npm.cmd on Windows PowerShell if script policy prevents npm.ps1 from running.

The check command verifies formatting, strict types, a clean build, Jest tests
with coverage, and the generated JSON Schema. CI runs these checks on Windows
and Linux and stores test/coverage reports for 14 days. It also runs the local
HTTP demo and saves its complete trace as test-results/demo-run.json in the
reports artifact. Action versions are pinned to upstream commit SHAs; update
those pins deliberately.

Use npm run demo to try the default example, or npm run fixture to start the
standalone test API. See docs/headless-runner.md for controlled failure scenarios.

## Change the workflow contract

1. Edit schemas/types in packages/workflow-core/src/schema.ts and semantic checks
   in packages/workflow-core/src/validate.ts. Execution, values and predicates
   live alongside these modules; HTTP I/O belongs to the separate adapter.
2. Update the example and the contract documentation when behaviour changes.
3. Add tests for the behaviour and failure cases that the change affects.
4. Regenerate structural schema output with npm run schema:export.
5. Run npm run format and npm run check.

The current version is a draft. Keep source types, structural schema, semantic
checks, examples, runner semantics and documentation consistent. Validators must
not send requests. The engine must not depend on React, Electron or Undici.

Tests are authored in TypeScript and run against emitted JavaScript. The root
build removes only known build output before compiling, preventing stale deleted
tests from being discovered. Do not commit dist/, coverage/, test-results/,
node_modules/, local environment files or credentials.

## Pull requests

Describe the concrete behaviour changed, why it is needed, and the commands used
to verify it. Keep unrelated changes in separate commits. See docs/decisions.md
for material implementation choices and current dependency follow-ups.

## Releases

CI can be called by a future release workflow, but installer packaging and
release publishing are not configured yet. Add them once a runnable desktop
application can be built and smoke-tested. Playwright desktop tests and Docker
checks should similarly verify working features as they are introduced.
