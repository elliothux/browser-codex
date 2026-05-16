# Wasm Codex Agent Core Plan

## 1. 目标

继续把 `codex-browser-core` 打磨成可在浏览器里运行、并尽量贴近上游 OpenAI Codex 行为的 wasm agent core。

核心边界保持不变：

- core 负责 session/turn 状态机、Responses event stream 处理、prompt/history、tool routing、tool output serialization、approval decision flow。
- host 能力通过 trait 注入：model transport、filesystem、exec、approval、optional storage。
- 浏览器 runtime adapter 放在 `packages/browser-runtime`，web app 只消费 runtime package。
- conformance 以 scripted upstream-shaped Responses events 和 upstream oracle 为准；live provider smoke 只验证 provider 兼容性。

## 2. 当前基线

这部分不是待办，只记录后续工作的基准。

- `crates/codex-browser-core` 已存在，并通过 `cargo test -p codex-browser-core` 与 `cargo check -p codex-browser-core --target wasm32-unknown-unknown`。
- core 已覆盖 tool-backed streamed assistant delta、tool-backed reasoning delta、tool follow-up、history normalization、unsupported custom/function tool、client `tool_search`、invalid tool args、`apply_patch` add/update/delete/move/multiple-chunk/end-of-file marker、`exec_command` success/denied/truncation/invalid UTF-8/sandbox rejection、`write_stdin` poll/write、approval denied、early stream close retry、`parallel_tool_calls` model capability。`no_tool` fixture 不进入默认 native/e2e gate。
- `apply_patch`、tool schema、exec output shape、request invariants 都有 Rust 或 Playwright 覆盖。
- `tests/oracle/upstreamOracle.ts` 已做 canonical trace comparison，并通过 upstream-derived full tool specs、native upstream core `apply_patch` trace、scripted host-boundary exec/approval trace 校验 patch 与 host adapter 行为。
- `tests/oracle/native-core-runner` 已接入上游 `core/tests/common/test_codex.rs` 与 `responses.rs`，并用带 tool 的 `streamed_assistant_text_delta`、`reasoning_delta`、`early_stream_close_retry`、`unsupported_custom_tool`、`unsupported_function_tool`、`exec_success`、`exec_native_truncation`、`exec_denied`、`multiple_tool_calls`、`early_stream_close_tool_retry`、`parallel_tool_calls_disabled`、`apply_patch_add_update_delete`、`apply_patch_move`、`apply_patch_end_of_file`、`apply_patch_multiple_chunks`、`invalid_apply_patch` 产出 native upstream canonical trace；runner 会拒绝没有 supported tool call 的 case。
- `tests/wasm/core.spec.ts` 已在真实 browser wasm package 中跑 runtime-neutral cases。
- `tests/wasm/web-app.spec.ts` 已按行为拆分 web e2e case，并覆盖 web app 通过 `packages/browser-runtime` 使用真实 WebContainer FS/exec、Turso browser SQLite、wasm-bindgen host callbacks、UI approval、reload restore、empty workspace snapshot restore、large binary snapshot restore、nested dir/大文件/删除后恢复、multi-session history、recently-updated history ordering、history rename persistence、rapid history restore serialization，以及 corrupt/missing OPFS snapshot fallback。每个 web e2e case 都从至少一个真实 tool 调用建立状态。
- wasm package 已导出 `run_host_turn_stream_json`，以 `ReadableStream` 输出实时 turn events 和 final output；stream cancel 映射到 core cancellation token。
- browser runtime 已把 workspace snapshot 从 SQLite 移到 OPFS binary `.wcsnap`，SQLite 只保存 session/message/trace/wasm session metadata。
- `tests/cases/write_stdin_poll.json` 覆盖 `write_stdin` poll 输出和 tool/output pairing。
- `tests/cases/write_stdin_write.json`、`exec_native_truncation.json`、`exec_truncation.json`、`exec_tty_shell_payload.json`、`exec_unsupported_sandbox_permissions.json`、`tool_search_client.json`、`unsupported_function_tool.json`、`invalid_exec_arguments.json`、`apply_patch_move.json`、`apply_patch_end_of_file.json`、`apply_patch_multiple_chunks.json` 扩展了 tool-backed conformance。
- `scripts/check-upstream-sync.ts` 校验 copied apply_patch grammar、unified exec/truncation 常量、copied truncation helper body 与 TS oracle truncation golden 是否和 `external/codex` 漂移。

