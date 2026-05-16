import { expect, test } from "@playwright/test";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeTrace,
  runNativeUpstreamOracle,
  runUpstreamOracle,
} from "../oracle/upstreamOracle";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const repoRoot = resolve(__dirname, "../..");

let server: Server;
let baseUrl: string;
let providerServer: Server;
let providerUrl: string;
const providerRequests: Array<Record<string, any>> = [];

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requested = normalize(decodeURIComponent(url.pathname)).replace(
      /^\/+/,
      "",
    );
    const filePath = resolve(repoRoot, requested || "tests/browser/index.html");
    if (!filePath.startsWith(repoRoot)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }

    try {
      const stats = statSync(filePath);
      const finalPath = stats.isDirectory()
        ? join(filePath, "index.html")
        : filePath;
      response.writeHead(200, {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Content-Type": contentType(finalPath),
      });
      response.end(readFileSync(finalPath));
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start test server");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  providerServer = createProviderServer();
  await new Promise<void>((resolveListen) => {
    providerServer.listen(0, "127.0.0.1", resolveListen);
  });
  const providerAddress = providerServer.address();
  if (!providerAddress || typeof providerAddress === "string") {
    throw new Error("failed to start provider server");
  }
  providerUrl = `http://127.0.0.1:${providerAddress.port}/v1`;
});

test.afterAll(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await new Promise<void>((resolveClose) =>
    providerServer.close(() => resolveClose()),
  );
});

test("streams host turn events from browser wasm ReadableStream", async ({
  page,
}) => {
  providerRequests.length = 0;
  await page.goto(`${baseUrl}/tests/browser/index.html`);
  const chunks = await page.evaluate(
    async ({ providerUrl }) => {
      // @ts-expect-error The test server exposes the wasm-bindgen bundle at this browser URL.
      const mod = await import("/pkg/codex-browser-core/codex_browser_core.js");
      await mod.default("/pkg/codex-browser-core/codex_browser_core_bg.wasm");
      (globalThis as any).__browserCodexFetch ??=
        globalThis.fetch.bind(globalThis);
      const stream = mod.run_host_turn_stream_json(
        JSON.stringify({
          provider: {
            apiKey: "sk-stream",
            baseUrl: providerUrl,
            model: "stream-model",
          },
          userInput: [{ type: "text", text: "stream events" }],
        }),
        {
          fs: { snapshotText: async () => [] },
          exec: {},
          approvals: {
            approveExec: async () => ({ approved: true }),
            approvePatch: async () => ({ approved: true }),
          },
        },
      ) as ReadableStream<unknown>;
      const reader = stream.getReader();
      const chunks: unknown[] = [];
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
      }
      return chunks;
    },
    { providerUrl },
  );

  expect(chunks.map((chunk: any) => chunk.type)).toEqual(
    expect.arrayContaining(["event", "done"]),
  );
  expect(chunks).toContainEqual(
    expect.objectContaining({
      type: "event",
      event: expect.objectContaining({ type: "turn_started" }),
    }),
  );
  expect(chunks).toContainEqual(
    expect.objectContaining({
      type: "done",
      output: expect.objectContaining({ assistantText: "stream done" }),
    }),
  );
  expect(providerRequests[0]).toMatchObject({
    model: "stream-model",
    tool_choice: "auto",
    stream: false,
  });
  expect(providerRequests[0]?.tools?.length).toBeGreaterThan(0);
  expect(providerRequests[0]?.tools).toContainEqual(
    expect.objectContaining({ type: "custom", name: "apply_patch" }),
  );
});

