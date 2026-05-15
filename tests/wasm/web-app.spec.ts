import { expect, test } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const innerAppPort = 5794;

let appServer: ChildProcess;
let appProxyServer: Server;
let appUrl: string;
let providerServer: Server;
let providerUrl: string;

test.beforeAll(async () => {
  const build = spawnSync("bun", ["run", "web:wasm"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (build.status !== 0) {
    throw new Error(`web:wasm failed\n${build.stdout}\n${build.stderr}`);
  }
  const appBuild = spawnSync("bun", ["run", "--cwd", "apps/web", "build"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (appBuild.status !== 0) {
    throw new Error(`web build failed\n${appBuild.stdout}\n${appBuild.stderr}`);
  }

  providerServer = createProviderServer();
  await new Promise<void>((resolveListen) => {
    providerServer.listen(0, "127.0.0.1", resolveListen);
  });
  const address = providerServer.address();
  if (!address || typeof address === "string") {
    throw new Error("provider server did not bind to a TCP port");
  }
  providerUrl = `http://127.0.0.1:${address.port}/v1`;

  appServer = spawn(
    "bun",
    [
      "run",
      "--cwd",
      "apps/web",
      "preview",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(innerAppPort),
    ],
    {
      cwd: repoRoot,
      detached: true,
      env: { ...process.env },
      stdio: "pipe",
    },
  );
  await waitForDevServer(appServer, innerAppPort);
  appProxyServer = createHeaderProxy(innerAppPort);
  await new Promise<void>((resolveListen) => {
    appProxyServer.listen(0, "127.0.0.1", resolveListen);
  });
  const proxyAddress = appProxyServer.address();
  if (!proxyAddress || typeof proxyAddress === "string") {
    throw new Error("app proxy server did not bind to a TCP port");
  }
  appUrl = `http://127.0.0.1:${proxyAddress.port}`;
});

test.afterAll(async () => {
  if (appServer?.pid !== undefined) {
    try {
      process.kill(-appServer.pid, "SIGTERM");
    } catch {
      appServer.kill("SIGTERM");
    }
  }
  if (appProxyServer !== undefined) {
    await new Promise<void>((resolveClose) =>
      appProxyServer.close(() => resolveClose()),
    );
  }
  if (providerServer !== undefined) {
    await new Promise<void>((resolveClose) =>
      providerServer.close(() => resolveClose()),
    );
  }
});

test("runs real wasm agent turn through WebContainer and Turso persistence", async ({
  page,
}) => {
  const dbName = `browser-codex-e2e-${Date.now()}.sqlite3`;
  await page.goto(`${appUrl}/?db=${encodeURIComponent(dbName)}`);
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);

  await page.getByRole("textbox", { name: "Responses URL" }).fill(providerUrl);
  await page.getByRole("textbox", { name: "API Key" }).fill("sk-e2e");
  await page.getByRole("textbox", { name: "Model" }).fill("e2e-model");
  await page.getByRole("button", { name: "Save" }).click();

  const prompt = page.getByRole("textbox", { name: "Agent prompt" });
  await expect(prompt).toBeEnabled({ timeout: 60_000 });
  await prompt.fill("Run the complete browser runtime e2e.");
  await page.getByRole("button", { name: "Send" }).click();

  for (let approval = 0; approval < 3; approval += 1) {
    await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole("button", { name: "Approve" }).click();
  }

  const transcript = page.locator("article");
  await expect(transcript.filter({ hasText: "E2E complete." })).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.locator("pre").filter({ hasText: "E2E note" }).first(),
  ).toBeVisible();
  await expect(
    page.locator("pre").filter({ hasText: "exec ok" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "tool_outputs" }),
  ).toBeVisible();
  await expect(
    transcript.filter({ hasText: "Run the complete browser runtime e2e." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run the complete browser runtime e2e." }),
  ).toBeVisible();

  await page.reload();
  const restoredTranscript = page.locator("article");
  await expect(
    restoredTranscript.filter({ hasText: "E2E complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    restoredTranscript.filter({
      hasText: "Run the complete browser runtime e2e.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run the complete browser runtime e2e." }),
  ).toBeVisible();
  const restoredPrompt = page.getByRole("textbox", { name: "Agent prompt" });
  await expect(restoredPrompt).toBeEnabled({ timeout: 60_000 });
  await restoredPrompt.fill("Verify restored workspace file.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(
    restoredTranscript.filter({ hasText: "Restore verified." }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.locator("pre").filter({ hasText: "E2E note" }).first(),
  ).toBeVisible();
});

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

    const body = JSON.parse(await readRequestBody(request)) as {
      input?: Array<Record<string, unknown>>;
    };
    const input = body.input ?? [];
    const isRestoreCheck = input.some((item) =>
      JSON.stringify(item).includes("Verify restored workspace file."),
    );
    const hasRestoreRead = hasToolOutput(input, "restore-read");
    const hasExecOne = hasToolOutput(input, "exec-1");
    const hasPatch = hasToolOutput(input, "patch-1");
    const hasExecTwo = hasToolOutput(input, "exec-2");
    const endTurn = isRestoreCheck ? hasRestoreRead : hasExecTwo;

    const output =
      isRestoreCheck && !hasRestoreRead
        ? [
            functionCall("restore-read", "exec_command", {
              cmd: "node -e \"console.log(require('fs').readFileSync('session.md','utf8'))\"",
              workdir: "/workspace",
              yield_time_ms: 1000,
              max_output_tokens: 2000,
            }),
          ]
        : isRestoreCheck
          ? [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Restore verified." }],
              },
            ]
          : !hasExecOne
            ? [
                functionCall("exec-1", "exec_command", {
                  cmd: "node -e \"console.log('exec ok')\"",
                  workdir: "/workspace",
                  yield_time_ms: 1000,
                  max_output_tokens: 2000,
                }),
              ]
            : !hasPatch
              ? [
                  {
                    type: "custom_tool_call",
                    call_id: "patch-1",
                    name: "apply_patch",
                    input:
                      "*** Begin Patch\n*** Update File: /workspace/session.md\n@@\n # Browser Codex Session\n \n+E2E note\n*** End Patch\n",
                  },
                ]
              : !hasExecTwo
                ? [
                    functionCall("exec-2", "exec_command", {
                      cmd: "npm test",
                      workdir: "/workspace",
                      yield_time_ms: 1000,
                      max_output_tokens: 2000,
                    }),
                  ]
                : [
                    {
                      type: "message",
                      role: "assistant",
                      content: [{ type: "output_text", text: "E2E complete." }],
                    },
                  ];

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: `resp-${Date.now()}`,
        end_turn: endTurn,
        output,
      }),
    );
  });
}