## 3. 约束

实现 Codex 行为时继续按这个优先级：

1. `import external`
2. `copy/paste raw code`
3. `mock/inject`
4. `edit codex source code`
5. `implement by ourself`

具体规则：

- 不修改 `external/codex`，除非一个很小的 upstream-compatible feature gate 能显著提高复用。
- 如果上游 crate 的 wasm dependency surface 仍拉入 native-only 依赖，继续复制最小 pure helper/type，并保留 upstream 命名和 source-reference comments。
- mock 只允许在 host boundary：model transport、filesystem、exec、approvals、storage。
- 不 mock core agent 行为：turn loop、prompt/history、Responses event handling、tool routing、tool output pairing、approval policy decision。
- browser/provider 兼容 fallback 不得混入 conformance oracle。

## 4. 已实现工作流与维护边界

### 4.1 Upstream Reuse Hardening

目标：减少本地 copied/custom surface，让未来同步上游更容易。

- 定期重新验证 `codex-protocol`、`codex-tools`、`codex-apply-patch` 是否能通过 narrower feature gate 在 wasm core 中直接依赖。
- 为当前 copied wire shapes、tool schema helper、apply_patch parser/apply logic 建立 upstream sync checklist，记录对应 upstream path/function。
- 增加一个轻量 diff/check 脚本，比较本地 copied grammar/schema/重要常量和 `external/codex` 的对应源文件。
- 如果 upstream crate 可以被拆出 wasm-safe feature，优先切回 direct dependency，再删除本地 copy。

验收：

- 任一 copied block 都能追溯到 upstream path。
- upstream 更新后，schema/grammar drift 能通过测试或脚本暴露。

### 4.2 Full Native Oracle Runner

目标：把 oracle 从“TS 翻译 + upstream tool spec helper”推进到更完整的 upstream Codex native trace oracle。

- `tests/oracle/native-core-runner` 基于 `external/codex/codex-rs/core/tests/common/test_codex.rs` 和 `responses.rs`，已产出可和 wasm trace 比较的 canonical JSON：model requests、agent events、tool outputs、final filesystem snapshot。
- streamed text/reasoning delta、incomplete-stream retry、`parallel_tool_calls` model capability、unsupported custom/function tool、`exec_command` 成功/确定性 truncation/approval denied、multiple tool calls、early stream close after completed tool call 与 freeform `apply_patch` 成功/错误路径已走真实 upstream native core。browser host-boundary trace 已覆盖 approval request/decision、exec request payload 与 WebContainer process lifecycle adapter cases。
- 默认覆盖带 tool 的 runtime-neutral core cases；`tests/oracle/native-core-runner` 会拒绝没有 supported tool call 的 case，默认测试不跑 `no_tool`。
- 保留 browser-only adapter cases 的手写 expected path，不强行映射到 upstream。

验收：

- 已有 streamed assistant text、reasoning summary delta、early stream close retry、unsupported custom/function tool、`exec_command` success/deterministic truncation/denied approval、multiple tool calls、early stream close after completed tool call、`parallel_tool_calls` disabled、freeform `apply_patch` add/update/delete/move/multiple-chunk/end-of-file/error 由 native upstream core oracle 产出 expected trace。
- `tests/wasm/core.spec.ts` 能选择 native oracle 或当前 oracle，并输出清晰 diff。

### 4.3 Conformance Case Expansion

目标：把 upstream 行为覆盖从 MVP 扩展到更细的 turn/tool/history 边界。

当前状态：