test("closes browser wasm ReadableStream turns when cancelled during tool approval", async ({
  page,
}) => {
  providerRequests.length = 0;
  await page.goto(`${baseUrl}/tests/browser/index.html`);
  const result = await page.evaluate(
    async ({ providerUrl }) => {
      // @ts-expect-error The test server exposes the wasm-bindgen bundle at this browser URL.
      const mod = await import("/pkg/codex-browser-core/codex_browser_core.js");
      await mod.default("/pkg/codex-browser-core/codex_browser_core_bg.wasm");
      (globalThis as any).__browserCodexFetch ??=
        globalThis.fetch.bind(globalThis);
      let resolveApprovalSeen: () => void = () => {};
      const approvalSeen = new Promise<void>((resolve) => {
        resolveApprovalSeen = resolve;
      });
      let releaseApproval: ((decision: unknown) => void) | undefined;
      const stream = mod.run_host_turn_stream_json(
        JSON.stringify({
          provider: {
            apiKey: "sk-cancel",
            baseUrl: providerUrl,
            model: "approval-reject-model",
          },
          userInput: [{ type: "text", text: "cancel during tool approval" }],
        }),
        {
          fs: { snapshotText: async () => [] },
          exec: {
            start: async () => {
              throw new Error("exec should not run before approval resolves");
            },
          },
          approvals: {
            approveExec: async () => {
              resolveApprovalSeen();
              return new Promise((resolve) => {
                releaseApproval = resolve;
              });
            },
            approvePatch: async () => ({ approved: true }),
          },
        },
      ) as ReadableStream<unknown>;
      const reader = stream.getReader();
      const first = await reader.read();
      await approvalSeen;
      await reader.cancel("test cancellation");
      releaseApproval?.({ approved: false, reason: "cancelled by test" });
      const afterCancel = await reader.read();
      return {
        first: first.value,
        afterCancelDone: afterCancel.done,
        approvalSeen: true,
      };
    },
    { providerUrl },
  );

  expect(result.first).toMatchObject({
    type: "event",
    event: { type: "turn_started" },
  });
  expect(result.approvalSeen).toBe(true);
  expect(result.afterCancelDone).toBe(true);
  expect(providerRequests[0]?.tools?.length).toBeGreaterThan(0);
});

test("maps rejected approval host callbacks to model-visible tool output", async ({
  page,
}) => {
  providerRequests.length = 0;
  await page.goto(`${baseUrl}/tests/browser/index.html`);
  const result = await page.evaluate(
    async ({ providerUrl }) => {
      // @ts-expect-error The test server exposes the wasm-bindgen bundle at this browser URL.
      const mod = await import("/pkg/codex-browser-core/codex_browser_core.js");
      await mod.default("/pkg/codex-browser-core/codex_browser_core_bg.wasm");
      (globalThis as any).__browserCodexFetch ??=
        globalThis.fetch.bind(globalThis);
      const execCalls: unknown[] = [];
      const stream = mod.run_host_turn_stream_json(
        JSON.stringify({
          provider: {
            apiKey: "sk-approval-reject",
            baseUrl: providerUrl,
            model: "approval-reject-model",
          },
          userInput: [{ type: "text", text: "exercise approval rejection" }],
        }),
        {
          fs: { snapshotText: async () => [] },
          exec: {
            start: async (request: unknown) => {
              execCalls.push(request);
              throw new Error("exec should not run after approval rejection");
            },
          },
          approvals: {
            approveExec: async () => {
              throw new Error("approval callback failed");
            },
            approvePatch: async () => ({ approved: true }),
          },
        },
      ) as ReadableStream<any>;
      const reader = stream.getReader();
      const chunks: any[] = [];
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
      }
      return { chunks, execCalls };
    },
    { providerUrl },
  );

  expect(result.execCalls).toEqual([]);
  const done = result.chunks.find((chunk: any) => chunk.type === "done");
  expect(done?.output?.assistantText).toBe("approval rejection handled");
  const toolOutput = done?.output?.trace?.tool_outputs?.[0];
  expect(toolOutput).toMatchObject({
    call_id: "approval-reject",
    success: false,
    type: "function_call_output",
  });
  expect(toolOutput?.text).toContain("rejected by user");
  expect(providerRequests).toHaveLength(2);
  expect(providerRequests[1]?.input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "function_call_output",
        call_id: "approval-reject",
      }),
    ]),
  );
});

