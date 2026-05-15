import type {
  AgentTrace,
  ApprovalDecision,
  ApprovalPrompt,
  BrowserCodexRuntime,
  ProviderConfig,
  RuntimeSession,
} from "@browser-codex/browser-runtime";
import { Badge } from "@browser-codex/ui/badge";
import { Button } from "@browser-codex/ui/button";
import { Input } from "@browser-codex/ui/input";
import { Textarea } from "@browser-codex/ui/textarea";
import {
  IconBolt,
  IconCode,
  IconLoader2,
  IconPlus,
  IconRefresh,
  IconSend,
} from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export const Route = createFileRoute("/")({
  component: AgentChat,
});

type RuntimeModule = typeof import("@browser-codex/browser-runtime");
type PendingApproval = {
  prompt: ApprovalPrompt;
  resolve: (decision: ApprovalDecision) => void;
};

const providerConfigStorageKey = "browser-codex.provider-config";
const emptyProviderDraft: ProviderConfig = {
  apiKey: "",
  baseUrl: "",
  model: "qwen3.5-flash",
};

function AgentChat() {
  const moduleRef = useRef<RuntimeModule | undefined>(undefined);
  const runtimeRef = useRef<BrowserCodexRuntime | undefined>(undefined);
  const [providerDraft, setProviderDraft] = useState(emptyProviderDraft);
  const [providerConfig, setProviderConfig] = useState<ProviderConfig>();
  const [session, setSession] = useState<RuntimeSession>();
  const [sessions, setSessions] = useState<
    Array<{ id: string; title: string }>
  >([]);
  const [pendingApproval, setPendingApproval] =
    useState<PendingApproval | null>(null);
  const [input, setInput] = useState("");
  const [errorText, setErrorText] = useState("");
  const [isBooting, setIsBooting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const trace = session?.messages
    .toReversed()
    .find((message) => message.trace)?.trace;
  const status = useMemo(() => {
    if (isBooting) return "booting";
    if (isRunning) return "running";
    return summarizeTrace(trace);
  }, [isBooting, isRunning, trace]);
  const canChat = providerConfig !== undefined && session !== undefined;

  const ensureRuntime = useCallback(async () => {
    if (providerConfig === undefined) {
      throw new Error("Provider config is required.");
    }
    setIsBooting(true);
    try {
      moduleRef.current ??= await import("@browser-codex/browser-runtime");
      if (runtimeRef.current === undefined) {
        runtimeRef.current = moduleRef.current.createRuntime({
          provider: providerConfig,
          wasmJsUrl: "/wasm/codex-browser-core/codex_browser_core.js",
          wasmBinaryUrl: "/wasm/codex-browser-core/codex_browser_core_bg.wasm",
          databasePath: browserDatabasePath(),
          approvalHandler: (prompt) =>
            new Promise<ApprovalDecision>((resolve) => {
              setPendingApproval({ prompt, resolve });
            }),
        });
      } else {
        runtimeRef.current.setProvider(providerConfig);
      }
      await runtimeRef.current.init();
      return runtimeRef.current;
    } finally {
      setIsBooting(false);
    }
  }, [providerConfig]);

  const refreshSessions = useCallback(async () => {
    if (providerConfig === undefined) return;
    const runtime = await ensureRuntime();
    const summaries = await runtime.listSessions();
    setSessions(summaries);
    if (session === undefined) {
      const next =
        summaries[0] !== undefined
          ? await runtime.loadSession(summaries[0].id)
          : await runtime.createSession();
      setSession(next);
      setSessions(await runtime.listSessions());
    }
  }, [ensureRuntime, providerConfig, session]);

  useEffect(() => {
    const stored = readProviderConfig();
    if (stored !== undefined) {
      setProviderConfig(stored);
      setProviderDraft(stored);
    }
  }, []);

  useEffect(() => {
    if (providerConfig !== undefined) {
      void refreshSessions().catch((error) => {
        console.error("Browser runtime init failed", error);
        setErrorText(error instanceof Error ? error.message : String(error));
      });
    }
  }, [providerConfig, refreshSessions]);

  async function saveProviderConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextConfig = normalizeProviderConfig(providerDraft);
    if (nextConfig === undefined) return;
    localStorage.setItem(providerConfigStorageKey, JSON.stringify(nextConfig));
    setProviderConfig(nextConfig);
    setProviderDraft(nextConfig);
  }

  async function newSession() {
    const runtime = await ensureRuntime();
    setSession(await runtime.createSession());
    setSessions(await runtime.listSessions());
  }

  async function loadSession(id: string) {
    const runtime = await ensureRuntime();
    setSession(await runtime.loadSession(id));
  }

  async function submit() {
    const text = input.trim();
    if (text.length === 0 || isRunning || !canChat) return;
    setInput("");
    setErrorText("");
    setIsRunning(true);
    try {
      const runtime = await ensureRuntime();
      const result = await runtime.runTurn(text);
      setSession(result.session);
      setSessions(await runtime.listSessions());
    } catch (error) {
      console.error("Browser runtime turn failed", error);
      setErrorText(errorToText(error));
    } finally {
      setIsRunning(false);
    }
  }

  function resolveApproval(decision: ApprovalDecision) {
    pendingApproval?.resolve(decision);
    setPendingApproval(null);
  }

  return (
    <main className="min-h-dvh bg-[var(--codex-shell)] px-4 py-4 text-[var(--codex-text)] md:px-6 md:py-6">
      <div className="mx-auto grid min-h-[calc(100dvh-2rem)] w-full max-w-7xl grid-rows-[auto_1fr] gap-4 md:min-h-[calc(100dvh-3rem)]">
        <header className="flex flex-col gap-3 border border-[var(--mesh-line)] bg-black/20 px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-9 shrink-0 place-items-center border border-[var(--mesh-line)] bg-[var(--codex-panel-raised)] text-[var(--codex-accent)]">
              <IconBolt className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate font-mono text-lg font-bold text-white">
                Browser Codex
              </h1>
              <p className="truncate text-sm text-[var(--codex-muted)]">
                {session?.title ?? "No session"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-[var(--mesh-line)]">
              {status}
            </Badge>
            <Badge
              variant="outline"
              className="border-[var(--mesh-line)] text-[var(--codex-accent)]"
            >
              {providerConfig?.model ?? "provider required"}
            </Badge>
          </div>
        </header>

        <section className="grid min-h-0 gap-4 lg:grid-cols-[260px_minmax(0,1fr)_360px]">
          <aside className="grid min-h-[260px] grid-rows-[auto_1fr] border border-[var(--mesh-line)] bg-[var(--codex-panel)] lg:min-h-0">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--mesh-line)] px-3 py-2">
              <h2 className="font-mono text-sm font-bold text-white">
                History
              </h2>
              <div className="flex gap-1">
                <Button
                  aria-label="Refresh sessions"
                  disabled={providerConfig === undefined || isRunning}
                  onClick={() => void refreshSessions()}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <IconRefresh className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  aria-label="New session"
                  disabled={providerConfig === undefined || isRunning}
                  onClick={() => void newSession()}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <IconPlus className="size-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
            <div className="min-h-0 overflow-y-auto p-2">
              <div className="grid gap-2">
                {sessions.map((item) => (
                  <button
                    className={[
                      "border px-3 py-2 text-left text-sm text-white",
                      item.id === session?.id
                        ? "border-[var(--mesh-line-strong)] bg-white/[0.08]"
                        : "border-[var(--mesh-line)] bg-black/20",
                    ].join(" ")}
                    key={item.id}
                    onClick={() => void loadSession(item.id)}
                    type="button"
                  >
                    {item.title}
                  </button>
                ))}
              </div>
            </div>
          </aside>

          <div className="grid min-h-0 grid-rows-[auto_1fr_auto] border border-[var(--mesh-line)] bg-[var(--codex-panel)]">
            <form
              className="grid gap-3 border-b border-[var(--mesh-line)] bg-black/20 p-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_180px_auto] md:items-end md:p-4"
              onSubmit={saveProviderConfig}
            >
              <ConfigField label="Responses URL">
                <Input
                  aria-label="Responses URL"
                  className="border-[var(--mesh-line)] bg-black/20 font-mono text-sm"
                  onChange={(event) =>
                    setProviderDraft({
                      ...providerDraft,
                      baseUrl: event.target.value,
                    })
                  }
                  value={providerDraft.baseUrl}
                />
              </ConfigField>
              <ConfigField label="API Key">
                <Input
                  aria-label="API Key"
                  className="border-[var(--mesh-line)] bg-black/20 font-mono text-sm"
                  onChange={(event) =>
                    setProviderDraft({
                      ...providerDraft,
                      apiKey: event.target.value,
                    })
                  }
                  type="password"
                  value={providerDraft.apiKey}
                />
              </ConfigField>
              <ConfigField label="Model">
                <Input
                  aria-label="Model"
                  className="border-[var(--mesh-line)] bg-black/20 font-mono text-sm"
                  onChange={(event) =>
                    setProviderDraft({
                      ...providerDraft,
                      model: event.target.value,
                    })
                  }
                  value={providerDraft.model}
                />
              </ConfigField>
              <Button size="sm" type="submit">
                Save
              </Button>
            </form>

            <div className="min-h-0 overflow-y-auto p-3 md:p-4">
              <div className="flex flex-col gap-3">
                {(session?.messages ?? []).map((message) => (
                  <article
                    className={[
                      "max-w-[min(760px,100%)] border px-3 py-2",
                      message.role === "user"
                        ? "ml-auto border-[var(--mesh-line-strong)] bg-white/[0.07]"
                        : "mr-auto border-[var(--mesh-line)] bg-black/25",
                    ].join(" ")}
                    key={message.id}
                  >
                    <div className="mb-1 font-mono text-[11px] text-[var(--codex-muted)] uppercase">
                      {message.role === "user" ? "You" : "Agent"}
                    </div>
                    <p className="text-sm leading-6 break-words whitespace-pre-wrap text-white">
                      {message.text}
                    </p>
                  </article>
                ))}
                {isBooting || isRunning ? (
                  <div className="flex items-center gap-2 border border-[var(--mesh-line)] bg-black/25 px-3 py-2 text-sm text-[var(--codex-muted)]">
                    <IconLoader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                    {isBooting ? "Booting runtime" : "Running turn"}
                  </div>
                ) : null}
                {errorText ? (
                  <div className="border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
                    {errorText}
                  </div>
                ) : null}
              </div>
            </div>

            <form
              className="border-t border-[var(--mesh-line)] bg-black/20 p-3 md:p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Textarea
                aria-label="Agent prompt"
                className="min-h-24 resize-none border-[var(--mesh-line)] bg-black/20 font-mono text-sm text-white placeholder:text-[var(--codex-muted)]"
                disabled={isBooting || isRunning || !canChat}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={onInputKeyDown(() => void submit())}
                value={input}
              />
              <div className="mt-3 flex items-center justify-between gap-2">
                <Button
                  disabled={
                    isBooting ||
                    isRunning ||
                    !canChat ||
                    input.trim().length === 0
                  }
                  size="sm"
                  type="submit"
                >
                  {isRunning ? (
                    <IconLoader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <IconSend className="size-4" aria-hidden="true" />
                  )}
                  Send
                </Button>
                <span className="font-mono text-xs text-[var(--codex-muted)]">
                  Cmd/Ctrl Enter
                </span>
              </div>
            </form>
          </div>

          <aside className="grid min-h-[360px] grid-rows-[auto_1fr] border border-[var(--mesh-line)] bg-[var(--codex-panel)] lg:min-h-0">
            <div className="flex items-center gap-2 border-b border-[var(--mesh-line)] px-3 py-2">
              <IconCode
                className="size-4 text-[var(--codex-accent)]"
                aria-hidden="true"
              />
              <h2 className="font-mono text-sm font-bold text-white">Trace</h2>
            </div>
            <TracePanel trace={trace} />
          </aside>
        </section>
      </div>

      {pendingApproval ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
          <section className="w-full max-w-xl border border-[var(--mesh-line-strong)] bg-[var(--codex-panel)] p-4">
            <h2 className="font-mono text-sm font-bold text-white">
              {pendingApproval.prompt.type === "exec"
                ? "Command Approval"
                : "Patch Approval"}
            </h2>
            <pre className="mt-3 max-h-72 overflow-auto border border-[var(--mesh-line)] bg-black/35 p-3 text-xs leading-5 text-[var(--codex-text)]">
              {pendingApproval.prompt.type === "exec"
                ? pendingApproval.prompt.request.cmd
                : pendingApproval.prompt.request.affected_paths.join("\n")}
            </pre>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                onClick={() =>
                  resolveApproval({ approved: false, reason: "denied in UI" })
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                Deny
              </Button>
              <Button
                onClick={() => resolveApproval({ approved: true })}
                size="sm"
                type="button"
              >
                Approve
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function ConfigField({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <label className="grid gap-1">
      <span className="font-mono text-[11px] text-[var(--codex-muted)] uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

function TracePanel({ trace }: { trace?: AgentTrace }) {
  if (trace === undefined) {
    return (
      <div className="grid place-items-center p-4 text-center text-sm text-[var(--codex-muted)]">
        <span>No trace yet.</span>
      </div>
    );
  }
  return (
    <div className="min-h-0 overflow-y-auto p-3">
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <TraceMetric
          label="model requests"
          value={trace.model_requests.length}
        />
        <TraceMetric label="events" value={trace.events.length} />
        <TraceMetric label="tool outputs" value={trace.tool_outputs.length} />
        <TraceMetric label="files" value={trace.final_files.length} />
      </dl>
      <div className="mt-4 space-y-3">
        <TraceSection title="tool_outputs" value={trace.tool_outputs} />
        <TraceSection title="final_files" value={trace.final_files} />
        <TraceSection title="events" value={trace.events} />
      </div>
    </div>
  );
}

function TraceMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-[var(--mesh-line)] bg-black/20 p-2">
      <dt className="font-mono text-[10px] text-[var(--codex-muted)] uppercase">
        {label}
      </dt>
      <dd className="mt-1 font-mono text-lg font-bold text-white">{value}</dd>
    </div>
  );
}

function TraceSection({ title, value }: { title: string; value: unknown }) {
  return (
    <section>
      <h3 className="mb-1 font-mono text-[11px] text-[var(--codex-muted)] uppercase">
        {title}
      </h3>
      <pre className="max-h-72 overflow-auto border border-[var(--mesh-line)] bg-black/35 p-2 text-[11px] leading-5 text-[var(--codex-text)]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
}

function onInputKeyDown(submit: () => void) {
  return (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };
}

function summarizeTrace(trace: AgentTrace | undefined) {
  if (trace === undefined) return "idle";
  if (trace.tool_outputs.length > 0)
    return `${trace.tool_outputs.length} tool output`;
  return `${trace.events.length} events`;
}

function readProviderConfig() {
  const raw = localStorage.getItem(providerConfigStorageKey);
  if (raw === null) return undefined;
  try {
    return normalizeProviderConfig(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function normalizeProviderConfig(value: unknown): ProviderConfig | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("apiKey" in value) ||
    !("baseUrl" in value) ||
    !("model" in value)
  ) {
    return undefined;
  }
  const apiKey = String(value.apiKey).trim();
  const baseUrl = String(value.baseUrl).trim().replace(/\/$/, "");
  const model = String(value.model).trim();
  return apiKey && baseUrl && model ? { apiKey, baseUrl, model } : undefined;
}

function browserDatabasePath() {
  return new URL(window.location.href).searchParams.get("db") ?? undefined;
}

function errorToText(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
