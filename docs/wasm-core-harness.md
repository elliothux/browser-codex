# Wasm Core Test Design

## Goal

Build a verification test suite for `codex-browser-core` that proves the wasm agent core stays close to upstream Codex behavior.

The tests should answer two questions:

- Are we depending on upstream Codex source as much as possible?
- Does our wasm core produce the same meaningful agent behavior as upstream Codex for the same scripted model responses?

This document is only about the wasm agent core. It does not cover UI, runtime adapters, or product packaging.

## Reuse Priority

Use this order whenever we need Codex behavior:

1. `import external`
2. `copy/paste raw code`
3. `mock/inject`
4. `edit codex source code`
5. `implement by ourself`

Practical meaning:

- Import upstream crates whenever they are wasm-compatible enough.
- Copy small pure helpers from upstream tests when importing pulls native dependencies.
- Current implementation note: direct wasm checks against upstream `codex-protocol` currently fail through Tokio/mio native networking, and `codex-tools` / `codex-apply-patch` pull native-heavy dependency surfaces. This was re-verified with `cargo check --manifest-path external/codex/codex-rs/apply-patch/Cargo.toml --target wasm32-unknown-unknown`, which fails in `mio` via Tokio native net. Until those crates expose narrower wasm-safe feature gates, `codex-browser-core` may copy the minimal pure wire shapes, tool schema helpers, and apply_patch parser/apply logic needed for the core, preserving upstream names and source comments.
- Mock only host capabilities, not the agent loop.
- Avoid editing `external/codex` unless a tiny feature gate unlocks large reuse.
- Implement from scratch only for test glue, host mocks, and trace comparison.

## Test Strategy

Keep the test system to two layers:

| Layer               | Command shape                                                                                              | Scope                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Unit / compile gate | `cargo test -p codex-browser-core` and `cargo check -p codex-browser-core --target wasm32-unknown-unknown` | Pure Rust agent logic, path policy, history, tool routing, output serialization, `codex-apply-patch` fixtures.                          |
| Browser integration | Bun + Playwright                                                                                           | Wasm loading, `wasm-bindgen` API, JS host adapters, WebContainer behavior, live provider smoke, and optional upstream trace comparison. |

Do not add `wasm-pack test --node` as a default layer. It is useful only if we need to debug a specific wasm-bindgen issue outside a browser. The normal wasm path should be tested in the same kind of browser environment that will run WebContainer.

## Integration Test Shape

Use Bun + TypeScript + Playwright as the integration test stack. Bun owns building, serving, case loading, and trace comparison. Playwright owns executing the wasm package inside a real browser page.

Why this is the simplest default:

- There is one browser integration entrypoint instead of separate Node-wasm, browser-wasm, and WebContainer suites.
- The wasm package runs in the real target environment.
- WebContainer can be added without changing test framework.
- JSON cases, mock Responses streams, filesystem snapshots, and trace comparison stay simple in TS.
- Playwright can also run live provider smoke cases that depend on browser fetch behavior.

Recommended layout:

```text
tests/
  cases/
    no_tool.json
    streamed_assistant_text_delta.json
    reasoning_delta.json
    apply_patch_add_update_delete.json
    invalid_apply_patch.json
    exec_success.json
    exec_denied.json
    multiple_tool_calls.json
    unsupported_custom_tool.json
    early_stream_close_retry.json
    early_stream_close_tool_retry.json
    parallel_tool_calls_disabled.json

  browser/
    index.html

  oracle/
    upstreamOracle.ts
    upstream-tool-specs/

  wasm/
    core.spec.ts
    web-app.spec.ts

scripts/
  test-unit.sh
  test-integration.sh
```

Example unit wrapper:

```bash
#!/usr/bin/env bash
set -euo pipefail

cargo test -p codex-browser-core
cargo check -p codex-browser-core --target wasm32-unknown-unknown
```

Example integration wrapper:

