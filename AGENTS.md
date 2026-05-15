# Project Instructions

## Scope

This project is building a wasm-compatible Codex agent core. Keep implementation work focused on the agent core unless the user explicitly asks for runtime adapters, UI, backend services, or product packaging.

## Command Checklist

- Check all: `bun run check`
- Format: `bun run format`
- Lint: `bun run lint`
- Typecheck: `bun run typecheck`
- Rust core tests: `cargo test -p codex-browser-core`

## Generated Files

- Do not hand-edit `apps/web/src/routeTree.gen.ts`.
- Treat `pkg/`, `apps/web/public/wasm/`, and `harness/oracle/upstream-tool-specs/target/` as generated output.
- Keep generated output out of formatting, linting, and source-review changes unless the user explicitly asks to regenerate it.

## Upstream Reuse Priority

When implementing Codex behavior, follow this priority order:

1. `import external`
2. `copy/paste raw code`
3. `mock/inject`
4. `edit codex source code`
5. `implement by ourself`

Practical rules:

- Prefer importing upstream Codex crates from `external/codex` when they are compatible with the wasm core boundary.
- Prefer direct dependencies for portable crates such as `codex-protocol`, `codex-tools`, and `codex-apply-patch`.
- If importing a whole upstream test/support crate pulls native dependencies, copy the smallest pure helper code needed and preserve upstream names where possible.
- Mock or inject only host capabilities, not Codex agent behavior.
- Avoid editing files under `external/codex`. Only consider upstream source edits when a small feature gate unlocks substantially more reuse.
- Implement behavior from scratch only after import, raw copy, mock/inject, and source-edit options are clearly worse.

## Implementation Discipline

- Default to the smallest working implementation that preserves upstream Codex behavior.
- Keep code paths direct and local. Add abstraction only when it removes real duplication or complexity.
- Do not add no-op wrappers or pass-through helper functions unless they are required by a boundary.
- Do not leave partial refactors behind. Remove unused parameters, branches, helpers, and state wiring in the same change.
- Prefer root-cause fixes and fail-fast errors over defensive fallback code that hides a mismatch.
- Preserve raw model, tool, filesystem, and provider errors when possible so trace comparisons and debugging stay useful.

## Source Of Truth

- Prefer one source of truth for each piece of state, normalization rule, schema, tool spec, prompt item shape, serialized event, and expected trace.
- If upstream Codex already defines the behavior or shape, treat upstream as the source of truth and import, copy, or derive from it before adding local definitions.
- Derive secondary views from the canonical source instead of duplicating constants, types, schemas, or serialized shapes across Rust, TypeScript, fixtures, and docs.
- When a copied fixture or compatibility shim is unavoidable, keep it narrow and document the upstream or local canonical source it mirrors.

## Dependency Boundaries

- Root `package.json` owns repo-wide tooling, shared scripts, and shared development dependencies.
- Runtime dependencies belong in the workspace that imports them at runtime.
- Shared packages in `packages/*` must declare their own direct runtime dependencies.

## Mock Boundaries

Mocks are allowed at host boundaries:

- model transport adapter: `ModelTransport` behind upstream-shaped `ModelClient` / `ModelClientSession`
- filesystem: `HostFileSystem`
- command execution: `HostExec`
- approvals: `HostApprovals`
- optional persistence: `HostStorage`

Do not mock the core behavior under test:

- session state machine
- turn loop
- prompt construction
- Responses event handling
- tool router/registry
- tool output serialization
- history updates
- approval policy decisions

## Testing Strategy

Use two complementary test layers only.

## Browser Runtime Adapter Boundary

Keep browser runtime adapters in `packages/browser-runtime`, not inside the web app.
The package owns WebContainer filesystem/exec, Turso browser SQLite storage,
workspace snapshot restore/export, and wasm host callback wiring. The web app
should consume `@browser-codex/browser-runtime` and stay focused on provider
configuration, transcript/history UI, and approval UI.

### Rust/Core Tests

Use Rust tests for low-level correctness and wasm compile gating:

- `cargo test -p codex-browser-core`
- `cargo check -p codex-browser-core --target wasm32-unknown-unknown`
- unit tests for path policy, history, prompt building, tool routing, and tool output serialization
- direct `codex-apply-patch` fixture tests

