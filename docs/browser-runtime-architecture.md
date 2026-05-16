# Browser Runtime Architecture for a Codex-Like Agent

Date: 2026-05-14

## Goal

Build a browser-based coding agent that preserves the useful behavior of Codex while running inside a browser runtime.

The intended architecture is:

```text
Browser UI
  Monaco / diff / approval UI / terminal / preview

codex-browser-core.wasm
  agent loop
  model protocol
  tool orchestration
  approvals
  apply_patch over host filesystem
  event stream

BrowserHostRuntime
  file system adapter
  exec adapter
  storage adapter
  model/network adapter

Execution backend
  WebContainer adapter
  almostnode adapter
  optional remote fallback
```

## Key Architectural Decision

Do not couple the agent core directly to WebContainer or almostnode.

Instead:

- Define a small host capability interface.
- Implement WebContainer and almostnode as adapters.
- Keep Codex behavior in a portable wasm core.
- Use a backend service for model-token security and optional native execution fallback.

This keeps the project from being locked to a single browser container implementation.

## Runtime Comparison

| Runtime           | Strengths                                                                                     | Weaknesses                                                                         | Best use                                       |
| ----------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| WebContainer      | Strong browser Node/npm compatibility, virtual filesystem, process spawn, dev server preview  | Core runtime is not open-source; browser constraints; no arbitrary native binaries | Main JS/TS MVP runtime                         |
| almostnode        | Open/lightweight direction, browser-oriented Node-like runtime, suitable for agent prototypes | Experimental; Node/npm compatibility may be incomplete                             | Secondary adapter/prototype runtime            |
| Pyodide           | Strong Python-in-browser story                                                                | Not a general Node/npm coding sandbox                                              | Python notebooks/tools, not main Codex runtime |
| v86/WebVM/CheerpX | More VM-like isolation                                                                        | Heavier, startup/perf/UX tradeoffs, licensing varies                               | Specialized Linux-like demos, not first MVP    |
| Remote container  | Full native capability and strong sandboxing possible                                         | Requires server infra and security ops                                             | Fallback for native projects                   |

## MVP Scope

The first version should support:

- JS/TS projects
- `npm install`
- `npm test`
- `npm run dev`
- Vite/Next-style preview server
- file read/write/list
- patch-based edits
- command execution with streamed output
- approval UI for shell and network-like actions
- persisted workspace state in browser storage

The first version should not support:

- Arbitrary Rust/Cargo/native builds in browser
- Docker
- stdio MCP servers
- full PTY semantics
- desktop-level sandbox equivalence
- host filesystem access outside the browser workspace

## Component Design

## Current Implementation

The browser runtime adapter is a standalone workspace package:

```text
packages/browser-runtime
  BrowserCodexRuntime
  WebContainerHostFileSystem
  WebContainerHostExec
  TursoConversationStore
```

The web app imports `@browser-codex/browser-runtime` and owns only UI state:
provider settings, transcript rendering, history selection, and approval
modals. WebContainer, Turso SQLite, workspace snapshotting, and host callbacks
stay inside the adapter package so the app does not couple to runtime details.

Current host boundaries:

- `HostFileSystem` maps `/workspace/...` to WebContainer `workspace/...`.
- `HostExec` runs commands through WebContainer `spawn("jsh", ["-c", cmd])`.
- `HostApprovals` calls the web UI approval handler and returns the decision
  to the wasm core.
- `HostStorage` is implemented with Turso browser SQLite and persists the wasm
  `SessionSnapshot`, transcript messages, and trace metadata only.
- Workspace snapshots are exported from WebContainer as binary `.wcsnap` bytes
  and stored under OPFS at
  `/browser-codex/workspaces/<session-id>/latest.wcsnap`. OPFS is the only
  workspace snapshot source of truth; SQLite does not store workspace blobs,
  file manifests, or snapshot references.
- `BrowserCodexRuntime.loadSession` serializes workspace restores because
  upstream rollout/session reconstruction in
  `external/codex/codex-rs/core/src/rollout.rs` does not remount one mutable
  WebContainer workspace while history selection is changing.
- Model HTTP transport is still the wasm live provider adapter, but
  `packages/browser-runtime` installs the original browser `fetch` before
  WebContainer boots so WebContainer fetch interception does not affect model
  requests.

The default web e2e now verifies the full browser loop through separate cases:
real wasm turn execution, WebContainer command execution, `apply_patch` file
mutation, approval UI, Turso-backed session restore, OPFS workspace restore,
nested directory and large text snapshot restore, deleted file restore, history
list selection across multiple sessions, corrupt/missing snapshot fallback, and
follow-up turns after reload using the restored workspace. Each web e2e case
starts from at least one tool call.

### `codex-browser-core.wasm`

Responsible for:

- Receiving user messages
- Building model requests
- Processing model event streams
- Dispatching tool calls
- Maintaining turn state
- Asking for approvals
- Applying patches
- Emitting UI events

Not responsible for:

- Directly spawning native processes
- Directly reading browser storage APIs
- Holding long-lived OpenAI API keys
- Enforcing OS-level sandboxing

### `BrowserHostRuntime`

Responsible for adapting browser capabilities to the wasm core:

```text
HostFileSystem
  read_file
  write_file
  read_dir
  metadata
  remove
  mkdir

HostExec
  spawn
  write_stdin
  stream_stdout
  stream_stderr
  terminate

HostStorage
  save session
  load session
  save workspace metadata

ModelClientSession / ModelTransport
  send model request
  stream model response
```

### WebContainer Adapter

Maps host calls to WebContainer APIs:

```text
HostFileSystem -> webcontainer.fs
HostExec       -> webcontainer.spawn
Preview        -> WebContainer server/port events
```