```bash
#!/usr/bin/env bash
set -euo pipefail

(
  cd crates/codex-browser-core
  wasm-pack build --target web --out-dir ../../pkg/codex-browser-core
)
bun run web:wasm
if [ ! -d node_modules/@playwright/test ]; then
  bun install --frozen-lockfile
fi
bunx playwright test tests/wasm "$@"
```

The browser test server must set the headers required by WebContainer:

```text
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

## Integration Test Runners

These are logical runners inside the Playwright integration suite, not separate test layers.

### Upstream Oracle Runner

Purpose: produce the reference behavior from upstream Codex.

Preferred options, in order:

1. Run an upstream Codex binary against a TS mock Responses server and capture JSON/event output.
2. If binary output is not enough, add a small native Rust oracle wrapper that imports `core_test_support` and emits normalized JSON traces.
3. Avoid modifying upstream Codex source.

Current implementation:

- `tests/oracle/upstreamOracle.ts` canonicalizes wasm traces and compares them with upstream-derived expected traces.
- Tool specs are compared as full canonical JSON. The oracle generates the expected `exec_command`, `write_stdin`, and `apply_patch` specs through `tests/oracle/upstream-tool-specs`, a small native helper that includes upstream spec source files while keeping only the minimal pure wire-shape types needed to avoid native dependency surfaces.
- For `apply_patch` cases, the oracle invokes the native upstream binary from `external/codex/codex-rs/apply-patch/src/standalone_executable.rs` against a temporary workspace, then compares stdout and final file snapshots.
- For retry cases, incomplete response output items are still recorded into the next prompt, and any completed tool calls are dispatched before retry so their model-visible outputs are also present in the follow-up request.
- For host-only cases such as denied exec, the oracle compares the model-visible canonical trace for the current host adapter behavior until a full upstream `codex-core` oracle runner is wired in.
- This oracle is part of the default Playwright wasm integration tests.

Useful upstream code:

| Purpose                                   | Upstream path                                                     |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Native test harness                       | `external/codex/codex-rs/core/tests/common/test_codex.rs`         |
| Mock Responses server and request capture | `external/codex/codex-rs/core/tests/common/responses.rs`          |
| SSE fixture loading                       | `external/codex/codex-rs/core/tests/common/lib.rs`                |
| Agent item event tests                    | `external/codex/codex-rs/core/tests/suite/items.rs`               |
| Tool behavior tests                       | `external/codex/codex-rs/core/tests/suite/tools.rs`               |
| Apply patch turn tests                    | `external/codex/codex-rs/core/tests/suite/apply_patch_cli.rs`     |
| Unified exec output shape                 | `external/codex/codex-rs/core/tests/suite/unified_exec.rs`        |
| Stream retry behavior                     | `external/codex/codex-rs/core/tests/suite/stream_no_completed.rs` |
| Patch fixtures                            | `external/codex/codex-rs/apply-patch/tests/fixtures/scenarios`    |

### Wasm Core Runner

Purpose: run our wasm core with the same case input.

It should run inside the Playwright page, import the built wasm package, and inject only host capabilities:

- `ModelTransport` behind upstream-shaped `ModelClient` / `ModelClientSession`
- `HostFileSystem`
- `HostExec`
- `HostApprovals`
- optional `HostStorage`

Do not mock:

- session state machine
- turn loop
- prompt construction
- response event handling
- tool router
- tool output serialization
- history updates

Those are the behaviors under test.

Current implementation note: the first browser runner imports the `wasm-pack` web package in a Playwright page and passes a JSON case into a wasm export. The export constructs in-memory mock implementations for `ModelTransport`, `HostFileSystem`, `HostExec`, and `HostApprovals` from that case data, so the mock boundary remains the same host boundary. JS/WebContainer-specific adapters should extend this runner later without changing the case format.

Current web app adapter note: `tests/wasm/web-app.spec.ts` runs the built web
app against `packages/browser-runtime`. That test uses real WebContainer
filesystem/process APIs, Turso browser SQLite persistence, wasm-bindgen host
callbacks, UI approval modals, and the wasm agent turn loop. The only scripted
piece is the local Responses-compatible HTTP provider used to make the test
deterministic; it exercises the same browser model transport path that live
providers use. The browser runtime imports `@tursodatabase/database-wasm/bundle`
so the Turso wasm/worker assets are loaded by the browser bundle; this is still
the Turso SQLite adapter, not a substitute store.

### Live Provider Smoke Runner

Purpose: verify that the selected Responses-compatible provider can run a Codex-shaped request in the current local environment.

This is a Playwright integration case, not the conformance oracle. The oracle remains upstream native Codex plus scripted model responses. Live provider tests only answer whether a real provider accepts the request shape and emits usable stream/tool events.

Initial provider choice:

| Field              | Value                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------- |
| Provider           | Alibaba Cloud DashScope OpenAI-compatible endpoint                                     |
| Local env          | `.env` values: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`                     |
| Initial test model | `qwen3.5-flash`                                                                        |
| Request API        | Responses API                                                                          |
| Thinking           | set provider-specific `reasoning.enable_thinking: false` for deterministic smoke tests |