test("normalizes live provider errors outside conformance oracle", async ({
  page,
}) => {
  await page.goto(`${baseUrl}/tests/browser/index.html`);
  const message = await page.evaluate(
    async ({ providerUrl }) => {
      // @ts-expect-error The test server exposes the wasm-bindgen bundle at this browser URL.
      const mod = await import("/pkg/codex-browser-core/codex_browser_core.js");
      await mod.default("/pkg/codex-browser-core/codex_browser_core_bg.wasm");
      (globalThis as any).__browserCodexFetch ??=
        globalThis.fetch.bind(globalThis);
      try {
        await mod.run_live_json(
          JSON.stringify({
            provider: {
              apiKey: "sk-error",
              baseUrl: providerUrl,
              model: "error-model",
            },
            userInput: [{ type: "text", text: "trigger provider error" }],
          }),
        );
        return "";
      } catch (error) {
        return String(error);
      }
    },
    { providerUrl },
  );

  expect(message).toContain("model request failed (429): rate limited");
});

test("uses apply_patch function compatibility mode outside conformance oracle", async ({
  page,
}) => {
  providerRequests.length = 0;
  await page.goto(`${baseUrl}/tests/browser/index.html`);
  const trace = await page.evaluate(
    async ({ providerUrl }) => {
      // @ts-expect-error The test server exposes the wasm-bindgen bundle at this browser URL.
      const mod = await import("/pkg/codex-browser-core/codex_browser_core.js");
      await mod.default("/pkg/codex-browser-core/codex_browser_core_bg.wasm");
      (globalThis as any).__browserCodexFetch ??=
        globalThis.fetch.bind(globalThis);
      const raw = await mod.run_live_json(
        JSON.stringify({
          provider: {
            apiKey: "sk-compat",
            baseUrl: providerUrl,
            model: "apply-patch-function-model",
            toolCompatibility: "applyPatchFunction",
          },
          initialFiles: [{ path: "/workspace/file.txt", text: "old\n" }],
          userInput: [
            { type: "text", text: "patch through function fallback" },
          ],
          requirePatchApproval: true,
        }),
      );
      return JSON.parse(raw);
    },
    { providerUrl },
  );

  expect(providerRequests).toHaveLength(2);
  const firstRequest = providerRequests[0]!;
  const secondRequest = providerRequests[1]!;
  expect(firstRequest.tools).not.toContainEqual(
    expect.objectContaining({ type: "custom", name: "apply_patch" }),
  );
  expect(firstRequest.tools).toContainEqual(
    expect.objectContaining({
      type: "function",
      name: "apply_patch",
      parameters: expect.objectContaining({
        properties: expect.objectContaining({
          patch: expect.objectContaining({ type: "string" }),
        }),
        required: ["patch"],
      }),
    }),
  );
  expect(secondRequest.input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "function_call",
        call_id: "patch-fn-1",
        name: "apply_patch",
      }),
      expect.objectContaining({
        type: "function_call_output",
        call_id: "patch-fn-1",
      }),
    ]),
  );
  expect(secondRequest.input).not.toContainEqual(
    expect.objectContaining({ type: "custom_tool_call_output" }),
  );
  expect(trace.tool_outputs[0]).toMatchObject({
    call_id: "patch-fn-1",
    type: "custom_tool_call_output",
    success: true,
  });
  expect(trace.final_files).toEqual([
    { path: "/workspace/file.txt", text: "new\n" },
  ]);
});

test("runs tool-backed streamed text and reasoning cases in browser wasm", async ({
  page,
}) => {
  for (const caseName of ["streamed_assistant_text_delta", "reasoning_delta"]) {
    const { caseJson, trace } = await runCase(page, caseName);

    expect(trace.tool_outputs.length).toBeGreaterThan(0);
    expect(trace.events.map((event: { type: string }) => event.type)).toContain(
      "turn_complete",
    );
    expect(canonicalizeTrace(trace)).toEqual(
      runNativeUpstreamOracle(repoRoot, caseJson),
    );
  }
});