Expected command path:

```text
Codex tool call
  -> approval/policy check
  -> BrowserHostRuntime.spawn()
  -> WebContainer.spawn()
  -> stdout/stderr streams
  -> Codex event stream
  -> UI terminal
```

### almostnode Adapter

Maps the same host interface to almostnode APIs.

The almostnode adapter should initially be treated as experimental:

- useful for constrained package execution
- useful for verifying the abstraction boundary
- not the main compatibility target until tested against real npm projects

### Model Proxy

The browser should not hold a long-lived OpenAI API key.

Use a backend proxy to:

- authenticate the user
- mint short-lived browser session tokens
- forward model requests
- enforce project/account limits
- optionally redact secrets
- optionally broker web search or remote execution

## Sandbox and Security Model

Browser runtime sandboxing has a different meaning than desktop Codex sandboxing.

Desktop Codex can use platform-native mechanisms such as macOS Seatbelt, Linux `bwrap/seccomp`, and Windows sandboxing. Browser Codex cannot reproduce those inside wasm.

The browser design should use layered controls:

1. Browser origin sandbox
2. WebContainer/almostnode runtime isolation
3. Workspace-scoped virtual filesystem
4. Codex policy checks before file writes and command execution
5. User approval for risky commands and network-like actions
6. Backend proxy for API keys and account-level enforcement

Important limitation:

> Network and process restrictions in a browser container are not equivalent to Linux namespace/seccomp sandboxing. The product should describe this as browser workspace isolation, not OS sandbox parity.

## Tool Surface

Initial tool list:

- `exec_command`
- `write_stdin`
- `apply_patch`
- `view_image` if the UI needs it

Direct file helpers should stay out of the default core tool surface. Browser
filesystem access remains a host boundary for `apply_patch`, exec working
directories, snapshots, and future MCP/adapter tools.

Later tool list:

- MCP-style filesystem tools if needed by the product surface
- package dependency inspection
- dev server preview
- browser screenshot/test tool
- HTTP/WebSocket MCP tools
- remote execution tool

Avoid in the first version:

- stdio MCP
- arbitrary plugin execution
- native binary installation
- commands requiring real PTY interaction

## Data Flow

```text
User prompt
  -> Browser UI
  -> codex-browser-core.wasm
  -> ModelClientSession
  -> ModelTransport browser fetch adapter
  -> OpenAI-compatible Responses API
  -> streamed model events
  -> codex-browser-core.wasm
  -> ReadableStream turn events to Browser UI
  -> tool call
  -> approval UI if needed
  -> HostFileSystem or HostExec
  -> WebContainer/almostnode
  -> streamed result
  -> model continuation
  -> final answer
```

## Implementation Phases

### Phase 1: Runtime Spike

Build a minimal browser app:

- load WebContainer
- mount a small JS/TS project
- run `npm install`
- run `npm test`
- run dev server preview
- stream command output to UI

Goal: validate runtime capabilities before porting Codex logic.

### Phase 2: Host Interface

Define TypeScript-side host interface and wasm bridge:

- `HostFileSystem`
- `HostExec`
- `HostStorage`
- `ModelTransport` behind upstream-shaped `ModelClient` / `ModelClientSession`

Goal: prove that Codex-like tools can run without direct runtime coupling.

### Phase 3: Core Subset

Create `codex-browser-core`:

- minimal turn loop
- model event handling
- tool dispatch
- approvals
- host filesystem boundary
- apply_patch

Goal: run a complete browser coding-agent loop on a simple repo.

### Phase 4: Product MVP

Add:

- Monaco editor
- diff view
- approval modal
- terminal output
- preview iframe
- workspace persistence
- backend model proxy

Goal: usable JS/TS browser coding agent.

### Phase 5: Broader Compatibility

Add:

- almostnode adapter
- remote runner fallback
- HTTP/WebSocket MCP
- browser test automation
- larger project handling

Goal: support more workflows without weakening the core boundary.

## Main Risks

| Risk                                                    | Severity | Mitigation                                                       |
| ------------------------------------------------------- | -------: | ---------------------------------------------------------------- |
| Direct wasm port becomes a long native-dependency fight |     High | Start with a new wasm subset and trait boundary                  |
| WebContainer proprietary/runtime dependency             |   Medium | Keep adapter boundary; maintain almostnode/remote alternatives   |
| Browser network controls are weaker than OS sandboxing  |     High | Be explicit; enforce policy before actions; use backend controls |
| Large npm projects perform poorly in browser            |   Medium | Scope MVP; add remote fallback                                   |
| API key exposure                                        |     High | Use backend model proxy/token broker                             |
| stdio MCP incompatibility                               |   Medium | Start with HTTP/WebSocket MCP only                               |
| Native toolchains unsupported                           |     High | Remote fallback for Rust/Cargo/native projects                   |

## Recommended First Milestone

Build a JS/TS-only browser coding agent that can:

1. Open a template project in WebContainer.
2. Ask the model to make a code change.
3. Apply a patch to the virtual filesystem.
4. Run tests with streamed output.
5. Show a diff and final answer.
6. Persist the workspace locally.

This milestone proves the product loop without requiring full desktop Codex parity.

## Final Recommendation

Implement a wasm-compatible `codex-core-lite` and treat WebContainer/almostnode as replaceable host runtimes.

Use WebContainer as the primary MVP backend because it has the strongest JS/TS project support. Keep almostnode as an experimental adapter to validate openness and avoid hard runtime lock-in.

Do not describe the product as running full Codex desktop core in the browser. Describe it as a browser-native Codex-like runtime with a portable agent kernel and browser execution adapters.