Current local probe result:

- Minimal non-stream and streaming Responses requests work.
- Non-empty function tools with `tool_choice: "auto"` work and return `function_call`.
- A Codex-shaped request with function tools plus a `custom` `apply_patch` tool is accepted.
- A request that requires the model to call only the `custom/freeform` `apply_patch` tool did not produce a `custom_tool_call`; it returned ordinary text.
- `tools: []` plus `tool_choice: "auto"` fails on DashScope, but this is not representative of a normal Codex turn because upstream Codex defaults to a non-empty tool list.

Implications:

- Use DashScope as the first live compatibility provider for local smoke tests.
- Do not treat DashScope results as proof of exact Codex compatibility.
- Keep exact behavior tests on the scripted upstream oracle runner.
- Mark `custom/freeform` tools, especially `apply_patch`, as a provider-specific compatibility risk.
- If a provider cannot emit OpenAI-style `custom_tool_call`, the fallback is a provider adapter that maps patch edits to a function tool. That fallback is useful for compatibility testing but is not 100% upstream Codex behavior.

Minimum live smoke cases:

1. assistant final with no tools and no `tool_choice`
2. streamed assistant text delta
3. normal Codex-style non-empty tools with `tool_choice: "auto"`
4. `exec_command` function call
5. mixed function tools plus `custom` `apply_patch`
6. required `custom/freeform` `apply_patch` call, expected to fail or be marked unsupported until the provider proves support
7. follow-up request containing function tool output
8. empty tools plus `tool_choice: "auto"` as a provider edge-case guard, not a Codex conformance case

## Case Format

A case should be pure data so both runners can consume it.

Case ownership rule:

- Keep our own `tests/cases/*.json` files as the source of truth.
- Derive case content from upstream Codex tests by translating and trimming behavior to the wasm core scope.
- Do not try to run the full upstream Codex test suite directly against the wasm core. Those tests are coupled to native `codex-core`, Tokio, sandboxing, local process management, config, and test-support crates.
- Reuse upstream fixtures directly when they are already pure data, especially `codex-apply-patch` scenarios.
- Prefer generating expected traces from the upstream oracle runner instead of hand-writing expected output.
- Write browser/WebContainer-specific cases ourselves; upstream Codex does not cover WebContainer FS, Turso storage, wasm-bindgen stream bridges, or browser process semantics.