- 已新增 tool-backed cases 覆盖 streamed text、reasoning delta、unsupported custom/function、client `tool_search`、invalid `exec_command` arguments、unsupported sandbox escalation、`apply_patch` add/update/delete/move/multiple-chunk/end-of-file/error、`write_stdin` poll/write、exec truncation、invalid UTF-8 lossy output、shell/login/tty host payload、early stream retry、early stream close after completed tool call、parallel tool call disablement。
- 所有新增 case 都在 `tests/cases/*.json` 保留 upstream 来源字段，并进入 Playwright canonical trace comparison；默认 e2e gate 仍不运行 `no_tool`。
- Coverage sources include `items.rs`, `tools.rs`, `apply_patch_cli.rs`, `apply-patch/tests/fixtures/scenarios`, `unified_exec.rs`, and `stream_no_completed.rs`; browser-only WebContainer/Turso/OPFS cases remain separated from core conformance.

验收：

- 新增 case 都放在 `tests/cases/*.json`，并注明 upstream 来源。
- request invariant validation 覆盖所有 tool output 类型。
- browser-only adapter cases 与 core conformance cases 明确分开。

### 4.4 Exec And Process Parity

目标：让 browser `HostExec` 更接近 upstream unified exec 的语义，同时明确 WebContainer 的不可避免差异。

当前状态：

- Rust tests 覆盖 `write_stdin` input/poll、`exec_command` shell/login 传递、approval denied、统一 exec output/truncation helper。
- Playwright conformance 覆盖 `write_stdin` poll/write、`exec_command` truncation、invalid UTF-8 lossy decoding、`shell`/`login`/`tty`/`yield_time_ms`/`max_output_tokens` host payload，以及 unsupported native sandbox/escalation model-visible error。
- Playwright browser adapter 覆盖真实 WebContainer `HostExec` lifecycle：long-running process start、stdin write、poll、TTY resize、kill，以及 process table cleanup 后的 not-running error。
- copied truncation helper 已集中在 `crates/codex-browser-core/src/output_truncation.rs`，按 `external/codex/codex-rs/utils/output-truncation/src/lib.rs` 与 `utils/string/src/truncate.rs` 保持 head/tail middle truncation 语义；`history.rs` 与 `exec.rs` 共用该实现。`scripts/check-upstream-sync.ts` 校验 `DEFAULT_MAX_OUTPUT_TOKENS`、`APPROX_BYTES_PER_TOKEN`、copied helper body 与 TS oracle truncation golden 是否和上游漂移，`exec_native_truncation.json` 通过 native upstream core 验证确定性 model-visible truncation，`exec_truncation.json` 保留 browser host-boundary scripted 覆盖。
- `terminal_size` 当前不是 upstream tool schema 的模型可见参数；WebContainer adapter 在 `tty=true` 时使用 host-side 默认尺寸或 host request 中已有尺寸，暂不扩展模型 schema。

- WebContainer stdout/stderr merged stream divergence 记录在 `docs/wasm-core-harness.md` 与 browser adapter tests 中；model-visible output 文案由 conformance case 固定。

验收：

- `exec_command` 与 `write_stdin` 的每个 host request 字段都有测试。
- long-running process 生命周期不会泄漏 process table entry。

### 4.5 Event Streaming And Cancellation API

目标：把 wasm public API 从“turn 完成后返回 JSON”扩展到可供 UI 实时消费的稳定 stream API。

当前状态：

- `Session::run_turn_with_event_sink` 复用同一条 turn loop，并在事件产生时同步发给 sink。
- `CancellationToken` 可在采样前和采样事件之间取消 turn，取消事件会进入 event stream。
- wasm-bindgen export `run_host_turn_stream_json` 返回 `ReadableStream`，chunk 形状为 `{ type: "event" | "done" | "cancelled" }`。
- `BrowserCodexRuntime.runTurnStream` 消费 wasm stream；web app 在运行中消费 assistant delta。
- Playwright 覆盖 `ReadableStream` export、consumer-side stream cancel close 行为，以及 approval host callback rejection 转为 model-visible denied tool output 且不调用 HostExec；Rust 覆盖 event sink 与 cancellation token。