test("runs apply_patch case in browser wasm", async ({ page }) => {
  const { caseJson, trace } = await runCase(
    page,
    "apply_patch_add_update_delete",
  );

  expect(trace.tool_outputs[0].call_id).toBe("apply-1");
  expect(trace.tool_outputs[0].success).toBe(true);
  expect(trace.tool_outputs[0].text).toContain("Exit code: 0");
  expect(trace.tool_outputs[0].text).toContain(
    "Success. Updated the following files:",
  );
  expect(trace.final_files).toEqual([
    { path: "/workspace/modify.txt", text: "line1\nchanged\n" },
    { path: "/workspace/nested/new.txt", text: "created\n" },
  ]);
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runNativeUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs invalid apply_patch case in browser wasm", async ({ page }) => {
  const { caseJson, trace } = await runCase(page, "invalid_apply_patch");

  expect(trace.tool_outputs[0]).toMatchObject({
    call_id: "apply-1",
    success: false,
  });
  expect(trace.tool_outputs[0].text).toContain(
    "apply_patch verification failed",
  );
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runNativeUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs apply_patch move case in browser wasm", async ({ page }) => {
  const { caseJson, trace } = await runCase(page, "apply_patch_move");

  expect(trace.tool_outputs[0]).toMatchObject({
    call_id: "apply-1",
    success: true,
  });
  expect(trace.tool_outputs[0].text).toContain("Exit code: 0");
  expect(trace.tool_outputs[0].text).toContain(
    "Success. Updated the following files:",
  );
  expect(trace.final_files).toEqual([
    { path: "/workspace/new.txt", text: "new\n" },
  ]);
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runNativeUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs apply_patch end-of-file marker case in browser wasm", async ({
  page,
}) => {
  const { caseJson, trace } = await runCase(page, "apply_patch_end_of_file");

  expect(trace.tool_outputs[0]).toMatchObject({
    call_id: "apply-1",
    success: true,
  });
  expect(trace.tool_outputs[0].text).toContain("Exit code: 0");
  expect(trace.tool_outputs[0].text).toContain(
    "Success. Updated the following files:",
  );
  expect(trace.final_files).toEqual([
    { path: "/workspace/tail.txt", text: "first\nsecond updated\n" },
  ]);
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runNativeUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs apply_patch multiple-chunk update case in browser wasm", async ({
  page,
}) => {
  const { caseJson, trace } = await runCase(
    page,
    "apply_patch_multiple_chunks",
  );

  expect(trace.tool_outputs[0]).toMatchObject({
    call_id: "apply-1",
    success: true,
  });
  expect(trace.tool_outputs[0].text).toContain("Exit code: 0");
  expect(trace.tool_outputs[0].text).toContain(
    "Success. Updated the following files:",
  );
  expect(trace.final_files).toEqual([
    {
      path: "/workspace/multi.txt",
      text: "line1\nchanged2\nline3\nchanged4\n",
    },
  ]);
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runNativeUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs unsupported custom tool case against native upstream core oracle", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { caseJson, trace } = await runCase(page, "unsupported_custom_tool");

  expect(trace.tool_outputs[0]).toMatchObject({
    call_id: "unsupported-1",
    type: "custom_tool_call_output",
    success: false,
    text: "unsupported custom tool call: unknown_tool",
  });
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runNativeUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs additional tool routing conformance cases in browser wasm", async ({
  page,
}) => {
  const cases = [
    {
      name: "tool_search_client",
      output: "[]",
      type: "tool_search_output",
    },
    {
      name: "invalid_exec_arguments",
      output: "invalid tool arguments for exec_command",
      type: "function_call_output",
    },
    {
      name: "exec_unsupported_sandbox_permissions",
      output: "native sandbox permission escalation is unsupported",
      type: "function_call_output",
    },
  ];

  for (const currentCase of cases) {
    const { caseJson, trace } = await runCase(page, currentCase.name);

    expect(trace.tool_outputs[0].type).toBe(currentCase.type);
    expect(trace.tool_outputs[0].success).toBe(
      currentCase.type === "tool_search_output",
    );
    expect(trace.tool_outputs[0].text).toContain(currentCase.output);
    expect(trace.exec).toEqual([]);
    expect(trace.approvals).toEqual([]);
    validateRequestBodyInvariants(trace);
    expect(canonicalizeTrace(trace)).toEqual(
      runUpstreamOracle(repoRoot, caseJson),
    );
  }
});