```json
{
  "name": "apply_patch_add_update_delete",
  "initialFiles": [
    { "path": "/workspace/modify.txt", "text": "line1\nline2\n" },
    { "path": "/workspace/delete.txt", "text": "obsolete\n" }
  ],
  "userInput": [{ "type": "text", "text": "apply the patch" }],
  "modelResponses": [
    [
      { "type": "response.created", "response": { "id": "resp-1" } },
      {
        "type": "response.output_item.done",
        "item": {
          "type": "custom_tool_call",
          "name": "apply_patch",
          "call_id": "apply-1",
          "input": "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Delete File: delete.txt\n*** Update File: modify.txt\n@@\n-line2\n+changed\n*** End Patch"
        }
      },
      {
        "type": "response.completed",
        "response": {
          "id": "resp-1",
          "usage": {
            "input_tokens": 0,
            "input_tokens_details": null,
            "output_tokens": 0,
            "output_tokens_details": null,
            "total_tokens": 0
          }
        }
      }
    ],
    [
      {
        "type": "response.output_item.done",
        "item": {
          "type": "message",
          "role": "assistant",
          "id": "msg-1",
          "content": [{ "type": "output_text", "text": "done" }]
        }
      },
      {
        "type": "response.completed",
        "response": {
          "id": "resp-2",
          "usage": {
            "input_tokens": 0,
            "input_tokens_details": null,
            "output_tokens": 0,
            "output_tokens_details": null,
            "total_tokens": 0
          }
        }
      }
    ]
  ],
  "exec": [],
  "approvals": [],
  "supportsParallelToolCalls": true,
  "expectedFinalFiles": [
    { "path": "/workspace/modify.txt", "text": "line1\nchanged\n" },
    { "path": "/workspace/nested/new.txt", "text": "created\n" }
  ]
}
```

## Trace Format

Both runners should emit the same trace shape:

```ts
export type AgentTrace = {
  modelRequests: unknown[];
  events: unknown[];
  toolOutputs: ToolOutputTrace[];
  finalFiles: FileSnapshot;
};

export type ToolOutputTrace = {
  callId: string;
  type:
    | "function_call_output"
    | "custom_tool_call_output"
    | "tool_search_output";
  text: string | null;
  success: boolean | null;
};
```

Capture at least:

- every model request body
- agent events emitted by the core
- tool call outputs that are sent back to the model
- final workspace file snapshot
- approval requests and decisions
- exec requests and results

## Canonicalization

Do not compare raw traces directly. Normalize unstable values first:

- Replace `thread_id`, `turn_id`, `session_id`, item ids, and response ids with stable placeholders when they are not part of the behavior.
- Replace timestamps and durations with placeholders.
- Normalize paths to `/workspace/...`.
- Normalize line endings to `\n`.
- Normalize exec wall time and chunk ids.
- Sort filesystem snapshots by path.
- Keep call ids from scripted model responses because they are semantically important.

Compare these fields strictly:

- request `input` history order
- tool specs exposed to the model
- tool call and tool output pairing
- tool output text and success flags after canonicalization
- event kind order
- important event payloads
- final filesystem snapshot

Current MVP canonical comparison in `tests/wasm/core.spec.ts` covers:

- model request input order, full upstream-derived tool specs, and `parallel_tool_calls`
- assistant message text
- streamed assistant text deltas, reasoning deltas, and incomplete-stream retry events
- every scripted tool output `call_id`, output type, success flag, and model-visible text in a turn
- final filesystem snapshot
- request-body invariants for tool call/output pairing in follow-up prompts

The current oracle uses native upstream source for tool schemas and native
upstream execution for `apply_patch`; for exec and unsupported-tool outputs it
raw-translates upstream output helpers because process execution is a browser
host boundary.

The upstream `responses.rs` invariant is partially translated in the TS browser
spec and should stay aligned as new output types are added:

- no tool output with empty `call_id`
- every tool output matches a prior tool call in the same model request input
- every tool call in the request input has a matching output before follow-up sampling

## Upstream Code To Copy Into TS

These are good candidates for raw copy/translation because importing the full Rust test-support crate pulls many native dependencies:

