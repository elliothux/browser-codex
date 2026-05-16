import { expect, test, type Page } from "@playwright/test";
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

test("runs real wasm agent turn and restores workspace after reload", async ({
  page,
}) => {
  await openConfiguredApp(page, "restore");
  await sendPrompt(page, "Run the complete browser runtime e2e.", 3);
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
    page.getByRole("button", {
      name: "Run the complete browser runtime e2e.",
      exact: true,
    }),
  ).toBeVisible();
  await expect.poll(() => latestOpfsSnapshotCount(page)).toBeGreaterThan(0);

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
    page.getByRole("button", {
      name: "Run the complete browser runtime e2e.",
      exact: true,
    }),
  ).toBeVisible();

  await sendPrompt(page, "Verify restored workspace file.", 1);
  await expect(
    restoredTranscript.filter({ hasText: "Restore verified." }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.locator("pre").filter({ hasText: "E2E note" }).first(),
  ).toBeVisible();
});

test("restores nested large and deleted files from OPFS snapshot", async ({
  page,
}) => {
  await openConfiguredApp(page, "snapshot-edge");
  await sendPrompt(page, "Mutate workspace restore edge cases.", 1);
  await expect(
    page
      .locator("article")
      .filter({ hasText: "Workspace edge mutation complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => latestOpfsSnapshotCount(page)).toBeGreaterThan(0);

  await page.reload();
  await expect(
    page
      .locator("article")
      .filter({ hasText: "Workspace edge mutation complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await sendPrompt(page, "Verify restore edge workspace.", 1);
  await expect(
    page.locator("article").filter({
      hasText: "Workspace edge restore verified.",
    }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.locator("pre").filter({ hasText: "edge restore ok" }).first(),
  ).toBeVisible();
});

test("restores an empty OPFS workspace snapshot", async ({ page }) => {
  await openConfiguredApp(page, "snapshot-empty");
  await sendPrompt(page, "Create empty workspace snapshot.", 1);
  await expect(
    page
      .locator("article")
      .filter({ hasText: "Empty workspace snapshot created." }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => latestOpfsSnapshotCount(page)).toBeGreaterThan(0);

  await page.reload();
  await expect(
    page
      .locator("article")
      .filter({ hasText: "Empty workspace snapshot created." }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await sendPrompt(page, "Verify empty workspace restore.", 1);
  await expect(
    page.locator("article").filter({
      hasText: "Empty workspace restore verified.",
    }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.locator("pre").filter({ hasText: "empty restore ok" }).first(),
  ).toBeVisible();
});

test("restores a large binary file from OPFS snapshot", async ({ page }) => {
  await openConfiguredApp(page, "snapshot-binary");
  await sendPrompt(page, "Create binary workspace snapshot.", 1);
  await expect(
    page
      .locator("article")
      .filter({ hasText: "Binary workspace snapshot created." }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => latestOpfsSnapshotCount(page)).toBeGreaterThan(0);

  await page.reload();
  await expect(
    page
      .locator("article")
      .filter({ hasText: "Binary workspace snapshot created." }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await sendPrompt(page, "Verify binary workspace restore.", 1);
  await expect(
    page.locator("article").filter({
      hasText: "Binary workspace restore verified.",
    }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.locator("pre").filter({ hasText: "binary restore ok" }).first(),
  ).toBeVisible();
});

test("keeps separate sessions in the history list", async ({ page }) => {
  await openConfiguredApp(page, "history");
  await sendPrompt(page, "Create first history session.", 1);
  await expect(
    page.locator("article").filter({ hasText: "First history complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });

  await page.getByRole("button", { name: "New session" }).click();
  await expect(
    page.locator("article").filter({ hasText: "First history complete." }),
  ).toHaveCount(0, { timeout: 60_000 });
  await sendPrompt(page, "Create isolated second session.", 1);
  await expect(
    page.locator("article").filter({ hasText: "Second complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByRole("button", {
      name: "Create first history session.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Create isolated second session.",
      exact: true,
    }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Create first history session.", exact: true })
    .click();
  await expect(
    page.locator("article").filter({ hasText: "First history complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });

  await page
    .getByRole("button", {
      name: "Create isolated second session.",
      exact: true,
    })
    .click();
  await expect(
    page.locator("article").filter({ hasText: "Second complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });
});

test("orders recently updated sessions first in the history list", async ({
  page,
}) => {
  await openConfiguredApp(page, "history-order");
  await sendPrompt(page, "Create first history session.", 1);
  await expect(
    page.locator("article").filter({ hasText: "First history complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });

  await page.getByRole("button", { name: "New session" }).click();
  await sendPrompt(page, "Create isolated second session.", 1);
  await expect(
    page.locator("article").filter({ hasText: "Second complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });

  await expect(historyTitles(page)).resolves.toEqual([
    "Create isolated second session.",
    "Create first history session.",
  ]);

  await page
    .getByRole("button", { name: "Create first history session.", exact: true })
    .click();
  await sendPrompt(page, "Refresh first history session.", 1);
  await expect(
    page.locator("article").filter({ hasText: "First history refreshed." }),
  ).toBeVisible({
    timeout: 60_000,
  });

  await expect(historyTitles(page)).resolves.toEqual([
    "Create first history session.",
    "Create isolated second session.",
  ]);
});

test("renames sessions in the history list and persists after reload", async ({
  page,
}) => {
  await openConfiguredApp(page, "history-rename");
  await sendPrompt(page, "Create first history session.", 1);
  await expect(
    page.locator("article").filter({ hasText: "First history complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });

  await page
    .getByRole("button", { name: "Rename Create first history session." })
    .click();
  await page
    .getByRole("textbox", { name: "Rename Create first history session." })
    .fill("Renamed history session");
  await page.getByRole("button", { name: "Save session title" }).click();
  await expect(
    page.getByRole("button", {
      name: "Renamed history session",
      exact: true,
    }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByRole("button", {
      name: "Create first history session.",
      exact: true,
    }),
  ).toHaveCount(0);

  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Renamed history session",
      exact: true,
    }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await page
    .getByRole("button", {
      name: "Renamed history session",
      exact: true,
    })
    .click();
  await expect(
    page.locator("article").filter({ hasText: "First history complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });
});

test("serializes rapid history restores without corrupting workspace", async ({
  page,
}) => {
  await openConfiguredApp(page, "history-concurrent");
  await sendPrompt(page, "Create first history session.", 1);
  await expect(
    page.locator("article").filter({ hasText: "First history complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });

  await page.getByRole("button", { name: "New session" }).click();
  await sendPrompt(page, "Create isolated second session.", 1);
  await expect(
    page.locator("article").filter({ hasText: "Second complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect
    .poll(() => latestOpfsSnapshotCount(page))
    .toBeGreaterThanOrEqual(2);

  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Create first history session.",
      exact: true,
    }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("button", {
      name: "Create isolated second session.",
      exact: true,
    }),
  ).toBeVisible({ timeout: 60_000 });

  await page
    .getByRole("button", {
      name: "Create first history session.",
      exact: true,
    })
    .dispatchEvent("click");
  await page
    .getByRole("button", {
      name: "Create isolated second session.",
      exact: true,
    })
    .dispatchEvent("click");

  await expect(
    page.locator("article").filter({ hasText: "Second complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.locator("article").filter({ hasText: "First history complete." }),
  ).toHaveCount(0, { timeout: 60_000 });

  await sendPrompt(page, "Verify concurrent second history restore.", 1);
  await expect(
    page
      .locator("article")
      .filter({ hasText: "Concurrent second restore verified." }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.locator("pre").filter({ hasText: "second restore ok" }).first(),
  ).toBeVisible();
});

test("shows restore errors for corrupt and missing OPFS snapshots", async ({
  page,
}) => {
  await openConfiguredApp(page, "snapshot-fallback");
  await sendPrompt(page, "Create snapshot fallback seed.", 1);
  await expect(
    page.locator("article").filter({ hasText: "Fallback seed complete." }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => latestOpfsSnapshotCount(page)).toBeGreaterThan(0);

  await corruptLatestOpfsSnapshots(page);
  await page.reload();
  await expect(
    page.getByText(/workspace snapshot (restore failed|missing)/i),
  ).toBeVisible({
    timeout: 60_000,
  });

  await deleteLatestOpfsSnapshots(page);
  await expect.poll(() => latestOpfsSnapshotCount(page)).toBe(0);
  await page.reload();
  await expect(
    page.getByText(/workspace snapshot (restore failed|missing)/i),
  ).toBeVisible({
    timeout: 60_000,
  });
});

async function openConfiguredApp(page: Page, caseName: string) {
  const dbName = [
    "browser-codex-e2e",
    caseName,
    Date.now(),
    Math.random().toString(36).slice(2),
    "sqlite3",
  ].join("-");
  await page.goto(`${appUrl}/?db=${encodeURIComponent(dbName)}`);
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);

  await page.getByRole("textbox", { name: "Responses URL" }).fill(providerUrl);
  await page.getByRole("textbox", { name: "API Key" }).fill("sk-e2e");
  await page.getByRole("textbox", { name: "Model" }).fill("e2e-model");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("textbox", { name: "Agent prompt" })).toBeEnabled(
    {
      timeout: 60_000,
    },
  );
}

async function sendPrompt(page: Page, text: string, approvalCount: number) {
  const prompt = page.getByRole("textbox", { name: "Agent prompt" });
  await expect(prompt).toBeEnabled({ timeout: 60_000 });
  await prompt.fill(text);
  await expect(prompt).toHaveValue(text);
  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeEnabled({ timeout: 60_000 });
  await send.click();

  for (let approval = 0; approval < approvalCount; approval += 1) {
    await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole("button", { name: "Approve" }).click();
  }
}

async function latestOpfsSnapshotCount(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const files: Array<{ path: string; size: number }> = [];
    await visit(root, "", files);
    return files.filter(
      (file) => file.path.endsWith("/latest.wcsnap") && file.size > 0,
    ).length;

    async function visit(
      directory: FileSystemDirectoryHandle,
      prefix: string,
      output: Array<{ path: string; size: number }>,
    ) {
      for await (const [name, handle] of (directory as any).entries()) {
        const path = `${prefix}/${name}`;
        if (handle.kind === "directory") {
          await visit(handle as FileSystemDirectoryHandle, path, output);
        } else {
          const file = await (handle as FileSystemFileHandle).getFile();
          output.push({ path, size: file.size });
        }
      }
    }
  });
}

async function corruptLatestOpfsSnapshots(
  page: import("@playwright/test").Page,
) {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle("browser-codex");
    const workspaces = await app.getDirectoryHandle("workspaces");
    for await (const [, handle] of (workspaces as any).entries()) {
      if (handle.kind !== "directory") continue;
      const snapshot = await (
        handle as FileSystemDirectoryHandle
      ).getFileHandle("latest.wcsnap", { create: true });
      const writable = await snapshot.createWritable();
      await writable.write(
        new TextEncoder().encode("not a webcontainer snapshot"),
      );
      await writable.close();
    }
  });
}

async function deleteLatestOpfsSnapshots(
  page: import("@playwright/test").Page,
) {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle("browser-codex");
    try {
      await app.removeEntry("workspaces", { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) {
        throw error;
      }
    }
  });
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

    const body = JSON.parse(await readRequestBody(request)) as {
      input?: Array<Record<string, unknown>>;
    };
    const input = body.input ?? [];
    const { endTurn, output } = providerResponseForInput(input);

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

function providerResponseForInput(input: Array<Record<string, unknown>>) {
  if (requestIncludes(input, "Verify restored workspace file.")) {
    if (!hasToolOutput(input, "restore-read")) {
      return {
        endTurn: false,
        output: [
          functionCall("restore-read", "exec_command", {
            cmd: "node -e \"console.log(require('fs').readFileSync('session.md','utf8'))\"",
            workdir: "/workspace",
            yield_time_ms: 1000,
            max_output_tokens: 2000,
          }),
        ],
      };
    }
    return { endTurn: true, output: [assistantMessage("Restore verified.")] };
  }

  if (requestIncludes(input, "Verify restore edge workspace.")) {
    if (!hasToolOutput(input, "edge-read")) {
      return {
        endTurn: false,
        output: [
          functionCall("edge-read", "exec_command", {
            cmd: "node -e \"const fs=require('fs');const nested=fs.readFileSync('nested/deep/file.txt','utf8').trim();const big=fs.readFileSync('big.txt','utf8');if(nested!=='Nested restore note')throw new Error('nested mismatch');if(big.length<8000)throw new Error('big too small '+big.length);if(fs.existsSync('test.js'))throw new Error('test.js still exists');console.log('edge restore ok '+big.length);\"",
            workdir: "/workspace",
            yield_time_ms: 1000,
            max_output_tokens: 2000,
          }),
        ],
      };
    }
    return {
      endTurn: true,
      output: [assistantMessage("Workspace edge restore verified.")],
    };
  }

  if (requestIncludes(input, "Mutate workspace restore edge cases.")) {
    if (!hasToolOutput(input, "edge-patch")) {
      return {
        endTurn: false,
        output: [
          customToolCall("edge-patch", "apply_patch", edgeWorkspacePatch()),
        ],
      };
    }
    return {
      endTurn: true,
      output: [assistantMessage("Workspace edge mutation complete.")],
    };
  }

  if (requestIncludes(input, "Verify empty workspace restore.")) {
    if (!hasToolOutput(input, "empty-read")) {
      return {
        endTurn: false,
        output: [
          functionCall("empty-read", "exec_command", {
            cmd: "node -e \"const fs=require('fs');const entries=fs.readdirSync('.');if(entries.length!==0)throw new Error('workspace not empty: '+entries.join(','));console.log('empty restore ok');\"",
            workdir: "/workspace",
            yield_time_ms: 1000,
            max_output_tokens: 2000,
          }),
        ],
      };
    }
    return {
      endTurn: true,
      output: [assistantMessage("Empty workspace restore verified.")],
    };
  }

  if (requestIncludes(input, "Create empty workspace snapshot.")) {
    if (!hasToolOutput(input, "empty-patch")) {
      return {
        endTurn: false,
        output: [
          customToolCall("empty-patch", "apply_patch", emptyWorkspacePatch()),
        ],
      };
    }
    return {
      endTurn: true,
      output: [assistantMessage("Empty workspace snapshot created.")],
    };
  }

  if (requestIncludes(input, "Verify binary workspace restore.")) {
    if (!hasToolOutput(input, "binary-read")) {
      return {
        endTurn: false,
        output: [
          functionCall("binary-read", "exec_command", {
            cmd: "node -e \"const fs=require('fs');const crypto=require('crypto');const data=fs.readFileSync('binary.dat');const hash=crypto.createHash('sha256').update(data).digest('hex');const expected='06b7bbfb7824aa03382051691630eb26de85102d1b08a81e907ec0744cd8a286';if(data.length!==1048576)throw new Error('size '+data.length);if(hash!==expected)throw new Error('hash '+hash);console.log('binary restore ok '+data.length+' '+hash.slice(0,12));\"",
            workdir: "/workspace",
            yield_time_ms: 1000,
            max_output_tokens: 2000,
          }),
        ],
      };
    }
    return {
      endTurn: true,
      output: [assistantMessage("Binary workspace restore verified.")],
    };
  }

  if (requestIncludes(input, "Create binary workspace snapshot.")) {
    if (!hasToolOutput(input, "binary-write")) {
      return {
        endTurn: false,
        output: [
          functionCall("binary-write", "exec_command", {
            cmd: "node -e \"const fs=require('fs');const crypto=require('crypto');const data=Buffer.alloc(1048576);for(let i=0;i<data.length;i++)data[i]=(i*31+7)&255;fs.writeFileSync('binary.dat',data);const hash=crypto.createHash('sha256').update(data).digest('hex');console.log('binary snapshot seed '+data.length+' '+hash.slice(0,12));\"",
            workdir: "/workspace",
            yield_time_ms: 1000,
            max_output_tokens: 2000,
          }),
        ],
      };
    }
    return {
      endTurn: true,
      output: [assistantMessage("Binary workspace snapshot created.")],
    };
  }

  if (requestIncludes(input, "Verify concurrent second history restore.")) {
    if (!hasToolOutput(input, "concurrent-second-read")) {
      return {
        endTurn: false,
        output: [
          functionCall("concurrent-second-read", "exec_command", {
            cmd: "node -e \"const fs=require('fs');const second=fs.readFileSync('second.md','utf8').trim();if(second!=='Second session note')throw new Error('second mismatch');if(fs.existsSync('first.md'))throw new Error('first leaked into second workspace');console.log('second restore ok');\"",
            workdir: "/workspace",
            yield_time_ms: 1000,
            max_output_tokens: 2000,
          }),
        ],
      };
    }
    return {
      endTurn: true,
      output: [assistantMessage("Concurrent second restore verified.")],
    };
  }

  if (requestIncludes(input, "Refresh first history session.")) {
    if (!hasToolOutput(input, "first-history-refresh")) {
      return {
        endTurn: false,
        output: [
          customToolCall(
            "first-history-refresh",
            "apply_patch",
            "*** Begin Patch\n*** Update File: /workspace/first.md\n@@\n First history note\n+Refreshed first history note\n*** End Patch\n",
          ),
        ],
      };
    }
    return {
      endTurn: true,
      output: [assistantMessage("First history refreshed.")],
    };
  }

  if (requestIncludes(input, "Create first history session.")) {
    if (!hasToolOutput(input, "first-history-patch")) {
      return {
        endTurn: false,
        output: [
          customToolCall(
            "first-history-patch",
            "apply_patch",
            "*** Begin Patch\n*** Add File: /workspace/first.md\n+First history note\n*** End Patch\n",
          ),
        ],
      };
    }
    return {
      endTurn: true,
      output: [assistantMessage("First history complete.")],
    };
  }

  if (requestIncludes(input, "Create isolated second session.")) {
    if (!hasToolOutput(input, "second-patch")) {
      return {
        endTurn: false,
        output: [
          customToolCall(
            "second-patch",
            "apply_patch",
            "*** Begin Patch\n*** Add File: /workspace/second.md\n+Second session note\n*** End Patch\n",
          ),
        ],
      };
    }
    return { endTurn: true, output: [assistantMessage("Second complete.")] };
  }

  if (requestIncludes(input, "Create snapshot fallback seed.")) {
    if (!hasToolOutput(input, "fallback-patch")) {
      return {
        endTurn: false,
        output: [
          customToolCall(
            "fallback-patch",
            "apply_patch",
            "*** Begin Patch\n*** Add File: /workspace/fallback.md\n+Fallback seed note\n*** End Patch\n",
          ),
        ],
      };
    }
    return {
      endTurn: true,
      output: [assistantMessage("Fallback seed complete.")],
    };
  }

  if (!hasToolOutput(input, "exec-1")) {
    return {
      endTurn: false,
      output: [
        functionCall("exec-1", "exec_command", {
          cmd: "node -e \"console.log('exec ok')\"",
          workdir: "/workspace",
          yield_time_ms: 1000,
          max_output_tokens: 2000,
        }),
      ],
    };
  }

  if (!hasToolOutput(input, "patch-1")) {
    return {
      endTurn: false,
      output: [
        customToolCall(
          "patch-1",
          "apply_patch",
          "*** Begin Patch\n*** Update File: /workspace/session.md\n@@\n # Browser Codex Session\n \n+E2E note\n*** End Patch\n",
        ),
      ],
    };
  }

  if (!hasToolOutput(input, "exec-2")) {
    return {
      endTurn: false,
      output: [
        functionCall("exec-2", "exec_command", {
          cmd: "npm test",
          workdir: "/workspace",
          yield_time_ms: 1000,
          max_output_tokens: 2000,
        }),
      ],
    };
  }

  return { endTurn: true, output: [assistantMessage("E2E complete.")] };
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

function customToolCall(callId: string, name: string, input: string) {
  return {
    type: "custom_tool_call",
    call_id: callId,
    name,
    input,
  };
}

function assistantMessage(text: string) {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

function hasToolOutput(input: Array<Record<string, unknown>>, callId: string) {
  return input.some(
    (item) => item.call_id === callId && isToolOutput(item.type),
  );
}

function requestIncludes(
  input: Array<Record<string, unknown>>,
  needle: string,
) {
  return input.some((item) => JSON.stringify(item).includes(needle));
}

function isToolOutput(type: unknown) {
  return type === "function_call_output" || type === "custom_tool_call_output";
}

function edgeWorkspacePatch() {
  const bigLines = Array.from(
    { length: 128 },
    (_value, index) =>
      `+edge line ${String(index).padStart(3, "0")} ${"x".repeat(72)}`,
  ).join("\n");
  return [
    "*** Begin Patch",
    "*** Add File: /workspace/nested/deep/file.txt",
    "+Nested restore note",
    "*** Add File: /workspace/big.txt",
    bigLines,
    "*** Delete File: /workspace/test.js",
    "*** End Patch",
    "",
  ].join("\n");
}

function emptyWorkspacePatch() {
  return [
    "*** Begin Patch",
    "*** Delete File: /workspace/package.json",
    "*** Delete File: /workspace/session.md",
    "*** Delete File: /workspace/test.js",
    "*** End Patch",
    "",
  ].join("\n");
}

async function historyTitles(page: Page) {
  return page
    .locator("aside button")
    .evaluateAll((buttons) =>
      buttons
        .map((button) => button.textContent?.trim() ?? "")
        .filter((text) => text.length > 0),
    );
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
