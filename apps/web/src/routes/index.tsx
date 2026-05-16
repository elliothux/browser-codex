import type {
  AgentTrace,
  ApprovalDecision,
  ApprovalPrompt,
  BrowserCodexRuntime,
  ProviderConfig,
  RuntimePermissionMode,
  RuntimeSession,
  RuntimeTerminalSession,
  WorkspaceDirectoryEntry,
} from "@browser-codex/browser-runtime";
import { Badge } from "@browser-codex/ui/badge";
import { buttonVariants, type ButtonVariants } from "@browser-codex/ui/button";
import { Textarea } from "@browser-codex/ui/textarea";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  IconCheck,
  IconChevronDown,
  IconFolder,
  IconLoader2,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSend,
  IconSettings,
  IconTerminal2,
  IconX,
} from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { Terminal, useTerminal } from "@wterm/react";
import "@wterm/react/css";
import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
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
type EventsTab = "events" | "tool_outputs";

const providerConfigStorageKey = "browser-codex.provider-config";
const emptyProviderDraft: ProviderConfig = {
  apiKey: "",
  baseUrl: "",
  model: "qwen3.5-flash",
  toolCompatibility: "upstream",
};

function ControlButton({
  className,
  size = "default",
  type = "button",
  variant = "default",
  ...props
}: ComponentPropsWithoutRef<"button"> & ButtonVariants) {
  return (
    <button
      className={buttonVariants({ className, size, variant })}
      type={type}
      {...props}
    />
  );
}