- `ev_completed`
- `ev_response_created`
- `ev_assistant_message`
- `ev_message_item_added`
- `ev_output_text_delta`
- `ev_reasoning_item`
- `ev_reasoning_summary_text_delta`
- `ev_reasoning_text_delta`
- `ev_function_call`
- `ev_custom_tool_call`
- `ev_apply_patch_custom_tool_call`
- `sse`
- request invariant validation from `validate_request_body_invariants`
- unified exec output parser shape from `core/tests/suite/unified_exec.rs`

Keep function names close to upstream so future diffs are easy.

## Mock Boundaries

Mocks are allowed only at host boundaries:

| Host capability | TS mock                     |
| --------------- | --------------------------- |
| model stream    | scripted `modelResponses`   |
| filesystem      | in-memory workspace FS      |
| exec            | scripted `ExecResult` queue |
| approvals       | scripted approval queue     |
| storage         | in-memory map               |

Mocks should record every call so the comparator can verify behavior.

## Minimum Conformance Cases

Start with these cases:

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

Then add cases from upstream suites as the wasm core gains scope.

## Case Source Policy

Use this policy when adding a new case:

1. Find the closest upstream Codex test or fixture.
2. Translate only the behavior relevant to wasm core into a neutral JSON case.
3. Run the case through the upstream oracle runner to produce the canonical expected trace.
4. Run the same case through the wasm runner and compare canonical traces.
5. Hand-write expected values only when no upstream oracle can represent the browser-only behavior.

Preferred upstream sources:

| Case type                                   | Source                                                            |
| ------------------------------------------- | ----------------------------------------------------------------- |
| no-tool, streamed message, reasoning events | `external/codex/codex-rs/core/tests/suite/items.rs`               |
| unsupported/custom tool behavior            | `external/codex/codex-rs/core/tests/suite/tools.rs`               |
| apply_patch turn behavior                   | `external/codex/codex-rs/core/tests/suite/apply_patch_cli.rs`     |
| patch parser/apply golden data              | `external/codex/codex-rs/apply-patch/tests/fixtures/scenarios`    |
| exec output and process semantics           | `external/codex/codex-rs/core/tests/suite/unified_exec.rs`        |
| incomplete stream retry                     | `external/codex/codex-rs/core/tests/suite/stream_no_completed.rs` |
| Responses event builders and invariants     | `external/codex/codex-rs/core/tests/common/responses.rs`          |
| native oracle harness shape                 | `external/codex/codex-rs/core/tests/common/test_codex.rs`         |

Browser-only cases must be maintained separately:

- WebContainer FS mount/export behavior
- WebContainer process output/input/kill/resize behavior
- `jsh -c` or shell-string fallback behavior
- Turso Browser DB `HostStorage` adapter behavior
- wasm-bindgen Promise and `ReadableStream` bindings
- web app restore behavior: persisted wasm `SessionSnapshot`, transcript rows,
  history list, WebContainer workspace snapshot after reload, and a follow-up
  post-reload `exec_command` reading the patched file from the restored workspace

These browser-only cases validate adapters and bindings. They are not upstream conformance tests unless they also have an upstream oracle trace.

## Test Commands

Keep the default commands small:

```bash
scripts/test-unit.sh
scripts/test-integration.sh
```

`scripts/test-unit.sh` should run:

```bash
cargo test -p codex-browser-core
cargo check -p codex-browser-core --target wasm32-unknown-unknown
```

`scripts/test-integration.sh` should run:

```bash
(
  cd crates/codex-browser-core
  wasm-pack build --target web --out-dir ../../pkg/codex-browser-core
)
bun run web:wasm
bunx playwright test tests/wasm
```

Do not add more default test layers until there is a concrete failure mode these two layers cannot catch.

## Acceptance Criteria

The test suite is good enough when:

- A single case can run against upstream Codex and wasm core.
- Both runners emit the same canonical `AgentTrace`.
- Patch fixtures can be reused without rewriting them.
- Tool call/output invariants fail fast with clear diagnostics.
- Adding a new upstream-inspired case only requires a JSON file and, if needed, a small scripted host result.
