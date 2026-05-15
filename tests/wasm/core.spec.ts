import { expect, test } from "@playwright/test";
import { readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeTrace,
  runUpstreamOracle,
} from "../../harness/oracle/upstreamOracle";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const repoRoot = resolve(__dirname, "../..");

let server: Server;
let baseUrl: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requested = normalize(decodeURIComponent(url.pathname)).replace(
      /^\/+/,
      "",
    );
    const filePath = resolve(
      repoRoot,
      requested || "harness/browser/index.html",
    );
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
    throw new Error("failed to start harness server");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
});

test("runs no-tool case in browser wasm", async ({ page }) => {
  const { caseJson, trace } = await runCase(page, "no_tool");

  expect(trace.events.map((event: { type: string }) => event.type)).toContain(
    "turn_complete",
  );
  expect(trace.tool_outputs).toEqual([]);
  expect(canonicalizeTrace(trace)).toEqual(
    runUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs streamed text and reasoning cases in browser wasm", async ({
  page,
}) => {
  for (const caseName of ["streamed_assistant_text_delta", "reasoning_delta"]) {
    const { caseJson, trace } = await runCase(page, caseName);

    expect(trace.events.map((event: { type: string }) => event.type)).toContain(
      "turn_complete",
    );
    expect(canonicalizeTrace(trace)).toEqual(
      runUpstreamOracle(repoRoot, caseJson),
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
  expect(trace.final_files).toEqual([
    { path: "/workspace/modify.txt", text: "line1\nchanged\n" },
    { path: "/workspace/nested/new.txt", text: "created\n" },
  ]);
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runUpstreamOracle(repoRoot, caseJson),
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
    runUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs unsupported custom tool case in browser wasm", async ({ page }) => {
  const { caseJson, trace } = await runCase(page, "unsupported_custom_tool");

  expect(trace.tool_outputs[0]).toMatchObject({
    call_id: "unsupported-1",
    type: "custom_tool_call_output",
    success: false,
    text: "unsupported custom tool call: unknown_tool",
  });
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs successful exec case in browser wasm", async ({ page }) => {
  const { caseJson, trace } = await runCase(page, "exec_success");

  expect(trace.tool_outputs[0].call_id).toBe("exec-1");
  expect(trace.tool_outputs[0].success).toBe(true);
  expect(trace.tool_outputs[0].text).toContain("Process exited with code 0");
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs multiple tool calls in one browser wasm turn", async ({ page }) => {
  const { caseJson, trace } = await runCase(page, "multiple_tool_calls");

  expect(
    trace.tool_outputs.map((output: { call_id: string }) => output.call_id),
  ).toEqual(["exec-1", "unsupported-1"]);
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs denied exec case in browser wasm", async ({ page }) => {
  const { caseJson, trace } = await runCase(page, "exec_denied");

  expect(trace.tool_outputs[0].call_id).toBe("exec-1");
  expect(trace.tool_outputs[0].success).toBe(false);
  expect(trace.tool_outputs[0].text).toContain("denied by approval policy");
  validateRequestBodyInvariants(trace);
  expect(canonicalizeTrace(trace)).toEqual(
    runUpstreamOracle(repoRoot, caseJson),
  );
});

test("runs early stream close retry case in browser wasm", async ({ page }) => {
  const { caseJson, trace } = await runCase(page, "early_stream_close_retry");

  expect(trace.events).toContainEqual(
    expect.objectContaining({ type: "stream_error", retry: 1 }),
  );
  expect(canonicalizeTrace(trace)).toEqual(
    runUpstreamOracle(repoRoot, caseJson),
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
    runUpstreamOracle(repoRoot, caseJson),
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
  expect(canonicalizeTrace(trace)).toEqual(
    runUpstreamOracle(repoRoot, caseJson),
  );
});

async function runCase(
  page: import("@playwright/test").Page,
  caseName: string,
) {
  const caseJson = readFileSync(
    join(repoRoot, "harness/cases", `${caseName}.json`),
    "utf8",
  );
  await page.goto(`${baseUrl}/harness/browser/index.html`);
  const result = await page.evaluate(
    async ({ caseJson: input }) => {
      // @ts-expect-error The harness server exposes the wasm-bindgen bundle at this browser URL.
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
