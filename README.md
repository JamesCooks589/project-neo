# Project Neo

A personal, open-source desktop project for creating, running, and inspecting visual API workflows. Project Neo is a working name.

## The idea

Combine a familiar library of saved HTTP requests with a visual board where requests can be connected through conditions, typed value bindings, bounded loops, and assertions.

People and external AI assistants will work with the same workflow model. A local execution engine will run those workflows and provide an inspectable history of inputs, responses, decisions, and failures.

This project is intended for learning, personal use, and as a portfolio piece.

## Planned technology

- Electron, React, and TypeScript for the desktop application.
- React Flow for the workflow board.
- Versioned JSON and Zod for the workflow contract and validation.
- A standalone TypeScript runner using Undici for HTTP requests.
- SQLite and Drizzle for local persistence.
- CodeMirror for request and response editing.
- MCP for external AI access to workflows and execution evidence.

## Testing and delivery direction

- Jest for unit and integration tests.
- Playwright for end-to-end desktop tests.
- GitHub Actions for continuous integration and future release automation.
- Docker for local test APIs and headless tooling, alongside a native desktop application.

Jest tests and the workflow contract are implemented. Desktop tests, containers,
and release automation will follow their corresponding application features.

## Status

The first core milestone provides:

- An isolated TypeScript workflow-core package with Zod schemas.
- Structural and semantic validation for complete workflow bundles.
- Checks for connections, cycles, bounded loops, typed inputs and output scope.
- A portable job-polling example and generated JSON Schema.
- Jest tests for valid definitions and failure cases.

The runner, local test API, desktop application, persistence and MCP adapter are
not implemented yet. The example can be validated but cannot be executed yet.

## Development

Use Node.js 24 and npm 11 or 12.

```sh
npm ci
npm run check
```

On Windows PowerShell, use npm.cmd if execution policy prevents npm.ps1 from
running.

| Command               | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| npm run build         | Compile the core and its tests.                    |
| npm run typecheck     | Run strict TypeScript checks.                      |
| npm test              | Build and run Jest tests.                          |
| npm run test:ci       | Run tests with coverage and a JSON results report. |
| npm run format        | Format project files.                              |
| npm run format:check  | Check formatting.                                  |
| npm run schema:export | Regenerate the structural JSON Schema.             |
| npm run schema:check  | Check that the exported schema is current.         |
| npm run check         | Run the complete local verification sequence.      |

Tests run against compiled JavaScript. Coverage is written to coverage/ and
machine-readable test results to test-results/. Neither is committed.

See the [workflow contract](docs/workflow-contract.md) and
[implementation decisions](docs/decisions.md).

## Author

James Cooks

## License

[MIT](LICENSE) - Copyright (c) 2026 James Cooks.
