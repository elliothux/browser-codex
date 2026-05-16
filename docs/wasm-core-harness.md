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
- Current implementation note: direct wasm checks against upstream `codex-protocol` currently fail through Tokio/mio native networking, and `codex-tools` / `codex-apply-patch` pull native-heavy dependency surfaces. This was re-verified with `cargo check --manifest-path external/codex/codex-rs/apply-patch/Cargo.toml --target wasm32-unknown-unknown`, which fails in `mio` via Tokio native net. Until those crates expose narrower wasm-safe feature gates, `codex-browser-core` may copy the minimal pure wire shapes, tool schema helpers, truncation helpers, and apply_patch parser/apply logic needed for the core, preserving upstream names and source comments. `scripts/check-upstream-sync.ts` compares the copied truncation helper bodies and TS oracle truncation goldens against the expected upstream behavior.
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
    unsupported_custom_tool.json
    streamed_assistant_text_delta.json  # includes exec_command setup
    reasoning_delta.json                # includes exec_command setup
    apply_patch_add_update_delete.json
    apply_patch_move.json
    apply_patch_end_of_file.json
    apply_patch_multiple_chunks.json
    invalid_apply_patch.json
    exec_success.json
    exec_native_truncation.json
    exec_denied.json
    exec_truncation.json
    exec_invalid_utf8.json
    exec_tty_shell_payload.json
    exec_unsupported_sandbox_permissions.json
    multiple_tool_calls.json
    unsupported_custom_tool.json
    unsupported_function_tool.json
    invalid_exec_arguments.json
    tool_search_client.json
    early_stream_close_retry.json
    early_stream_close_tool_retry.json
    parallel_tool_calls_disabled.json
    write_stdin_poll.json
    write_stdin_write.json

  browser/
    index.html

  oracle/
    upstreamOracle.ts
    upstream-tool-specs/
    native-core-runner/

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

- `tests/oracle/upstreamOracle.ts` canonicalizes wasm traces and compares them with upstream-derived expected traces, including scripted host-boundary `exec` and `approvals` request payloads.
- `tests/oracle/native-core-runner` is a standalone Rust helper that imports upstream `core/tests/common/test_codex.rs` and `responses.rs` to run selected tool-backed cases through native Codex core and emit canonical JSON. It intentionally rejects cases with no supported tool call, so default native/e2e coverage does not run `no_tool`. Current native-core-backed cases include `streamed_assistant_text_delta`, `reasoning_delta`, `early_stream_close_retry`, `unsupported_custom_tool`, `unsupported_function_tool`, `exec_success`, `exec_native_truncation`, `exec_denied`, `multiple_tool_calls`, `early_stream_close_tool_retry`, `parallel_tool_calls_disabled`, `apply_patch_add_update_delete`, `apply_patch_move`, `apply_patch_end_of_file`, `apply_patch_multiple_chunks`, and `invalid_apply_patch`.
- Tool specs are compared as full canonical JSON. The oracle generates the expected `exec_command`, `write_stdin`, and `apply_patch` specs through `tests/oracle/upstream-tool-specs`, a small native helper that includes upstream spec source files while keeping only the minimal pure wire-shape types needed to avoid native dependency surfaces.
- For freeform `apply_patch` cases, the oracle runs the turn through upstream native Codex core, including `external/codex/codex-rs/core/src/tools/handlers/apply_patch.rs`, then compares the model-visible unified-exec success output, parser/verification errors, and final file snapshots.
- For retry cases, incomplete response output items are still recorded into the next prompt, and any completed tool calls are dispatched before retry so their model-visible outputs are also present in the follow-up request.
- For `exec_command`, the native core runner now executes selected successful, deterministic truncation, and approval-denied function-call cases through upstream Codex and normalizes unstable chunk ids, wall times, and native temporary workspace paths. The browser wasm trace also compares the exact `HostExec` request payload and `HostApprovals` request/decision payload derived from the same case JSON.
- For `write_stdin` and browser-only process behavior, process execution remains a host boundary and the oracle raw-translates upstream unified exec output shape from scripted exec snapshots while comparing the host request payload strictly.
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

Current implementation note: the first browser runner imports the `wasm-pack`
web package in a Playwright page and passes a JSON case into a wasm export. The
export constructs in-memory mock implementations for `ModelTransport`,
`HostFileSystem`, `HostExec`, and `HostApprovals` from that case data, so the
mock boundary remains the same host boundary. The wasm package also exports
`run_host_turn_stream_json`, which returns a browser `ReadableStream` of turn
events plus a final output chunk; stream cancellation maps to the core
cancellation token. Playwright covers the stream export and approval host
callback rejection: a rejected JS approval promise becomes a model-visible
denied `function_call_output`, and `HostExec` is not invoked.