- streaming API 与现有 trace collection 共存：UI 消费实时事件，tests 仍能得到完整 canonical trace。
- mid-turn provider failure、consumer-side stream cancel 与 approval host callback rejection 已有 Playwright 覆盖；core-observed cancellation 由 Rust tests 覆盖。

验收：

- web app 不需要等整个 turn 结束才能显示 assistant/tool deltas。
- cancel 后 history、running process、trace 都处于可恢复状态。

### 4.6 Provider Compatibility Isolation

目标：支持 DashScope 等 OpenAI-compatible provider 的 smoke，但不污染 upstream conformance。

当前状态：

- `LiveResponsesModel` 是独立 `ModelTransport` adapter；conformance tests 继续使用 scripted `ModelTransport` 和 upstream oracle，不经过 live provider adapter。
- Playwright live-adapter smoke 使用本地 deterministic Responses-compatible provider，验证正常 live turn 发送非空 `tools` 和 `tool_choice: "auto"`，覆盖 provider error body normalization，并覆盖 `apply_patch` function-tool compatibility mode。
- web app e2e 使用同一 browser fetch/provider path 覆盖 function tool follow-up、custom `apply_patch`、approval UI 与 follow-up request。
- `ProviderConfig.toolCompatibility` 默认为 `upstream`；只有显式选择 `applyPatchFunction` 时，`LiveResponsesModel` 才会把 request 里的 upstream custom/freeform `apply_patch` tool 转成 provider-visible function tool，并把 provider response 里的 `function_call apply_patch` 转回 core 内部的 `custom_tool_call`。默认 conformance path 与默认 live path 仍使用 upstream-style custom tool。
- provider-specific request/response quirks 收敛在 `LiveResponsesModel` adapter；`docs/wasm-core-harness.md` 记录 DashScope `qwen3.5-flash` 支持矩阵与实际 smoke 结果。

- `tools: [] + tool_choice: "auto"` 只保留为手动 provider edge-case guard，不进入默认 conformance/e2e gate。

验收：

- live smoke 失败不会被误判为 core conformance failure。
- compatibility fallback 有独立配置和测试，不改变默认 tool specs。

### 4.7 Runtime Persistence Hardening

目标：把 browser runtime 的持久化和恢复路径从 e2e happy path 扩展到可维护状态。

当前状态：

- `TursoConversationStore` schema v2 不再写入 `workspace_snapshot_json`。
- `OpfsWorkspaceSnapshotStore` 使用 `/browser-codex/workspaces/<session-id>/latest.wcsnap` 保存 WebContainer binary snapshot。
- `exportWorkspaceSnapshot` 导出带顶层 `workspace` 的 binary snapshot，并排除依赖、构建产物、缓存、覆盖率和日志目录。
- `loadSession` 从 OPFS 恢复；缺失或损坏时回退到默认 workspace，并把恢复错误返回给 UI。
- web app e2e 已按不同 case 拆开，覆盖 OPFS snapshot 存在、reload restore、后续 turn 读取 restored file、empty workspace snapshot restore、large binary snapshot restore、nested dirs、大文件、删除后恢复、multi-session history list、recently-updated history ordering、history rename persistence、rapid history restore serialization，以及 corrupt/missing snapshot fallback UI。每个 case 都包含至少一个 tool 调用，不使用 `no_tool`。
- `BrowserCodexRuntime.loadSession` 串行化 WebContainer workspace restore，防止快速 history 切换时 OPFS snapshot 读取和 workspace mount 交错；web e2e 使用连续 history restore 后的 `exec_command` 验证最终 workspace 未串 session。