test("runs unsupported function tool case against native upstream core oracle", async ({
  page,
}) => {
  const { caseJson, trace } = await runCase(page, "unsupported_function_tool");

  expect(trace.tool_outputs[0]).toMatchObject({
    call_id: "unknown-1",
    success: false,
    type: "function_call_output",
    text: "unsupported call: unknown_function",
  });
  expect(trace.exec).toEqual([]);
  expect(trace.approvals).toEqual([]);
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runNativeUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs successful exec case in browser wasm", async ({ page }) => {
  const { caseJson, trace } = await runCase(page, "exec_success");

  expect(trace.tool_outputs[0].call_id).toBe("exec-1");
  expect(trace.tool_outputs[0].success).toBe(true);
  expect(trace.tool_outputs[0].text).toContain("Process exited with code 0");
  expect(trace.exec).toEqual([
    {
      type: "exec_command",
      request: {
        cmd: "printf 'hi\\n'",
        workdir: "/workspace",
        login: true,
        yield_time_ms: 1,
        max_output_tokens: 20,
        tty: false,
      },
    },
  ]);
  expect(trace.approvals).toEqual([]);
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runNativeUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs deterministic exec truncation against native upstream core oracle", async ({
  page,
}) => {
  const { caseJson, trace } = await runCase(page, "exec_native_truncation");

  expect(trace.tool_outputs[0].call_id).toBe("exec-1");
  expect(trace.tool_outputs[0].success).toBe(true);
  expect(trace.tool_outputs[0].text).toContain("tokens truncated");
  expect(trace.tool_outputs[0].text).toContain("Original token count: 5");
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runNativeUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs write_stdin poll case in browser wasm", async ({ page }) => {
  const { caseJson, trace } = await runCase(page, "write_stdin_poll");

  expect(trace.tool_outputs[0].call_id).toBe("stdin-1");
  expect(trace.tool_outputs[0].success).toBe(true);
  expect(trace.tool_outputs[0].text).toContain("Process exited with code 0");
  expect(trace.exec).toEqual([
    {
      type: "poll_output",
      process_id: 42,
      options: {
        yield_time_ms: 15,
        max_output_tokens: 20,
      },
    },
  ]);
  expect(trace.approvals).toEqual([]);
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs write_stdin input case in browser wasm", async ({ page }) => {
  const { caseJson, trace } = await runCase(page, "write_stdin_write");

  expect(trace.tool_outputs[0].call_id).toBe("stdin-1");
  expect(trace.tool_outputs[0].success).toBe(true);
  expect(trace.tool_outputs[0].text).toContain(
    "Process running with session ID 42",
  );
  expect(trace.exec).toEqual([
    {
      type: "write_stdin",
      process_id: 42,
      input: "yes\n",
      options: {
        yield_time_ms: 15,
        max_output_tokens: 20,
      },
    },
  ]);
  expect(trace.approvals).toEqual([]);
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs exec truncation and payload conformance cases in browser wasm", async ({
  page,
}) => {
  const truncated = await runCase(page, "exec_truncation");
  expect(truncated.trace.tool_outputs[0].text).toContain("tokens truncated");
  expect(truncated.trace.tool_outputs[0].text).toContain(
    "Original token count: 18",
  );
  validateRequestBodyInvariants(truncated.trace);
  expect(canonicalizeTrace(truncated.trace)).toEqual(
    runUpstreamOracle(repoRoot, truncated.caseJson),
  );

  const invalidUtf8 = await runCase(page, "exec_invalid_utf8");
  expect(invalidUtf8.trace.tool_outputs[0].text).toContain("��A");
  validateRequestBodyInvariants(invalidUtf8.trace);
  expect(canonicalizeTrace(invalidUtf8.trace)).toEqual(
    runUpstreamOracle(repoRoot, invalidUtf8.caseJson),
  );

  const payload = await runCase(page, "exec_tty_shell_payload");
  expect(payload.trace.exec).toEqual([
    {
      type: "exec_command",
      request: {
        cmd: "printf hi",
        workdir: "/workspace",
        shell: "/bin/zsh",
        login: false,
        yield_time_ms: 5,
        max_output_tokens: 20,
        tty: true,
      },
    },
  ]);
  expect(payload.trace.approvals).toEqual([]);
  validateRequestBodyInvariants(payload.trace);
  expect(canonicalizeTrace(payload.trace)).toEqual(
    runUpstreamOracle(repoRoot, payload.caseJson),
  );
});