Current web app adapter note: `tests/wasm/web-app.spec.ts` runs the built web
app against `packages/browser-runtime`. Its e2e coverage is split by behavior:
real wasm turn + reload restore, empty workspace restore, large binary snapshot
restore, OPFS snapshot edge restore, multi-session history, recently updated
history ordering, history rename persistence, rapid history restore
serialization, and corrupt/missing snapshot fallback. Each case starts from at
least one real tool call, so the default gate does not rely on a `no_tool` path.
These tests use real WebContainer filesystem/process APIs, Turso browser SQLite
metadata persistence, OPFS workspace snapshot storage, wasm-bindgen host
callbacks, UI approval modals, and the wasm agent turn loop. The only scripted
piece is the local Responses-compatible HTTP provider used to make the tests
deterministic; it exercises the same browser model transport path that live
providers use. The browser runtime imports `@tursodatabase/database-wasm/bundle`
so the Turso wasm/worker assets are loaded by the browser bundle; this is still
the Turso SQLite adapter, not a substitute store. SQLite must not store workspace
blobs or file manifests.

Current WebContainer host adapter note:
`tests/wasm/webcontainer-host.spec.ts` runs `WebContainerHostExec` directly
against a real browser WebContainer. It covers long-running process start,
stdin write, output polling, TTY resize, kill, and process table cleanup after
exit/kill. This remains a browser adapter test, not an upstream conformance
oracle.

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

- `tests/wasm/core.spec.ts` includes deterministic local-provider smoke for the
  browser live adapter: a normal live turn must send non-empty `tools` with
  `tool_choice: "auto"`, and non-2xx provider error bodies are normalized into
  model errors.
- The live adapter has an explicit provider compatibility mode,
  `toolCompatibility: "applyPatchFunction"`, for providers that cannot accept
  or emit upstream custom/freeform tools. In that mode only, the adapter
  rewrites the provider-visible `apply_patch` tool to a function schema with a
  `patch` argument and maps provider `function_call apply_patch` responses back
  to the core's upstream-shaped `custom_tool_call`. The default mode remains
  upstream-style custom/freeform `apply_patch`.
- `tests/wasm/web-app.spec.ts` uses the same browser fetch/provider path for a
  deterministic function-tool follow-up plus custom `apply_patch` flow.
- Minimal non-stream and streaming Responses requests work.
- Non-empty function tools with `tool_choice: "auto"` work and return `function_call`.
- A Codex-shaped request with function tools plus a `custom` `apply_patch` tool is accepted.
- A request that requires the model to call only the `custom/freeform` `apply_patch` tool did not produce a `custom_tool_call`; it returned ordinary text.
- `tools: []` plus `tool_choice: "auto"` fails on DashScope, but this is not representative of a normal Codex turn because upstream Codex defaults to a non-empty tool list.

Provider support matrix, recorded from the local DashScope probe and the
deterministic adapter smoke tests:

| Provider / model             | Normal non-empty tools + `tool_choice: "auto"` | Function tool call | Mixed function tools + custom `apply_patch` | Required custom/freeform `apply_patch`  | `applyPatchFunction` fallback | Empty tools + `tool_choice: "auto"` |
| ---------------------------- | ---------------------------------------------- | ------------------ | ------------------------------------------- | --------------------------------------- | ----------------------------- | ----------------------------------- |
| DashScope `qwen3.5-flash`    | accepted                                       | works              | accepted                                    | not observed to emit `custom_tool_call` | supported through adapter     | provider error                      |
| Local deterministic provider | covered in Playwright                          | covered            | covered                                     | covered as scripted upstream shape      | covered                       | intentionally not in default gate   |

Latest local DashScope check: on 2026-05-15, `qwen3.5-flash` accepted a
Responses request with a non-empty `exec_command` function tool list,
`tool_choice: "auto"`, and provider-specific thinking disabled, returning
`reasoning` plus `function_call exec_command`.

Implications:

- Use DashScope as the first live compatibility provider for local smoke tests.
- Do not treat DashScope results as proof of exact Codex compatibility.
- Keep exact behavior tests on the scripted upstream oracle runner.
- Mark `custom/freeform` tools, especially `apply_patch`, as a provider-specific compatibility risk.
- If a provider cannot emit OpenAI-style `custom_tool_call`, the explicit
  provider adapter fallback maps patch edits to a function tool. That fallback
  is useful for compatibility testing but is not 100% upstream Codex behavior
  and is not used by conformance tests.

