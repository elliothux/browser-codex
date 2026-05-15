---
name: codex-source-review
description: Review implementations that aim to stay compatible with upstream OpenAI Codex source. Use when Codex is asked to review or audit code, PRs, diffs, plans, or architecture for browser/wasm Codex agent work, especially to check reuse of external/codex, copy/paste fidelity, mock/injection boundaries, destructive upstream source edits, custom implementations, and source-reference comments pointing to upstream Codex files.
---

# Codex Source Review

## Objective

Review only for one goal: maximize compatibility with upstream Codex so future upstream updates are easy to adopt.

## Reuse Priority

Judge every implementation choice against this order:

1. `import external`
2. `copy/paste raw code`
3. `mock/inject`
4. `edit codex source code`
5. `implement by ourself`

Treat a lower-priority choice as a finding unless the code shows a concrete reason the higher-priority choices cannot work.

## Review Workflow

1. Establish the upstream baseline before judging the implementation.
   - Locate `external/codex` or the configured upstream Codex checkout.
   - Record the submodule commit or upstream revision if available.
   - Inspect the relevant upstream files with `rg`, `git diff`, and targeted file reads.

2. Map changed code to upstream behavior.
   - Identify the feature under review: turn loop, model request/Responses events, tools, `apply_patch`, exec, approvals, history, config, or storage.
   - Find the closest upstream files and functions.
   - Classify each local implementation by the reuse priority above.

3. Check for avoidable divergence.
   - Prefer path dependency/import of upstream crates or modules when wasm-compatible.
   - Prefer raw copied upstream code when imports pull native-only dependencies.
   - Allow mocks/injection only at host boundaries such as model transport, filesystem, exec, storage, approvals, browser APIs, and WebContainer.
   - Treat custom reimplementation of agent logic, tool routing, event handling, prompt/history construction, or patch semantics as high risk.

4. Check modifications to upstream Codex.
   - Treat edits under `external/codex` as destructive unless they are isolated, minimal, and clearly necessary.
   - Prefer local adapters, feature gates, or upstreamable patches over changing vendored source.
   - Verify any upstream edit preserves 100% behavior for native Codex paths unless the user explicitly accepts a fork.

5. Check source-reference comments.
   - Require a nearby code comment for any custom implementation, copied upstream block, or destructive upstream-source modification.
   - The comment must name the upstream file and function/module being followed.
   - The comment must explain the allowed divergence, if any.
   - Do not require these comments for ordinary imports that directly use upstream code.

Good comment pattern:

```rust
// Mirrors upstream Codex: external/codex/codex-rs/core/src/session/turn.rs::run_turn.
// Divergence: model transport is injected through HostModelClient because wasm cannot use the native client.
```

Good copy/paste comment pattern:

```rust
// Copied from upstream Codex: external/codex/codex-rs/core/src/tools/router.rs.
// Keep semantics aligned; only Send/Sync bounds are relaxed for wasm host callbacks.
```

## Findings To Prioritize

Report these as review findings when present:

- A lower-priority reuse strategy is used without evidence that higher-priority strategies fail.
- Custom code implements behavior already available from upstream Codex.
- Copied upstream code has semantic edits that are not documented or tested against upstream.
- Mocks replace core agent behavior instead of host capabilities.
- `external/codex` is modified without a narrow, necessary, upstream-compatible reason.
- Custom or modified code lacks an upstream source-reference comment.
- Tests validate only local behavior and do not compare against upstream Codex fixtures, traces, or oracle behavior.
- Provider compatibility code is mixed into conformance logic instead of isolated behind an adapter.

## Allowed Divergence

Accept divergence only when it is necessary for the browser/wasm runtime and isolated behind a boundary:

- WebContainer filesystem and process execution adapters.
- Browser storage adapters such as Turso or in-memory storage.
- Browser `fetch`, stream, Promise, and `wasm-bindgen` bindings.
- Provider adapters for non-OpenAI Responses-compatible models.
- Permission UI or approval transport, as long as core approval semantics match upstream.

Even when allowed, require a reference to the upstream Codex behavior being preserved.

## Review Output

Use a code-review format. Findings come first, ordered by severity.

For each finding include:

- Severity: `P0`, `P1`, `P2`, or `P3`.
- Local file and line.
- Upstream reference file/function.
- Which reuse-priority rule was violated.
- Why the divergence risks future upstream compatibility.
- Concrete fix: import, copy raw code, inject host boundary, remove upstream edit, add comment, or add upstream oracle test.

After findings, include:

- Open questions or assumptions.
- A short compatibility summary: import/copy/mock/edit/custom counts if useful.
- Test gaps, especially missing upstream oracle, fixture, or trace comparisons.

If there are no findings, say so directly and still mention any residual test gaps.