test("runs multiple tool calls in one browser wasm turn", async ({ page }) => {
  const { caseJson, trace } = await runCase(page, "multiple_tool_calls");

  expect(
    trace.tool_outputs.map((output: { call_id: string }) => output.call_id),
  ).toEqual(["exec-1", "unsupported-1"]);
  expect(trace.exec).toEqual([
    {
      type: "exec_command",
      request: {
        cmd: "printf 'hi\\n'",
        workdir: "/workspace",
        login: true,
        yield_time_ms: 1,
        max_output_tokens: 20,
        tty: false,
      },
    },
  ]);
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runNativeUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs denied exec case in browser wasm", async ({ page }) => {
  const { caseJson, trace } = await runCase(page, "exec_denied");

  expect(trace.tool_outputs[0].call_id).toBe("exec-1");
  expect(trace.tool_outputs[0].success).toBe(false);
  expect(trace.tool_outputs[0].text).toContain("rejected by user");
  expect(trace.exec).toEqual([]);
  expect(trace.approvals).toEqual([
    {
      type: "exec",
      request: {
        call_id: "exec-1",
        cmd: "rm -rf /workspace",
        workdir: "/workspace",
      },
      decision: { approved: false, reason: "scripted denial" },
    },
  ]);
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runNativeUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs early stream close retry case in browser wasm", async ({ page }) => {
  const { caseJson, trace } = await runCase(page, "early_stream_close_retry");

  expect(trace.events).toContainEqual(
    expect.objectContaining({ type: "stream_error", retry: 1 }),
  );
  expect(trace.tool_outputs.length).toBeGreaterThan(0);
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runNativeUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs early stream close tool retry case in browser wasm", async ({
  page,
}) => {
  const { caseJson, trace } = await runCase(
    page,
    "early_stream_close_tool_retry",
  );

  expect(trace.events).toContainEqual(
    expect.objectContaining({ type: "stream_error", retry: 1 }),
  );
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runNativeUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs parallel tool calls disabled case in browser wasm", async ({
  page,
}) => {
  const { caseJson, trace } = await runCase(
    page,
    "parallel_tool_calls_disabled",
  );

  expect(trace.model_requests[0].parallel_tool_calls).toBe(false);
  expect(trace.model_requests[1].parallel_tool_calls).toBe(false);
  expect(trace.tool_outputs.length).toBeGreaterThan(0);
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runNativeUpstreamOracle(repoRoot, caseJson),
  );
});

async function runCase(
  page: import("@playwright/test").Page,
  caseName: string,
) {
  const caseJson = readFileSync(
    join(repoRoot, "tests/cases", `${caseName}.json`),
    "utf8",
  );
  await page.goto(`${baseUrl}/tests/browser/index.html`);
  const result = await page.evaluate(
    async ({ caseJson: input }) => {
      // @ts-expect-error The test server exposes the wasm-bindgen bundle at this browser URL.
      const mod = await import("/pkg/codex-browser-core/codex_browser_core.js");
      await mod.default("/pkg/codex-browser-core/codex_browser_core_bg.wasm");
      return mod.run_case_json(input);
    },
    { caseJson },
  );
  return { caseJson, trace: JSON.parse(result) };
}

