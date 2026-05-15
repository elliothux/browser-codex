# `codex-rs/core` Wasm Feasibility Evaluation

Date: 2026-05-14

## Executive Summary

Turning the current `codex-rs/core` crate into a direct `wasm32-unknown-unknown` build is not a realistic short path.

The feasible path is to create a wasm-compatible subset of Codex core: a portable agent kernel that preserves the model loop, protocol handling, tool orchestration, approval flow, and `apply_patch` behavior, while replacing local OS capabilities with browser host adapters.

In short:

| Approach                                                    | Feasibility | Notes                                                                                |
| ----------------------------------------------------------- | ----------: | ------------------------------------------------------------------------------------ |
| Directly compile current `codex-rs/core` to wasm            |         Low | Too many native process, sandbox, filesystem, PTY, and runtime dependencies          |
| Extract a portable wasm core plus browser adapters          | Medium-high | Correct architecture, but requires meaningful refactoring                            |
| Build a browser-only JS/TS coding-agent MVP on WebContainer |        High | Best first milestone                                                                 |
| Full desktop Codex parity in pure browser runtime           |         Low | Native sandbox, arbitrary CLI, stdio MCP, PTY, and OS file access do not map cleanly |

## What Was Inspected

The evaluation looked at the current `openai/codex` repository, especially:

- `codex-rs/core/Cargo.toml`
- `codex-rs/core/src/lib.rs`
- `codex-rs/core/src/exec.rs`
- `codex-rs/core/src/spawn.rs`
- `codex-rs/core/src/tools/runtimes/shell.rs`
- `codex-rs/exec-server/src/lib.rs`

It also used OpenAI Codex documentation on sandboxing and approvals/security, plus WebContainer and almostnode public docs.

## Why Direct Wasm Compilation Is Hard

The current `codex-rs/core` crate assumes a native host process. Important blockers include:

- Native child process execution through `tokio::process` and `std::process`
- PTY and process-group control through `codex-utils-pty`
- Platform sandbox implementations through `codex-sandboxing`, `landlock`, and Windows sandbox modules
- OS-specific process lifecycle behavior such as Unix `pre_exec`, parent-death signal, process-group kill, and TTY detach
- Local filesystem and home-directory assumptions through crates such as `dirs`, `which`, `tempfile`, and local path utilities
- stdio-based MCP server workflows
- Local keyring/login assumptions
- Multithreaded Tokio runtime features and signal handling
- Native network proxy and sandbox enforcement paths

Representative examples:

- `codex-rs/core/Cargo.toml` depends on `codex-exec-server`, `codex-sandboxing`, `codex-utils-pty`, `codex-windows-sandbox`, `tokio` with `process`, `rt-multi-thread`, and `signal`, plus native-supporting crates such as `libc`, `which`, `dirs`, and `tempfile`.
- `codex-rs/core/src/lib.rs` exports platform-sensitive modules such as `exec`, `landlock`, `sandboxing`, and `windows_sandbox` unconditionally.
- `codex-rs/core/src/exec.rs` uses `tokio::process::Child`, OS sandbox selection, process cancellation, stdout/stderr pipe draining, and process-group kill.
- `codex-rs/core/src/spawn.rs` builds native commands with `tokio::process::Command`, `std::process::Stdio`, Unix `arg0`, `pre_exec`, process-group setup, and `libc`.

These are not small compatibility issues. They are core runtime assumptions.

## What Can Be Reused

A browser implementation should reuse concepts and code where the boundaries are already portable or can be made portable:

- Model protocol and event types
- Agent turn/session loop, after isolating host dependencies
- Tool orchestration and tool-call dispatch
- Approval policy and review flow
- Command canonicalization and approval keys
- `apply_patch` logic, because it already works through an abstract file-system interface in several paths
- Browser-backed filesystem adapters for `apply_patch`, exec working directories, snapshots, and future MCP-style tools
- Rollout/history concepts, with storage replaced by IndexedDB/OPFS
- Configuration schema subsets that do not depend on local OS paths or keyring

The strongest reuse point is `codex-rs/exec-server`. It already exposes abstractions such as:

- `ExecutorFileSystem`
- `FileSystemSandboxContext`
- `Environment`
- `EnvironmentManager`
- `ExecBackend`
- `ExecProcess`
- `ExecProcessEvent`

Those abstractions are close to what a browser host runtime needs, although the existing local implementations are native.

## What Must Be Replaced

The browser build needs replacement layers for these capabilities:

| Native Codex capability           | Browser replacement                                               |
| --------------------------------- | ----------------------------------------------------------------- |
| `tokio::process` / `std::process` | `HostExec` trait implemented by WebContainer/almostnode adapter   |
| Local filesystem                  | `HostFileSystem` backed by WebContainer FS, OPFS, or IndexedDB    |
| OS sandbox                        | Browser sandbox plus Codex-level policy checks and approval UI    |
| PTY                               | Streamed process output, optionally rendered in xterm.js          |
| stdio MCP                         | HTTP/SSE/WebSocket MCP or in-browser JS adapters                  |
| Local keyring                     | Backend token broker or short-lived browser session token         |
| Local state DB                    | IndexedDB/OPFS storage adapter                                    |
| Native network proxy              | Browser/backend policy layer; limited enforcement in pure browser |
| Native shell detection            | Fixed browser shell profile, usually Node/npm-oriented            |

## Sandbox Semantics

Desktop Codex uses the sandbox boundary to let the agent act autonomously without unrestricted host access. The official Codex docs describe platform-native enforcement:

- macOS Seatbelt
- Linux `bwrap` and `seccomp`
- Windows sandbox mechanisms

The sandbox applies to spawned commands such as `git`, package managers, test runners, and other CLI tools.

In the browser this cannot be reproduced literally. WebContainer/almostnode run inside the browser origin sandbox and do not expose the user's host filesystem or arbitrary OS process creation. Therefore the Codex sandbox layer should become a policy and approval layer:

- Allow writes only inside mounted workspace paths
- Deny or approve command execution based on policy
- Gate network-like operations behind approval
- Deny dangerous path operations before they reach the browser FS adapter
- Treat the browser origin and WebContainer/almostnode runtime as the outer sandbox

This is acceptable for browser workspaces, but it is not equivalent to desktop Codex sandboxing.

## Proposed Wasm-Compatible Core Boundary

The target should be a new crate or feature-gated subset, for example:

```text
codex-browser-core
  agent loop
  model protocol
  event stream
  tool orchestration
  approval policy
  host filesystem boundary
  apply_patch
  lightweight rollout/history
```

Everything that depends on native host capabilities should be pushed behind traits:

```rust
#[async_trait::async_trait(?Send)]
pub trait HostFileSystem {
    async fn read_file(&self, path: &str) -> anyhow::Result<Vec<u8>>;
    async fn write_file(&self, path: &str, data: &[u8]) -> anyhow::Result<()>;
    async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<DirEntry>>;
    async fn metadata(&self, path: &str) -> anyhow::Result<FileMetadata>;
}

#[async_trait::async_trait(?Send)]
pub trait HostExec {
    async fn spawn(&self, request: ExecRequest) -> anyhow::Result<Box<dyn BrowserProcess>>;
}

#[async_trait::async_trait(?Send)]
pub trait HostStorage {
    async fn get(&self, key: &str) -> anyhow::Result<Option<Vec<u8>>>;
    async fn put(&self, key: &str, value: &[u8]) -> anyhow::Result<()>;
}

#[async_trait::async_trait(?Send)]
pub trait ModelTransport {
    async fn stream(&self, prompt: Prompt, options: ModelRequestOptions)
        -> anyhow::Result<ResponseStream>;
}
```

Use `?Send` because browser wasm commonly runs on a single-threaded event loop.

## Refactor Plan

1. Create a wasm-oriented crate boundary.
   - Start with `codex-browser-core` or `codex-core-wasm`.
   - Import only wasm-safe protocol, tool, and patching crates.

2. Feature-gate native modules.
   - Gate `exec`, `spawn`, `landlock`, `windows_sandbox`, native PTY, stdio MCP, local keyring, native network proxy, and local state DB implementations.

3. Introduce host traits.
   - `HostFileSystem`
   - `HostExec`
   - `HostStorage`
   - `ModelTransport` behind upstream-shaped `ModelClient` / `ModelClientSession`
   - Optional `HostPreviewServer`

4. Replace shell execution path.
   - `ShellRuntime` currently computes approval and sandbox context, then calls native execution.
   - Keep approval/sandbox decision logic where possible.
   - Replace final execution with `HostExec::spawn`.

5. Implement browser filesystem adapter.
   - For WebContainer, bridge to `webcontainer.fs`.
   - For almostnode, bridge to its filesystem API.
   - Optionally mirror persistent state into OPFS/IndexedDB.

6. Implement browser exec adapter.
   - For WebContainer, bridge to `WebContainer.spawn`.
   - For almostnode, bridge to its command/process API.
   - Stream stdout/stderr back into Codex events.
   - Implement cancellation through runtime-specific kill/abort APIs.

7. Reframe sandboxing.
   - Convert OS sandbox requests into preflight policy checks.
   - Keep approvals explicit in UI.
   - Do not claim OS-equivalent isolation.

8. Start with a restricted tool surface.
   - `exec_command`
   - `write_stdin`
   - `apply_patch`
   - optional `view_image`
   - keep direct filesystem helpers outside the default core tool surface; expose
     them later only as browser adapter or MCP-style tools if needed

9. Add remote fallback later.
   - Native Rust/Cargo, Python with native wheels, Docker, and arbitrary binaries should be handled by a remote runner, not pure browser runtime.

## Expected Effort

Rough estimates for an experienced Rust/WebAssembly/frontend team:

- Constrained JS/TS MVP with WebContainer: 4-8 weeks
- Proper wasm core subset with trait boundaries and test coverage: 2-4 months
- Broader Codex behavior parity with persistence, approvals, history, UI, and adapters: 3-6 months
- Full desktop Codex parity in pure browser runtime: not realistic

## Recommendation

Build a `codex-core-lite` or `codex-browser-core` rather than trying to compile the current `codex-rs/core` as-is.

The first supported product surface should be:

- Browser workspace
- JS/TS projects
- npm install/test/dev workflows
- patch-based editing
- streamed command output
- approval UI
- dev server preview

The design should keep WebContainer and almostnode behind adapter traits, so the core remains independent of any single browser runtime.

## References

- OpenAI Codex repository: https://github.com/openai/codex
- Codex sandboxing docs: https://developers.openai.com/codex/concepts/sandboxing
- Codex approvals/security docs: https://developers.openai.com/codex/agent-approvals-security
- WebContainer API docs: https://webcontainers.io/api
- almostnode API docs: https://almostnode.dev/docs/api-reference.html
- almostnode GitHub repository: https://github.com/macaly/almostnode
