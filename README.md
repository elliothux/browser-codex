# Browser Codex

This repository tracks the plan and research for a wasm-compatible Codex agent core that can run in a browser environment.

Upstream Codex is kept as a git submodule at `external/codex` so implementation and tests can stay close to the original source.

```bash
git submodule update --init --recursive
```

## Documents

- [PLAN.md](./PLAN.md)
  - Implementation outline for the wasm agent core.
  - Focuses on session/turn handling, model event streams, tool orchestration, approval flow, and host capability traits.

- [AGENTS.md](./AGENTS.md)
  - Project instructions for future implementation work.
  - Defines the upstream reuse priority and required test strategy.

- [docs/wasm-core-harness.md](./docs/wasm-core-harness.md)
  - Two-layer test strategy: Rust unit/compile gate plus Bun/Playwright browser integration.
  - Describes how to compare our wasm core against upstream Codex oracle behavior.

- [docs/codex-rs-core-wasm-feasibility.md](./docs/codex-rs-core-wasm-feasibility.md)
  - Evaluates whether `codex-rs/core` can be compiled or refactored to WebAssembly.
  - Lists reusable parts, native blockers, and required browser abstractions.

- [docs/browser-runtime-architecture.md](./docs/browser-runtime-architecture.md)
  - Earlier browser runtime architecture research.
  - Useful background for host adapters, but not the primary wasm core plan.

## Current Direction

Do not compile `external/codex/codex-rs/core` wholesale to wasm. Instead, build a narrow wasm-compatible core that imports or mirrors upstream Codex behavior wherever practical:

1. import external
2. copy/paste raw code
3. mock/inject host capabilities
4. edit Codex source only for small feature gates
5. implement behavior ourselves only as a last resort

The core should own agent behavior only. Browser UI, product packaging, model proxy services, sandbox parity, git integration, and SQLite persistence are outside the current scope.