function contentType(filePath: string) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function createProviderServer() {
  return createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "authorization, content-type",
    );
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    const body = JSON.parse(await readRequestBody(request)) as Record<
      string,
      any
    >;
    providerRequests.push(body);
    if (body.model === "error-model") {
      response.writeHead(429, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "rate limited",
          },
        }),
      );
      return;
    }
    if (body.model === "apply-patch-function-model") {
      if (
        (body.tools ?? []).some(
          (tool: Record<string, unknown>) =>
            tool.type === "custom" && tool.name === "apply_patch",
        )
      ) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "custom tools unsupported",
            },
          }),
        );
        return;
      }
      const hasPatchOutput = (body.input ?? []).some(
        (item: Record<string, unknown>) =>
          item.type === "function_call_output" && item.call_id === "patch-fn-1",
      );
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: "resp-apply-patch-function",
          end_turn: hasPatchOutput,
          output: hasPatchOutput
            ? [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "function fallback patched",
                    },
                  ],
                },
              ]
            : [
                {
                  type: "function_call",
                  call_id: "patch-fn-1",
                  name: "apply_patch",
                  arguments: JSON.stringify({
                    patch:
                      "*** Begin Patch\n*** Update File: /workspace/file.txt\n@@\n-old\n+new\n*** End Patch",
                  }),
                },
              ],
        }),
      );
      return;
    }
    if (body.model === "approval-reject-model") {
      const hasToolOutput = (body.input ?? []).some(
        (item: Record<string, unknown>) =>
          item.type === "function_call_output" &&
          item.call_id === "approval-reject",
      );
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: "resp-approval-reject",
          end_turn: hasToolOutput,
          output: hasToolOutput
            ? [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "approval rejection handled",
                    },
                  ],
                },
              ]
            : [
                {
                  type: "function_call",
                  call_id: "approval-reject",
                  name: "exec_command",
                  arguments: JSON.stringify({
                    cmd: "echo should-not-run",
                    workdir: "/workspace",
                    yield_time_ms: 1000,
                    max_output_tokens: 2000,
                  }),
                },
              ],
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "resp-stream",
        end_turn: true,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "stream done" }],
          },
        ],
      }),
    );
  });
}

function readRequestBody(request: IncomingMessage) {
  return new Promise<string>((resolveRead, rejectRead) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      resolveRead(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", rejectRead);
  });
}

function validateRequestBodyInvariants(trace: any) {
  for (const request of trace.model_requests ?? []) {
    const items = request.input ?? [];
    const functionCalls = gatherCallIds(items, "function_call");
    const customToolCalls = gatherCallIds(items, "custom_tool_call");
    const toolSearchCalls = gatherCallIds(items, "tool_search_call");
    const functionCallOutputs = gatherOutputIds(items, "function_call_output");
    const customToolCallOutputs = gatherOutputIds(
      items,
      "custom_tool_call_output",
    );
    const toolSearchOutputs = gatherToolSearchOutputIds(items);

    for (const callId of functionCallOutputs) {
      expect(
        functionCalls.has(callId),
        `function_call_output without matching call: ${callId}`,
      ).toBe(true);
    }
    for (const callId of customToolCallOutputs) {
      expect(
        customToolCalls.has(callId),
        `custom_tool_call_output without matching call: ${callId}`,
      ).toBe(true);
    }
    for (const callId of toolSearchOutputs) {
      expect(
        toolSearchCalls.has(callId),
        `tool_search_output without matching call: ${callId}`,
      ).toBe(true);
    }
    for (const callId of functionCalls) {
      expect(
        functionCallOutputs.has(callId),
        `missing function_call_output: ${callId}`,
      ).toBe(true);
    }
    for (const callId of customToolCalls) {
      expect(
        customToolCallOutputs.has(callId),
        `missing custom_tool_call_output: ${callId}`,
      ).toBe(true);
    }
    for (const callId of toolSearchCalls) {
      expect(
        toolSearchOutputs.has(callId),
        `missing tool_search_output: ${callId}`,
      ).toBe(true);
    }
  }
}

function gatherCallIds(items: any[], kind: string) {
  return new Set(
    items
      .filter((item) => item.type === kind)
      .map((item) => item.call_id)
      .filter((callId) => typeof callId === "string" && callId.length > 0),
  );
}

function gatherOutputIds(items: any[], kind: string) {
  return new Set(
    items
      .filter((item) => item.type === kind)
      .map((item) => {
        expect(item.call_id, `${kind} is missing call_id`).toEqual(
          expect.any(String),
        );
        return item.call_id;
      }),
  );
}

function gatherToolSearchOutputIds(items: any[]) {
  return new Set(
    items
      .filter((item) => item.type === "tool_search_output")
      .flatMap((item) => {
        if (typeof item.call_id === "string" && item.call_id.length > 0) {
          return [item.call_id];
        }
        expect(
          item.execution,
          "tool_search_output without call_id must be server executed",
        ).toBe("server");
        return [];
      }),
  );
}