Minimum live smoke cases:

1. normal Codex-style non-empty tools with `tool_choice: "auto"`
2. `exec_command` function call
3. streamed assistant text delta
4. mixed function tools plus `custom` `apply_patch`
5. required `custom/freeform` `apply_patch` call, expected to fail or be marked unsupported until the provider proves support
6. follow-up request containing function tool output
7. explicit `applyPatchFunction` compatibility fallback for providers without custom/freeform support
8. empty tools plus `tool_choice: "auto"` as a manually-invoked provider edge-case guard, not a default Codex conformance case

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
- approval request/decision payloads for scripted host approvals
- exec host request payloads for scripted process operations
- request-body invariants for tool call/output pairing in follow-up prompts

The current oracle uses native upstream source for tool schemas and native
upstream core execution for freeform `apply_patch`, selected `exec_command`,
and unsupported-tool cases. For `write_stdin` and
browser-only process behavior it raw-translates upstream output helpers because
process execution is a browser host boundary.

The upstream `responses.rs` invariant is partially translated in the TS browser
spec and should stay aligned as new output types are added:

- no `*_call_output` item with an empty `call_id`
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

Start with these cases. Every default native/e2e case should contain at least
one tool-backed turn, and the default gate must not run `no_tool`:

1. unsupported custom tool returns model-visible error
2. `apply_patch` add/update/delete
3. invalid `apply_patch` returns model-visible error
4. `exec_command` success output shape
5. `exec_command` denied approval
6. request invariant validation for tool call/output pairing
7. early stream close after a completed tool call
8. `write_stdin` polling output shape and tool/output pairing
9. `write_stdin` input output shape and host request payload
10. unsupported function tool and client `tool_search` output behavior
11. invalid `exec_command` arguments and unsupported sandbox escalation
12. `exec_command` truncation, invalid UTF-8 output, and shell/login/tty host payload
13. streamed assistant text delta
14. reasoning item and reasoning deltas
15. early stream close retry
16. model capability disables `parallel_tool_calls`

Then add cases from upstream suites as the wasm core gains scope.

## Case Source Policy

Use this policy when adding a new case:

1. Find the closest upstream Codex test or fixture.
2. Translate only the behavior relevant to wasm core into a neutral JSON case.
3. Run the case through the upstream oracle runner to produce the canonical expected trace.
4. Run the same case through the wasm runner and compare canonical traces.
5. Hand-write expected values only when no upstream oracle can represent the browser-only behavior.

Preferred upstream sources:

| Case type                               | Source                                                            |
| --------------------------------------- | ----------------------------------------------------------------- |
| streamed message, reasoning events      | `external/codex/codex-rs/core/tests/suite/items.rs`               |
| unsupported/custom tool behavior        | `external/codex/codex-rs/core/tests/suite/tools.rs`               |
| apply_patch turn behavior               | `external/codex/codex-rs/core/tests/suite/apply_patch_cli.rs`     |
| patch parser/apply golden data          | `external/codex/codex-rs/apply-patch/tests/fixtures/scenarios`    |
| exec output and process semantics       | `external/codex/codex-rs/core/tests/suite/unified_exec.rs`        |
| incomplete stream retry                 | `external/codex/codex-rs/core/tests/suite/stream_no_completed.rs` |
| Responses event builders and invariants | `external/codex/codex-rs/core/tests/common/responses.rs`          |
| native oracle harness shape             | `external/codex/codex-rs/core/tests/common/test_codex.rs`         |

Browser-only cases must be maintained separately:

- WebContainer FS mount/export behavior
- WebContainer process output/input/poll/kill/resize behavior
- `jsh -c` or shell-string fallback behavior
- Turso Browser DB metadata persistence and OPFS workspace snapshot behavior
- wasm-bindgen Promise and `ReadableStream` bindings
- consumer-side `ReadableStream.cancel()` close behavior
- web app restore behavior: persisted wasm `SessionSnapshot`, transcript rows,
  history list, recently-updated ordering, rename persistence, rapid history
  restore serialization, OPFS-backed WebContainer workspace snapshot after
  reload, empty workspace restore, large binary file restore, nested directory
  restore, large text file restore, deleted file restore, corrupt/missing
  snapshot fallback, and a follow-up post-reload `exec_command` reading patched
  files from the restored workspace

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