function createHeaderProxy(targetPort: number) {
  return createServer((request, response) => {
    const upstream = new URL(
      request.url ?? "/",
      `http://127.0.0.1:${targetPort}`,
    );
    const proxyRequest = fetch(upstream, {
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : (request as unknown as ReadableStream),
      duplex: "half",
      headers: request.headers as HeadersInit,
      method: request.method,
    } as RequestInit & { duplex: "half" });
    void proxyRequest
      .then(async (upstreamResponse) => {
        response.statusCode = upstreamResponse.status;
        upstreamResponse.headers.forEach((value, key) => {
          if (
            key === "content-encoding" ||
            key === "content-length" ||
            key === "transfer-encoding"
          ) {
            return;
          }
          response.setHeader(key, value);
        });
        response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        const body = upstreamResponse.body;
        if (body === null) {
          response.end();
          return;
        }
        const reader = body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            response.end();
            return;
          }
          response.write(Buffer.from(chunk.value));
        }
      })
      .catch((error) => {
        response.writeHead(502);
        response.end(error instanceof Error ? error.message : String(error));
      });
  });
}

function functionCall(
  callId: string,
  name: string,
  argumentsObject: Record<string, unknown>,
) {
  return {
    type: "function_call",
    call_id: callId,
    name,
    arguments: JSON.stringify(argumentsObject),
  };
}

function hasToolOutput(input: Array<Record<string, unknown>>, callId: string) {
  return input.some(
    (item) => item.call_id === callId && isToolOutput(item.type),
  );
}

function isToolOutput(type: unknown) {
  return type === "function_call_output" || type === "custom_tool_call_output";
}

function readRequestBody(request: NodeJS.ReadableStream) {
  return new Promise<string>((resolveRead, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolveRead(body));
    request.on("error", reject);
  });
}

function waitForDevServer(process: ChildProcess, port: number) {
  return new Promise<void>((resolveReady, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settle(() => reject(new Error("dev server timeout")));
    }, 60_000);
    const interval = setInterval(() => {
      void fetch(`http://127.0.0.1:${port}/`)
        .then(async (response) => {
          if (response.status >= 500) {
            return;
          }
          await response.arrayBuffer();
          settle(resolveReady);
        })
        .catch(() => undefined);
      if (process.exitCode !== null) {
        settle(() =>
          reject(new Error(`dev server exited with ${process.exitCode}`)),
        );
      }
    }, 200);

    function settle(callback: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(interval);
      callback();
    }
  });
}
