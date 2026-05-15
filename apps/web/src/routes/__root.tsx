import { DialogPortal } from "@browser-codex/ui/dialog-portal";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import type { JSX, ReactNode } from "react";
import { Toaster } from "sonner";
import { queryClient } from "../lib/query-client";
import "../styles.css";

const fontLinks = [
  {
    href: "https://fonts.googleapis.com",
    rel: "preconnect",
  },
  {
    crossOrigin: "anonymous",
    href: "https://fonts.gstatic.com",
    rel: "preconnect",
  },
  {
    href: "https://fonts.googleapis.com/css2?family=Anonymous+Pro:wght@400;700&family=Inter:wght@100..900&display=block",
    rel: "stylesheet",
  },
] satisfies JSX.IntrinsicElements["link"][];

export const Route = createRootRoute({
  component: RootComponent,
  head: () => ({
    links: fontLinks,
    meta: [
      { charSet: "utf-8" },
      {
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
        name: "viewport",
      },
      {
        content: "Browser-hosted Codex wasm agent chat.",
        name: "description",
      },
      { title: "Browser Codex" },
    ],
  }),
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html className="dark" lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          {children}
          <DialogPortal />
          <Toaster
            className="mesh-toaster"
            position="bottom-right"
            toastOptions={{
              style: {
                background: "var(--mesh-panel-raised)",
                border: "1px solid var(--mesh-line)",
                borderRadius: "0px",
                color: "var(--mesh-white)",
                fontFamily: '"Anonymous Pro", ui-monospace, monospace',
              },
            }}
          />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