- 明确持久化边界：Turso browser SQLite 只保存 session/message/trace/wasm session metadata，不保存 workspace 文件内容，不新增 SQLite file manifest 或 snapshot ref 表。
- 使用 OPFS 作为 workspace snapshot 的唯一 source of truth；目录结构本身就是文件索引，通过 OPFS `readDir`/`entries()` 派生状态。
- WebContainer FS 只作为运行时内存文件系统；每轮或显式保存时用 `webcontainer.export("workspace", { format: "binary", excludes })` 写入 OPFS deterministic path，例如 `/browser-codex/workspaces/<session-id>/latest.wcsnap`。
- 恢复 session 时按约定路径从 OPFS 读取 `latest.wcsnap` 并 `webcontainer.mount(bytes)`；缺失或损坏时回退到默认 workspace，并返回 UI 可展示的恢复错误。
- 默认排除 `node_modules`、`.git`、`dist`、`build`、`.next`、`.vite`、`.turbo`、`coverage`、日志和缓存目录，避免把依赖和构建产物写入 snapshot。
- 暂不支持把 `showDirectoryPicker()` 返回的用户目录直接作为 workspace mount；后续如支持本地目录，只做显式 import/export/sync-back，不改变 WebContainer 运行时 FS 边界。
- 为 Turso storage schema 增加 migration/versioning strategy，但 migration 不负责 workspace blob 或文件索引。
- 空 workspace、large binary file、大文件文本、nested dirs、删除后恢复、snapshot corruption、OPFS 文件缺失、基础 multi-session history list、recently-updated ordering、rename persistence、rapid history restore serialization 已进入拆分后的 web e2e。
- 确保 runtime package 继续拥有 WebContainer FS/exec、Turso browser SQLite、OPFS workspace snapshot、wasm host callback wiring；web app 不直接接这些底层 adapter。

验收：

- reload restore 不只覆盖单 session happy path；当前已覆盖 empty workspace、large binary file、nested dirs、大文件文本、删除后恢复、corrupt/missing snapshot fallback、基础 multi-session history list、最近更新排序、重命名持久化和快速 history 恢复串行化。
- SQLite 中不再存 `workspace_snapshot_json` 或其他 workspace 文件索引；workspace 恢复只依赖 OPFS deterministic path。
- storage/workspace failure 能返回 UI 可展示的错误，不破坏 core session state。

### 4.8 Documentation And Maintenance

目标：让后续实现者能按同一边界继续推进。

- `docs/wasm-core-harness.md` 与本文件同步更新测试策略、oracle 实现和 case policy。
- `AGENTS.md` 只保留稳定项目规则；具体阶段性计划放在 `PLAN.md`。
- 给 copied upstream code、custom divergence、provider fallback 保持 source-reference comments。
- 在 README 中区分当前可运行命令、研究文档、未来计划。

验收：

- 修改 tests 或 core 边界时，同步更新 `PLAN.md`、`docs/wasm-core-harness.md`，必要时更新 `AGENTS.md`。
- 新 contributor 能通过 README 找到默认验证命令。

## 5. 默认验证命令

每次 core/tests/runtime 改动后至少运行：

```bash
cargo test -p codex-browser-core
cargo check -p codex-browser-core --target wasm32-unknown-unknown
bun run typecheck
scripts/test-integration.sh
```

只改 Rust core 时可先跑：

```bash
scripts/test-unit.sh
```

只改 browser runtime 或 web app 时仍要跑 `scripts/test-integration.sh`，因为 wasm host callbacks、WebContainer、Turso 和 UI restore 是同一条集成链路。

## 6. 本轮完成状态

1. Full native upstream oracle runner 已接入 tool-backed core cases，并拒绝默认 no-tool oracle case。
2. Unified exec conformance 已覆盖 request payload、write_stdin、truncation、invalid UTF-8、sandbox rejection；真实 WebContainer adapter 覆盖 long-running process lifecycle、stdin、poll、resize、kill 和 cleanup。
3. `apply_patch` fixtures 已覆盖 add/update/delete、move、multiple chunks、end-of-file marker 和 invalid patch。
4. Provider fallback 已隔离在 live adapter，`docs/wasm-core-harness.md` 记录 DashScope 支持矩阵与 deterministic smoke 覆盖。
5. Web e2e 已按 case 拆分，覆盖 OPFS restore edge cases、history ordering、rename persistence、rapid history restore serialization 和 corrupt/missing snapshot fallback；默认 suite 不运行 `no_tool`。
