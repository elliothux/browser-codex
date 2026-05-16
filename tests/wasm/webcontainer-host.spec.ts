import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";

const repoRoot = resolve(import.meta.dirname, "../..");

let viteServer: ViteDevServer;
let baseUrl: string;

test.beforeAll(async () => {
  viteServer = await createServer({
    configFile: false,
    root: repoRoot,
    server: {
      host: "127.0.0.1",
      port: 0,
      headers: {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
      fs: {
        allow: [repoRoot],
      },
    },
  });
  await viteServer.listen();
  const address = viteServer.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Vite host-adapter test server did not bind to a port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await viteServer?.close();
});

test("runs WebContainer HostExec lifecycle operations", async ({ page }) => {
  await page.goto(`${baseUrl}/tests/browser/webcontainer-host.html`);
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(async () => {
    const run = (
      globalThis as typeof globalThis & {
        runWebContainerHostExecLifecycle?: () => Promise<unknown>;
      }
    ).runWebContainerHostExecLifecycle;
    if (run === undefined) {
      throw new Error("host exec lifecycle harness did not load");
    }
    return run();
  });

  expect(result).toMatchObject({
    started: {
      output: expect.stringContaining("ready"),
      process_id: expect.any(Number),
      exit_code: null,
    },
    wrote: {
      output: expect.stringContaining("in:hello"),
      process_id: expect.any(Number),
      exit_code: null,
    },
    exited: {
      output: expect.stringContaining("in:exit"),
      process_id: null,
      exit_code: 0,
    },
    pollAfterExitError: expect.stringContaining("is not running"),
    tty: {
      output: expect.stringContaining("tty-ready"),
      process_id: expect.any(Number),
      exit_code: null,
    },
    pollAfterKillError: expect.stringContaining("is not running"),
  });
});
