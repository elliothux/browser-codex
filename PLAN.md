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
- core 已覆盖 no-tool turn、streamed assistant delta、reasoning delta、tool follow-up、history normalization、unsupported tool、`apply_patch`、`exec_command`、`write_stdin`、approval denied、early stream close retry、`parallel_tool_calls` model capability。
- `apply_patch`、tool schema、exec output shape、request invariants 都有 Rust 或 Playwright 覆盖。
- `harness/oracle/upstreamOracle.ts` 已做 canonical trace comparison，并通过 upstream-derived full tool specs 与 upstream `apply-patch` binary 校验 patch 行为。
- `tests/wasm/core.spec.ts` 已在真实 browser wasm package 中跑 runtime-neutral cases。
- `tests/wasm/web-app.spec.ts` 已覆盖 web app 通过 `packages/browser-runtime` 使用真实 WebContainer FS/exec、Turso browser SQLite、wasm-bindgen host callbacks、UI approval、reload restore。

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

## 4. 剩余工作流

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

目标：把 oracle 从“TS 翻译 + apply_patch native binary + upstream tool spec helper”推进到更完整的 upstream Codex native trace oracle。

- 基于 `external/codex/codex-rs/core/tests/common/test_codex.rs` 和 `responses.rs` 做一个 native oracle runner spike。
- native oracle 需要输出与 wasm trace 可比较的 canonical JSON：model requests、agent events、tool outputs、approval decisions、exec requests/results、final filesystem snapshot。
- 先覆盖 runtime-neutral core cases，再逐步替换 TS 中手写/翻译的 expected behavior。
- 保留 browser-only adapter cases 的手写 expected path，不强行映射到 upstream。

验收：

- 至少 no-tool、streamed text、reasoning、unsupported custom tool、apply_patch、exec denied、early stream close retry 由 native upstream oracle 产出 expected trace。
- `tests/wasm/core.spec.ts` 能选择 native oracle 或当前 oracle，并输出清晰 diff。

### 4.3 Conformance Case Expansion

目标：把 upstream 行为覆盖从 MVP 扩展到更细的 turn/tool/history 边界。

- 从 `external/codex/codex-rs/core/tests/suite/items.rs` 增加更多 item/event stream cases。
- 从 `tools.rs` 增加 unsupported function/custom/tool_search、invalid arguments、tool output pairing cases。
- 从 `apply_patch_cli.rs` 和 `apply-patch/tests/fixtures/scenarios` 增加更多 add/update/delete/move/error fixtures。
- 从 `unified_exec.rs` 增加 long-running process、poll、stdin、kill、resize、truncation cases。
- 从 `stream_no_completed.rs` 增加多次 retry、retry exhausted、partial item + final recovery cases。
- 扩展 canonical trace：approval requests/decisions、exec request payload、usage fields、selected event payloads。

验收：

- 新增 case 都放在 `harness/cases/*.json`，并注明 upstream 来源。
- request invariant validation 覆盖所有 tool output 类型。
- browser-only adapter cases 与 core conformance cases 明确分开。

### 4.4 Exec And Process Parity

目标：让 browser `HostExec` 更接近 upstream unified exec 的语义，同时明确 WebContainer 的不可避免差异。

- 增加 `write_stdin`、poll、kill、resize 的 Rust unit tests 和 Playwright browser adapter tests。
- 明确验证 `shell`、`login`、`tty`、`terminal_size`、`yield_time_ms`、`max_output_tokens` 的 host boundary payload。
- 校准 output truncation 与 upstream head/tail 行为，包含 large output 和 invalid UTF-8 风险。
- 记录 WebContainer stdout/stderr merged stream 的 divergence，并确保 model-visible output 文案稳定。
- 对 unsupported native sandbox/escalation 参数保持 model-visible error，并加 conformance case。

验收：

- `exec_command` 与 `write_stdin` 的每个 host request 字段都有测试。
- long-running process 生命周期不会泄漏 process table entry。

### 4.5 Event Streaming And Cancellation API

目标：把 wasm public API 从“turn 完成后返回 JSON”扩展到可供 UI 实时消费的稳定 stream API。

- 设计并实现 wasm-bindgen exported event stream，优先 `ReadableStream` / AsyncIterator，避免 callback-only API。
- turn execution 需要支持 cancellation token 或等价 cancel handle。
- 确认 streaming API 与现有 trace collection 共存：UI 消费实时事件，tests 仍能得到完整 canonical trace。
- 为 mid-turn failure、cancelled turn、host callback rejection 增加事件和测试。