function ControlInput({
  className,
  type,
  ...props
}: ComponentPropsWithoutRef<"input">) {
  return (
    <input
      className={[
        "border-input file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 disabled:bg-input/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 h-10 w-full min-w-0 rounded-none border bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:ring-3 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3 md:text-sm",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      type={type}
      {...props}
    />
  );
}

function AgentChat() {
  const moduleRef = useRef<RuntimeModule | undefined>(undefined);
  const runtimeRef = useRef<BrowserCodexRuntime | undefined>(undefined);
  const runtimeInitRef = useRef<Promise<BrowserCodexRuntime> | undefined>(
    undefined,
  );
  const [runtime, setRuntime] = useState<BrowserCodexRuntime>();
  const [providerDraft, setProviderDraft] = useState(emptyProviderDraft);
  const [providerConfig, setProviderConfig] = useState<ProviderConfig>();
  const [session, setSession] = useState<RuntimeSession>();
  const [sessions, setSessions] = useState<
    Array<{ id: string; title: string }>
  >([]);
  const [pendingApproval, setPendingApproval] =
    useState<PendingApproval | null>(null);
  const [permissionMode, setPermissionMode] =
    useState<RuntimePermissionMode>("default");
  const [input, setInput] = useState("");
  const [errorText, setErrorText] = useState("");
  const [isBooting, setIsBooting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [streamingAssistantText, setStreamingAssistantText] = useState("");
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(
    null,
  );
  const [renameDraft, setRenameDraft] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(true);
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0);

  const trace = session?.messages
    .toReversed()
    .find((message) => message.trace)?.trace;
  const status = useMemo(() => {
    if (isBooting) return "booting";
    if (isRunning) return "running";
    return summarizeTrace(trace);
  }, [isBooting, isRunning, trace]);
  const canChat = providerConfig !== undefined && session !== undefined;

  const refreshWorkspace = useCallback(() => {
    setWorkspaceRefreshKey((current) => current + 1);
  }, []);

  const ensureRuntime = useCallback(async () => {
    if (providerConfig === undefined) {
      throw new Error("Provider config is required.");
    }
    if (runtimeInitRef.current !== undefined) {
      return runtimeInitRef.current;
    }
    runtimeInitRef.current = (async () => {
      setIsBooting(true);
      try {
        moduleRef.current ??= await import("@browser-codex/browser-runtime");
        if (runtimeRef.current === undefined) {
          runtimeRef.current = moduleRef.current.createRuntime({
            provider: providerConfig,
            wasmJsUrl: "/wasm/codex-browser-core/codex_browser_core.js",
            wasmBinaryUrl:
              "/wasm/codex-browser-core/codex_browser_core_bg.wasm",
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
        setRuntime(runtimeRef.current);
        return runtimeRef.current;
      } finally {
        runtimeInitRef.current = undefined;
        setIsBooting(false);
      }
    })();
    return runtimeInitRef.current;
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
      refreshWorkspace();
    }
  }, [ensureRuntime, providerConfig, refreshWorkspace, session]);

  useEffect(() => {
    const stored = readProviderConfig();
    if (stored !== undefined) {
      setProviderConfig(stored);
      setProviderDraft(stored);
      setIsSettingsOpen(false);
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

  function saveProviderConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveProviderConfigFromForm(event.currentTarget);
  }

  function saveProviderConfigFromForm(form: HTMLFormElement) {
    const formData = new FormData(form);
    const nextConfig = normalizeProviderConfig({
      apiKey: formData.get("apiKey"),
      baseUrl: formData.get("baseUrl"),
      model: formData.get("model"),
      toolCompatibility: formData.get("toolCompatibility"),
    });
    if (nextConfig === undefined) return;
    localStorage.setItem(providerConfigStorageKey, JSON.stringify(nextConfig));
    setProviderConfig(nextConfig);
    setProviderDraft(nextConfig);
    setIsSettingsOpen(false);
  }

  async function newSession() {
    const runtime = await ensureRuntime();
    cancelRename();
    setSession(await runtime.createSession());
    setSessions(await runtime.listSessions());
    refreshWorkspace();
  }

  async function loadSession(id: string) {
    const runtime = await ensureRuntime();
    cancelRename();
    setSession(await runtime.loadSession(id));
    refreshWorkspace();
  }

  async function saveRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveRenameDraft();
  }

  async function saveRenameDraft() {
    if (renamingSessionId === null) return;
    const runtime = await ensureRuntime();
    await runtime.renameSession(renamingSessionId, renameDraft);
    setSession(runtime.currentSession());
    setSessions(await runtime.listSessions());
    cancelRename();
  }

  function startRename(id: string, title: string) {
    setRenamingSessionId(id);
    setRenameDraft(title);
  }

  function cancelRename() {
    setRenamingSessionId(null);
    setRenameDraft("");
  }

  async function submit() {
    const text = input.trim();
    if (text.length === 0 || isRunning || !canChat) return;
    setInput("");
    setErrorText("");
    setStreamingAssistantText("");
    setIsRunning(true);
    try {
      const runtime = await ensureRuntime();
      for await (const event of runtime.runTurnStream(text, {
        permissionMode,
      })) {
        if (event.type === "event") {
          const chunk = agentDeltaText(event.event);
          if (chunk.length > 0) {
            setStreamingAssistantText((current) => `${current}${chunk}`);
          }
        } else {
          setSession(event.result.session);
          setSessions(await runtime.listSessions());
          refreshWorkspace();
        }
      }
    } catch (error) {
      console.error("Browser runtime turn failed", error);
      setErrorText(errorToText(error));
    } finally {
      setStreamingAssistantText("");
      setIsRunning(false);
    }
  }

  function resolveApproval(decision: ApprovalDecision) {
    pendingApproval?.resolve(decision);
    setPendingApproval(null);
  }

  return (
    <main className="h-dvh overflow-hidden bg-[var(--codex-shell)] p-4 text-[var(--codex-text)] md:p-5">
      <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
        <aside className="grid min-h-0 grid-rows-[auto_1fr] border border-[var(--mesh-line)] bg-[var(--codex-panel)]">
          <div className="border-b border-[var(--mesh-line)] p-3">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <ControlButton
                className="h-12 justify-start px-4 text-base"
                disabled={providerConfig === undefined || isRunning}
                onClick={() => void newSession()}
                type="button"
              >
                <IconPlus className="size-5" aria-hidden="true" />
                New chat
              </ControlButton>
              <ControlButton
                aria-expanded={isSettingsOpen}
                aria-label="Settings"
                className="size-12"
                onClick={() => setIsSettingsOpen((current) => !current)}
                type="button"
                variant="ghost"
              >
                <IconSettings className="size-5" aria-hidden="true" />
              </ControlButton>
            </div>
            {isSettingsOpen ? (
              <form
                className="mt-3 grid gap-3 border border-[var(--mesh-line)] bg-black/25 p-3"
                onSubmit={saveProviderConfig}
              >
                <ConfigField label="Base URL">
                  <ControlInput
                    aria-label="Responses URL"
                    className="h-9 border-[var(--mesh-line)] bg-black/20 font-mono text-sm"
                    defaultValue={providerDraft.baseUrl}
                    name="baseUrl"
                    onChange={(event) =>
                      setProviderDraft({
                        ...providerDraft,
                        baseUrl: event.target.value,
                      })
                    }
                  />
                </ConfigField>
                <ConfigField label="API key">
                  <ControlInput
                    aria-label="API Key"
                    className="h-9 border-[var(--mesh-line)] bg-black/20 font-mono text-sm"
                    defaultValue={providerDraft.apiKey}
                    name="apiKey"
                    onChange={(event) =>
                      setProviderDraft({
                        ...providerDraft,
                        apiKey: event.target.value,
                      })
                    }
                    type="password"
                  />
                </ConfigField>
                <ConfigField label="Model">
                  <ControlInput
                    aria-label="Model"
                    className="h-9 border-[var(--mesh-line)] bg-black/20 font-mono text-sm"
                    defaultValue={providerDraft.model}
                    name="model"
                    onChange={(event) =>
                      setProviderDraft({
                        ...providerDraft,
                        model: event.target.value,
                      })
                    }
                  />
                </ConfigField>
                <ConfigField label="Tool mode">
                  <select
                    aria-label="Tool mode"
                    className="h-9 w-full border border-[var(--mesh-line)] bg-black/20 px-2.5 font-mono text-sm text-white outline-none"
                    defaultValue={providerDraft.toolCompatibility ?? "upstream"}
                    name="toolCompatibility"
                    onChange={(event) =>
                      setProviderDraft({
                        ...providerDraft,
                        toolCompatibility: event.target
                          .value as ProviderConfig["toolCompatibility"],
                      })
                    }
                  >
                    <option value="upstream">Upstream tools</option>
                    <option value="applyPatchFunction">
                      Function apply_patch
                    </option>
                  </select>
                </ConfigField>
                <ControlButton
                  className="w-full"
                  onClick={(event) => {
                    const form = event.currentTarget.form;
                    if (form !== null) {
                      saveProviderConfigFromForm(form);
                    }
                  }}
                  size="sm"
                  type="button"
                >
                  Save
                </ControlButton>
              </form>
            ) : null}
          </div>

          <div className="min-h-0 overflow-y-auto p-2">
            <div className="grid gap-2">
              {sessions.map((item) => {
                const isActive = item.id === session?.id;
                return (
                  <div
                    className={[
                      "flex min-w-0 items-center gap-1 border px-2 py-1.5 text-sm text-white",
                      isActive
                        ? "border-[var(--mesh-line-strong)] bg-white/[0.08]"
                        : "border-[var(--mesh-line)] bg-black/20",
                    ].join(" ")}
                    key={item.id}
                  >
                    {renamingSessionId === item.id ? (
                      <form
                        className="flex min-w-0 flex-1 items-center gap-1"
                        onSubmit={(event) => void saveRename(event)}
                      >
                        <ControlInput
                          aria-label={`Rename ${item.title}`}
                          autoFocus
                          className="h-8 min-w-0 flex-1 border-[var(--mesh-line)] bg-black/20 font-mono text-xs"
                          disabled={isRunning}
                          onChange={(event) =>
                            setRenameDraft(event.target.value)
                          }
                          value={renameDraft}
                        />
                        <ControlButton
                          aria-label="Save session title"
                          disabled={isRunning}
                          onClick={() => void saveRenameDraft()}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          <IconCheck className="size-4" aria-hidden="true" />
                        </ControlButton>
                        <ControlButton
                          aria-label="Cancel session rename"
                          disabled={isRunning}
                          onClick={cancelRename}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          <IconX className="size-4" aria-hidden="true" />
                        </ControlButton>
                      </form>
                    ) : (
                      <>
                        <button
                          className="min-w-0 flex-1 truncate text-left"
                          disabled={isRunning}
                          onClick={() => void loadSession(item.id)}
                          type="button"
                        >
                          {item.title}
                        </button>
                        <ControlButton
                          aria-label={`Rename ${item.title}`}
                          disabled={isRunning}
                          onClick={() => startRename(item.id, item.title)}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          <IconPencil className="size-4" aria-hidden="true" />
                        </ControlButton>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </aside>

        <section className="grid min-h-0 gap-4 lg:grid-rows-[minmax(0,1fr)_260px]">
          <div className="grid min-h-0 grid-rows-[auto_1fr_auto] border border-[var(--mesh-line)] bg-[var(--codex-panel)]">
            <header className="flex min-h-14 items-center justify-between gap-3 border-b border-[var(--mesh-line)] bg-black/20 px-4">
              <div className="min-w-0">
                <h1 className="truncate font-mono text-sm font-bold text-white">
                  Browser Codex
                </h1>
                <p className="truncate text-xs text-[var(--codex-muted)]">
                  {session?.title ?? "No session"}
                </p>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant="outline" className="border-[var(--mesh-line)]">
                  {status}
                </Badge>
                <Badge
                  variant="outline"
                  className="hidden border-[var(--mesh-line)] text-[var(--codex-accent)] sm:inline-flex"
                >
                  {providerConfig?.model ?? "provider required"}
                </Badge>
              </div>
            </header>

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
                {streamingAssistantText ? (
                  <article className="mr-auto max-w-[min(760px,100%)] border border-[var(--mesh-line)] bg-black/25 px-3 py-2">
                    <div className="mb-1 font-mono text-[11px] text-[var(--codex-muted)] uppercase">
                      Agent
                    </div>
                    <p className="text-sm leading-6 break-words whitespace-pre-wrap text-white">
                      {streamingAssistantText}
                    </p>
                  </article>
                ) : null}
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
                {session?.workspaceRestoreError ? (
                  <div className="border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-100">
                    {session.workspaceRestoreError}
                  </div>
                ) : null}
              </div>
            </div>

            <form
              className="border-t border-[var(--mesh-line)] bg-black/20"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Textarea
                aria-label="Agent prompt"
                className="min-h-28 resize-none border-0 bg-transparent p-4 font-mono text-sm text-white shadow-none placeholder:text-[var(--codex-muted)] focus-visible:ring-0"
                disabled={isBooting || isRunning || !canChat}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={onInputKeyDown(() => void submit())}
                value={input}
              />
              <div className="flex items-center justify-between gap-2 border-t border-[var(--mesh-line)] px-3 py-2">
                <label className="relative inline-flex min-w-0 items-center">
                  <span className="sr-only">Permission mode</span>
                  <select
                    aria-label="Permission mode"
                    className="h-9 max-w-[220px] appearance-none truncate border border-transparent bg-transparent py-1 pr-8 pl-2 font-mono text-sm text-white outline-none hover:border-[var(--mesh-line)] focus:border-[var(--mesh-focus)]"
                    disabled={isRunning}
                    onChange={(event) =>
                      setPermissionMode(
                        event.target.value as RuntimePermissionMode,
                      )
                    }
                    value={permissionMode}
                  >
                    <option value="default">Default permissions</option>
                    <option value="auto-review">Auto-review</option>
                    <option value="full-access">Full access</option>
                  </select>
                  <IconChevronDown
                    className="pointer-events-none absolute right-2 size-4 text-[var(--codex-muted)]"
                    aria-hidden="true"
                  />
                </label>
                <ControlButton
                  disabled={
                    isBooting ||
                    isRunning ||
                    !canChat ||
                    input.trim().length === 0
                  }
                  onClick={() => void submit()}
                  size="sm"
                  type="button"
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
                </ControlButton>
              </div>
            </form>
          </div>

          <TerminalPanel runtime={runtime} sessionId={session?.id} />
        </section>

        <aside className="grid min-h-0 gap-4 lg:grid-rows-[minmax(0,1fr)_minmax(220px,0.8fr)]">
          <section className="grid min-h-0 grid-rows-[auto_1fr] border border-[var(--mesh-line)] bg-[var(--codex-panel)]">
            <div className="flex min-h-12 items-center justify-between gap-2 border-b border-[var(--mesh-line)] bg-black/20 px-3">
              <div className="flex min-w-0 items-center gap-2">
                <IconFolder
                  className="size-4 text-[var(--codex-accent)]"
                  aria-hidden="true"
                />
                <h2 className="truncate font-mono text-sm font-bold text-white">
                  Workspace
                </h2>
              </div>
              <ControlButton
                aria-label="Refresh files"
                disabled={runtime === undefined}
                onClick={refreshWorkspace}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <IconRefresh className="size-4" aria-hidden="true" />
              </ControlButton>
            </div>
            <WorkspaceFileTree
              refreshKey={workspaceRefreshKey}
              runtime={runtime}
              sessionId={session?.id}
            />
          </section>

          <section className="min-h-0 overflow-hidden border border-[var(--mesh-line)] bg-[var(--codex-panel)]">
            <EventsPanel trace={trace} />
          </section>
        </aside>
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
              <ControlButton
                onClick={() =>
                  resolveApproval({ approved: false, reason: "denied in UI" })
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                Deny
              </ControlButton>
              <ControlButton
                onClick={() => resolveApproval({ approved: true })}
                size="sm"
                type="button"
              >
                Approve
              </ControlButton>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function TerminalPanel({
  runtime,
  sessionId,
}: {
  runtime?: BrowserCodexRuntime;
  sessionId?: string;
}) {
  const { ref: terminalRef, write: terminalWrite } = useTerminal();
  const shellRef = useRef<RuntimeTerminalSession | undefined>(undefined);
  const [isReady, setIsReady] = useState(false);
  const [status, setStatus] = useState("waiting");

  useEffect(() => {
    if (!isReady || runtime === undefined || sessionId === undefined) {
      return;
    }
    let cancelled = false;
    let shell: RuntimeTerminalSession | undefined;
    const cols = terminalRef.current?.instance?.cols ?? 100;
    const rows = terminalRef.current?.instance?.rows ?? 18;
    terminalWrite("\x1b[2J\x1b[H");
    setStatus("starting");
    void runtime
      .startTerminal({ cols, cwd: "/workspace", rows })
      .then((nextShell) => {
        if (cancelled) {
          nextShell.kill();
          return;
        }
        shell = nextShell;
        shellRef.current = nextShell;
        setStatus("connected");
        void nextShell.output
          .pipeTo(
            new WritableStream<string>({
              write(data) {
                terminalWrite(data);
              },
            }),
          )
          .catch((error) => {
            if (!cancelled) {
              setStatus(errorToText(error));
            }
          });
        void nextShell.exit.then((exitCode) => {
          if (!cancelled) {
            setStatus(`exit ${exitCode}`);
          }
        });
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus(errorToText(error));
        }
      });
    return () => {
      cancelled = true;
      shell?.kill();
      if (shellRef.current === shell) {
        shellRef.current = undefined;
      }
    };
  }, [isReady, runtime, sessionId, terminalRef, terminalWrite]);

  return (
    <section className="grid min-h-0 grid-rows-[auto_1fr] border border-[var(--mesh-line)] bg-[var(--codex-panel)]">
      <div className="flex min-h-10 items-center justify-between gap-2 border-b border-[var(--mesh-line)] bg-black/20 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <IconTerminal2
            className="size-4 text-[var(--codex-accent)]"
            aria-hidden="true"
          />
          <h2 className="font-mono text-sm font-bold text-white">Terminal</h2>
        </div>
        <span className="truncate font-mono text-[11px] text-[var(--codex-muted)]">
          {status}
        </span>
      </div>
      <Terminal
        ref={terminalRef}
        autoResize
        className="codex-terminal h-full min-h-0"
        cursorBlink
        onData={(data) => {
          void shellRef.current?.write(data).catch((error) => {
            setStatus(errorToText(error));
          });
        }}
        onReady={() => setIsReady(true)}
        onResize={(cols, rows) => shellRef.current?.resize({ cols, rows })}
        rows={12}
        theme="monokai"
      />
    </section>
  );
}

function WorkspaceFileTree({
  refreshKey,
  runtime,
  sessionId,
}: {
  refreshKey: number;
  runtime?: BrowserCodexRuntime;
  sessionId?: string;
}) {
  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    paths: [],
    search: true,
    stickyFolders: true,
  });
  const pathsRef = useRef(new Set<string>());
  const knownDirsRef = useRef(new Set<string>());
  const loadedDirsRef = useRef(new Set<string>());
  const loadingDirsRef = useRef(new Set<string>());
  const [pathCount, setPathCount] = useState(0);
  const [status, setStatus] = useState("Waiting for workspace");

  const applyPaths = useCallback(() => {
    const expandedPaths = expandedDirectoryPaths(model, knownDirsRef.current);
    model.resetPaths([...pathsRef.current], {
      initialExpandedPaths: expandedPaths,
    });
    setPathCount(pathsRef.current.size);
  }, [model]);

  const loadDirectory = useCallback(
    async (treeDir: string) => {
      if (runtime === undefined || sessionId === undefined) return;
      if (
        loadedDirsRef.current.has(treeDir) ||
        loadingDirsRef.current.has(treeDir)
      ) {
        return;
      }
      loadingDirsRef.current.add(treeDir);
      setStatus(`Loading ${treeDir || "workspace"}`);
      try {
        const entries = await runtime.listWorkspaceDirectory(
          treeDirToWorkspacePath(treeDir),
        );
        loadedDirsRef.current.add(treeDir);
        for (const entry of entries) {
          const treePath = workspaceEntryToTreePath(entry);
          if (treePath === undefined) continue;
          pathsRef.current.add(treePath);
          if (entry.kind === "directory") {
            knownDirsRef.current.add(treePath);
          }
        }
        applyPaths();
        setStatus(`${pathsRef.current.size} paths`);
      } catch (error) {
        setStatus(errorToText(error));
      } finally {
        loadingDirsRef.current.delete(treeDir);
      }
    },
    [applyPaths, runtime, sessionId],
  );

  const reloadLoadedDirectories = useCallback(
    async (reset: boolean) => {
      if (runtime === undefined || sessionId === undefined) {
        pathsRef.current = new Set();
        knownDirsRef.current = new Set();
        loadedDirsRef.current = new Set();
        loadingDirsRef.current = new Set();
        applyPaths();
        setStatus("Waiting for workspace");
        return;
      }

      const dirsToRead = reset ? [""] : [...loadedDirsRef.current];
      if (dirsToRead.length === 0) dirsToRead.push("");
      const nextPaths = new Set<string>();
      const nextKnownDirs = new Set<string>();
      const nextLoadedDirs = new Set<string>();
      setStatus("Loading workspace");
      try {
        for (const treeDir of dirsToRead) {
          const entries = await runtime.listWorkspaceDirectory(
            treeDirToWorkspacePath(treeDir),
          );
          nextLoadedDirs.add(treeDir);
          for (const entry of entries) {
            const treePath = workspaceEntryToTreePath(entry);
            if (treePath === undefined) continue;
            nextPaths.add(treePath);
            if (entry.kind === "directory") {
              nextKnownDirs.add(treePath);
            }
          }
        }
        pathsRef.current = nextPaths;
        knownDirsRef.current = nextKnownDirs;
        loadedDirsRef.current = nextLoadedDirs;
        applyPaths();
        setStatus(`${nextPaths.size} paths`);
      } catch (error) {
        setStatus(errorToText(error));
      }
    },
    [applyPaths, runtime, sessionId],
  );

  useEffect(() => {
    void reloadLoadedDirectories(true);
  }, [reloadLoadedDirectories, sessionId]);

  useEffect(() => {
    void reloadLoadedDirectories(false);
  }, [refreshKey, reloadLoadedDirectories]);

  useEffect(() => {
    return model.subscribe(() => {
      for (const treeDir of knownDirsRef.current) {
        const item = model.getItem(treeDir);
        if (
          item?.isDirectory() === true &&
          "isExpanded" in item &&
          item.isExpanded()
        ) {
          void loadDirectory(treeDir);
        }
      }
    });
  }, [loadDirectory, model]);

  return (
    <div className="relative min-h-0 overflow-hidden">
      <FileTree
        className="codex-file-tree h-full"
        model={model}
        style={fileTreeStyle}
      />
      {pathCount === 0 ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-4 text-center text-sm text-[var(--codex-muted)]">
          <span>{status}</span>
        </div>
      ) : (
        <div className="pointer-events-none absolute right-2 bottom-2 max-w-[70%] truncate border border-[var(--mesh-line)] bg-black/40 px-2 py-1 font-mono text-[10px] text-[var(--codex-muted)]">
          {status}
        </div>
      )}
    </div>
  );
}

function EventsPanel({ trace }: { trace?: AgentTrace }) {
  const [activeTab, setActiveTab] = useState<EventsTab>("events");
  const events = trace?.events ?? [];
  const toolOutputs = trace?.tool_outputs ?? [];
  const activeValue = activeTab === "events" ? events : toolOutputs;
  const emptyText =
    activeTab === "events" ? "No events yet." : "No tool outputs yet.";

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <div
        aria-label="Events tabs"
        className="grid grid-cols-2 border-b border-[var(--mesh-line)] bg-black/20"
        role="tablist"
      >
        <EventsTabButton
          count={events.length}
          isActive={activeTab === "events"}
          label="events"
          onClick={() => setActiveTab("events")}
        />
        <EventsTabButton
          count={toolOutputs.length}
          isActive={activeTab === "tool_outputs"}
          label="tool_outputs"
          onClick={() => setActiveTab("tool_outputs")}
        />
      </div>
      <div className="min-h-0 overflow-hidden bg-black/35">
        {trace === undefined || activeValue.length === 0 ? (
          <div className="grid min-h-full place-items-center p-4 text-center text-sm text-[var(--codex-muted)]">
            <span>{emptyText}</span>
          </div>
        ) : (
          <TraceSection value={activeValue} />
        )}
      </div>
    </div>
  );
}

function EventsTabButton({
  count,
  isActive,
  label,
  onClick,
}: {
  count: number;
  isActive: boolean;
  label: EventsTab;
  onClick: () => void;
}) {
  return (
    <button
      aria-selected={isActive}
      className={[
        "flex min-h-10 items-center justify-between gap-2 border-r border-[var(--mesh-line)] px-3 font-mono text-[11px] font-bold uppercase outline-none last:border-r-0 focus-visible:ring-2 focus-visible:ring-[var(--mesh-focus)]/60",
        isActive
          ? "bg-white/[0.08] text-white"
          : "text-[var(--codex-muted)] hover:bg-white/[0.05] hover:text-white",
      ].join(" ")}
      onClick={onClick}
      role="tab"
      type="button"
    >
      <span>{label}</span>
      <span className="text-[var(--codex-accent)]">{count}</span>
    </button>
  );
}

function TraceSection({ value }: { value: unknown }) {
  return (
    <pre className="h-full w-full overflow-auto p-3 text-[11px] leading-5 text-[var(--codex-text)]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ConfigField({
  children,
  label,
}: {
  children: ReactNode;
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

function agentDeltaText(event: Record<string, unknown>) {
  if (
    event.type === "agent_message_content_delta" &&
    typeof event.delta === "string"
  ) {
    return event.delta;
  }
  return "";
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
  const toolCompatibility =
    "toolCompatibility" in value &&
    value.toolCompatibility === "applyPatchFunction"
      ? "applyPatchFunction"
      : "upstream";
  return apiKey && baseUrl && model
    ? { apiKey, baseUrl, model, toolCompatibility }
    : undefined;
}

function browserDatabasePath() {
  return new URL(window.location.href).searchParams.get("db") ?? undefined;
}

function workspaceEntryToTreePath(entry: WorkspaceDirectoryEntry) {
  const prefix = "/workspace/";
  if (!entry.path.startsWith(prefix)) return undefined;
  const relativePath = entry.path.slice(prefix.length);
  if (relativePath.length === 0) return undefined;
  return entry.kind === "directory" ? `${relativePath}/` : relativePath;
}

function treeDirToWorkspacePath(treeDir: string) {
  const normalized = treeDir.replace(/\/$/, "");
  return normalized.length === 0 ? "/workspace" : `/workspace/${normalized}`;
}

function expandedDirectoryPaths(
  model: ReturnType<typeof useFileTree>["model"],
  knownDirs: ReadonlySet<string>,
) {
  return [...knownDirs].filter((treeDir) => {
    const item = model.getItem(treeDir);
    return (
      item?.isDirectory() === true && "isExpanded" in item && item.isExpanded()
    );
  });
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

const fileTreeStyle = {
  "--trees-accent-override": "var(--codex-accent)",
  "--trees-bg-muted-override": "rgb(255 255 255 / 0.06)",
  "--trees-bg-override": "transparent",
  "--trees-border-color-override": "var(--mesh-line)",
  "--trees-fg-muted-override": "var(--codex-muted)",
  "--trees-fg-override": "var(--codex-text)",
  "--trees-focus-ring-color-override": "var(--mesh-focus)",
  "--trees-font-family-override":
    'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", monospace',
  "--trees-font-size-override": "12px",
  "--trees-input-bg-override": "rgb(0 0 0 / 0.26)",
  "--trees-search-bg-override": "rgb(0 0 0 / 0.34)",
  "--trees-search-fg-override": "var(--codex-text)",
  "--trees-search-font-weight-override": "500",
  "--trees-selected-bg-override": "rgb(255 255 255 / 0.08)",
  "--trees-selected-fg-override": "white",
  height: "100%",
} as CSSProperties;