Do not add `wasm-pack test --node` as a default layer. Use it only for a specific wasm-bindgen debugging need.

### Bun/Playwright Integration Harness

Use Bun + TypeScript + Playwright for browser integration and differential verification. Bash should only be a thin wrapper for building and invoking the TS/Playwright runner.

The harness should run the same case against:

- upstream native Codex as the oracle
- our wasm core inside a Playwright browser page with mocked host capabilities

Then compare canonical traces.

Bun owns build scripts, browser harness serving, case loading, and trace comparison. Playwright owns real browser execution, including wasm loading, `wasm-bindgen` APIs, WebContainer adapters, and live provider smoke cases.

Live provider smoke tests are separate from conformance tests. For now, use `.env` to run Alibaba Cloud DashScope `qwen3.5-flash` through its OpenAI-compatible Responses endpoint. Treat this as a compatibility check only:

- normal Codex-shaped requests should use a non-empty tool list
- function tools with `tool_choice: "auto"` are expected to work
- `custom/freeform` tools such as upstream `apply_patch` are a known risk and must be tested explicitly
- `tools: [] + tool_choice: "auto"` is only a provider edge-case guard, not a Codex correctness test
- exact behavior remains judged by the upstream oracle runner with scripted model responses

Test case policy:

- Maintain our own runtime-neutral case files under `harness/cases/*.json`.
- Derive case content from upstream Codex tests and fixtures instead of inventing behavior.
- Do not run the full upstream Codex test suite directly against the wasm core.
- Generate expected canonical traces from the upstream oracle runner whenever possible.
- Compare model request input history, upstream-derived full tool specs, and model capability flags such as `parallel_tool_calls` strictly in conformance tests.
- Hand-write expected values only for browser-only adapter cases that upstream Codex cannot represent.
- Keep browser/WebContainer/Turso/wasm-bindgen cases separate from core conformance cases.

Capture at least:

- model request bodies
- agent events
- tool outputs sent back to the model
- approval requests/decisions
- exec requests/results
- final filesystem snapshot

Canonicalize before comparing:

- replace unstable ids, timestamps, durations, wall times, and chunk ids
- normalize paths to `/workspace/...`
- normalize line endings to `\n`
- sort filesystem snapshots by path
- preserve scripted model `call_id` values because they are semantic

## Upstream Test Assets To Reuse

Use these upstream assets when designing conformance cases:

- `external/codex/codex-rs/core/tests/common/responses.rs`
  - SSE event builders
  - mock Responses request capture
  - tool call/output request invariants
- `external/codex/codex-rs/core/tests/common/test_codex.rs`
  - native oracle harness shape
- `external/codex/codex-rs/core/tests/suite/items.rs`
  - item/event stream behavior
- `external/codex/codex-rs/core/tests/suite/tools.rs`
  - tool behavior and unsupported tool handling
- `external/codex/codex-rs/core/tests/suite/apply_patch_cli.rs`
  - apply_patch turn behavior
- `external/codex/codex-rs/core/tests/suite/unified_exec.rs`
  - exec output format and parser shape
- `external/codex/codex-rs/core/tests/suite/stream_no_completed.rs`
  - retry behavior for incomplete streams
- `external/codex/codex-rs/apply-patch/tests/fixtures/scenarios`
  - patch parser/apply golden fixtures

## Minimum Conformance Cases

Start with:

1. no-tool assistant final
2. streamed assistant text delta
3. reasoning item and reasoning deltas
4. unsupported custom tool returns model-visible error
5. `apply_patch` add/update/delete
6. invalid `apply_patch` returns model-visible error
7. `exec_command` success output shape
8. `exec_command` denied approval
9. early stream close retry
10. request invariant validation for tool call/output pairing
11. early stream close after a completed tool call
12. model capability disables `parallel_tool_calls`

## Documentation

Keep the detailed harness design in `docs/wasm-core-harness.md`. If implementation choices change, update that document and this file together.

## Maintenance

- After code changes, run `bun run check`.
- After Rust core behavior changes, also run `cargo test -p codex-browser-core`.
- Documentation-only and instruction-only edits do not require the full check suite.
- Keep diffs focused and avoid unrelated cleanup.
