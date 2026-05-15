import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const ssrTursoStub = fileURLToPath(
  new URL("./src/lib/ssr-turso-stub.ts", import.meta.url),
);
const ssrWebContainerStub = fileURLToPath(
  new URL("./src/lib/ssr-webcontainer-stub.ts", import.meta.url),
);
const emnapiCore = fileURLToPath(
  new URL(
    "../../node_modules/.bun/@emnapi+core@1.8.1/node_modules/@emnapi/core",
    import.meta.url,
  ),
);
const emnapiRuntime = fileURLToPath(
  new URL(
    "../../node_modules/.bun/@emnapi+runtime@1.8.1/node_modules/@emnapi/runtime",
    import.meta.url,
  ),
);

const browserRuntimeAliases = [
  // Turso database-wasm-common@0.6.0 is built against these exact emnapi
  // versions. Keep the browser bundle aligned with that package boundary.
  {
    find: "@emnapi/core",
    replacement: emnapiCore,
  },
  {
    find: "@emnapi/runtime",
    replacement: emnapiRuntime,
  },
];

const crossOriginIsolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

function crossOriginIsolationPlugin(): Plugin {
  return {
    name: "browser-codex-cross-origin-isolation",
    configureServer(server) {
      server.middlewares.use((_request, response, next) => {
        for (const [name, value] of Object.entries(
          crossOriginIsolationHeaders,
        )) {
          response.setHeader(name, value);
        }
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_request, response, next) => {
        for (const [name, value] of Object.entries(
          crossOriginIsolationHeaders,
        )) {
          response.setHeader(name, value);
        }
        next();
      });
    },
  };
}

export default defineConfig(({ isSsrBuild }) => ({
  optimizeDeps: {
    exclude: [
      "@tursodatabase/database-wasm",
      "@tursodatabase/database-wasm/bundle",
      "@tursodatabase/database-wasm/vite",
    ],
  },
  plugins: [
    crossOriginIsolationPlugin(),
    tanstackStart({ client: { entry: "src/main.tsx" } }),
    tailwindcss(),
    viteReact(),
  ],
  resolve: {
    alias: [
      ...browserRuntimeAliases,
      ...(isSsrBuild
        ? [
            {
              find: "@tursodatabase/database-wasm/bundle",
              replacement: ssrTursoStub,
            },
            {
              find: "@tursodatabase/database-wasm/vite",
              replacement: ssrTursoStub,
            },
            {
              find: "@tursodatabase/database-wasm",
              replacement: ssrTursoStub,
            },
            {
              find: "@webcontainer/api",
              replacement: ssrWebContainerStub,
            },
          ]
        : []),
    ],
  },
  server: {
    forwardConsole: true,
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
}));
