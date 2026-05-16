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
  - Describes how to compare our wasm core against upstream Codex oracle behavior, including the tool-backed native core oracle runner.

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

The core should own agent behavior only. Browser UI, product packaging, model proxy services, sandbox parity, git integration, and runtime persistence adapters stay outside the core crate.

## Current Commands

```bash
bun run check
cargo test -p codex-browser-core
scripts/test-integration.sh
```

`bun run check` includes formatting, TypeScript/Rust type checks, linting, and an upstream drift check for copied apply-patch grammar, unified exec constants, copied truncation helper bodies, and TS oracle truncation goldens.

Default conformance/e2e runs intentionally avoid the `no_tool` fixture; streamed text and reasoning coverage are wrapped in `exec_command` tool turns. Native upstream core checks start from tool-backed cases such as `streamed_assistant_text_delta`, `reasoning_delta`, `early_stream_close_retry`, `unsupported_custom_tool`, `unsupported_function_tool`, `exec_success`, `exec_native_truncation`, `exec_denied`, `multiple_tool_calls`, `early_stream_close_tool_retry`, `parallel_tool_calls_disabled`, `apply_patch_add_update_delete`, `apply_patch_move`, `apply_patch_end_of_file`, `apply_patch_multiple_chunks`, and `invalid_apply_patch`. Browser-only oracle cases cover additional tool-backed boundaries such as client `tool_search`, invalid exec arguments, sandbox escalation rejection, `write_stdin` input/poll, scripted exec truncation, and invalid UTF-8 exec output.

Canonical Playwright traces also compare scripted `HostExec` request payloads and `HostApprovals` request/decision payloads, so tool-backed cases validate both model-visible behavior and the browser host boundary. Browser wasm stream tests also cover approval callback rejection becoming a model-visible denied tool output without invoking `HostExec`.

Provider compatibility fallback is isolated to the live provider adapter. The default tool mode keeps upstream-style custom/freeform `apply_patch`; selecting `applyPatchFunction` rewrites only live provider request/response wire shapes so providers that cannot emit `custom_tool_call` can still smoke-test patch turns without changing conformance specs.

Browser adapter e2e also runs `WebContainerHostExec` directly against a real WebContainer for long-running process start, stdin write, polling, TTY resize, kill, and cleanup after exit/kill. The web app e2e cases are split by behavior and each starts from at least one tool call, covering reload restore, empty workspace restore, large binary snapshot restore, OPFS snapshot edge restore, multi-session history, recently updated history ordering, history rename persistence, rapid history restore serialization, and corrupt/missing snapshot fallback.
