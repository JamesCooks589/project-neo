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

These are planned capabilities. No application code, test suites, containers, or CI workflows are included yet.

## Status

Initial repository setup. Implementation, development commands, and runnable examples will follow in later commits.

## Author

James Cooks

## License

[MIT](LICENSE) - Copyright (c) 2026 James Cooks.