验收：

- web app 不需要等整个 turn 结束才能显示 assistant/tool deltas。
- cancel 后 history、running process、trace 都处于可恢复状态。

### 4.6 Provider Compatibility Isolation

目标：支持 DashScope 等 OpenAI-compatible provider 的 smoke，但不污染 upstream conformance。

- 把 provider-specific request/response quirks 收敛到 `ModelTransport` adapter。
- 对 `custom/freeform apply_patch` 不支持的 provider，设计显式 compatibility mode，例如 function-tool fallback；默认 conformance path 仍使用 upstream-style custom tool。
- 增加 live smoke cases：function tool follow-up、custom/freeform unsupported detection、empty tools edge guard、provider error normalization。
- 文档标明每个 provider 的支持矩阵和已知 divergence。

验收：

- live smoke 失败不会被误判为 core conformance failure。
- compatibility fallback 有独立配置和测试，不改变默认 tool specs。

### 4.7 Runtime Persistence Hardening

目标：把 browser runtime 的持久化和恢复路径从 e2e happy path 扩展到可维护状态。

- 明确持久化边界：Turso browser SQLite 只保存 session/message/trace/wasm session metadata，不保存 workspace 文件内容，不新增 SQLite file manifest 或 snapshot ref 表。
- 使用 OPFS 作为 workspace snapshot 的唯一 source of truth；目录结构本身就是文件索引，通过 OPFS `readDir`/`entries()` 派生状态。
- WebContainer FS 只作为运行时内存文件系统；每轮或显式保存时用 `webcontainer.export("workspace", { format: "binary", excludes })` 写入 OPFS deterministic path，例如 `/browser-codex/workspaces/<session-id>/latest.wcsnap`。
- 恢复 session 时按约定路径从 OPFS 读取 `latest.wcsnap` 并 `webcontainer.mount(bytes)`；缺失或损坏时回退到默认 workspace，并返回 UI 可展示的恢复错误。
- 默认排除 `node_modules`、`.git`、`dist`、`build`、`.next`、`.vite`、`.turbo`、`coverage`、日志和缓存目录，避免把依赖和构建产物写入 snapshot。
- 暂不支持把 `showDirectoryPicker()` 返回的用户目录直接作为 workspace mount；后续如支持本地目录，只做显式 import/export/sync-back，不改变 WebContainer 运行时 FS 边界。
- 为 Turso storage schema 增加 migration/versioning strategy，但 migration 不负责 workspace blob 或文件索引。
- 增加 workspace snapshot restore/export 的 edge cases：空 workspace、大文件、nested dirs、删除后恢复、snapshot corruption、OPFS 文件缺失。
- 增加 session/history list 的多 session 测试。
- 确保 runtime package 继续拥有 WebContainer FS/exec、Turso browser SQLite、OPFS workspace snapshot、wasm host callback wiring；web app 不直接接这些底层 adapter。

验收：

- reload restore 不只覆盖单 session happy path。
- SQLite 中不再存 `workspace_snapshot_json` 或其他 workspace 文件索引；workspace 恢复只依赖 OPFS deterministic path。
- storage/workspace failure 能返回 UI 可展示的错误，不破坏 core session state。

### 4.8 Documentation And Maintenance

目标：让后续实现者能按同一边界继续推进。

- `docs/wasm-core-harness.md` 与本文件同步更新测试策略、oracle 实现和 case policy。
- `AGENTS.md` 只保留稳定项目规则；具体阶段性计划放在 `PLAN.md`。
- 给 copied upstream code、custom divergence、provider fallback 保持 source-reference comments。
- 在 README 中区分当前可运行命令、研究文档、未来计划。

验收：

- 修改 harness 或 core 边界时，同步更新 `PLAN.md`、`docs/wasm-core-harness.md`，必要时更新 `AGENTS.md`。
- 新 contributor 能通过 README 找到默认验证命令。

## 5. 默认验证命令

每次 core/harness/runtime 改动后至少运行：

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

## 6. 下一批优先级

1. 建 full native upstream oracle runner spike。
2. 扩展 unified exec conformance：long-running、stdin、poll、kill、resize、large output truncation。
3. 实现 wasm event streaming/cancellation public API。
4. 扩展 apply_patch fixtures 和 invalid argument cases。
5. 把 provider compatibility mode 从 conformance path 中彻底隔离并文档化。
