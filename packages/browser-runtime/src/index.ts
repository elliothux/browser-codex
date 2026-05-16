import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalPrompt,
  BrowserCodexRuntimeOptions,
  HostTurnOutput,
  RuntimePermissionMode,
  RuntimeSession,
  RuntimeSessionSummary,
  RuntimeTerminalSession,
  RuntimeTurnOptions,
  RuntimeTurnResult,
  RuntimeTurnStreamEvent,
  UserInput,
  WasmCodexModule,
  WasmTurnStreamChunk,
  WorkspaceDirectoryEntry,
} from "./types";
import type {
  WebContainerHostExec,
  WebContainerHostFileSystem,
} from "./webcontainer-host";
import { defaultWorkspaceTree } from "./workspace-tree";

export type {
  AgentTrace,
  ApplyPatchApprovalRequest,
  ApprovalDecision,
  ApprovalHandler,
  ApprovalPrompt,
  BrowserCodexRuntimeOptions,
  ExecApprovalRequest,
  ProviderConfig,
  RuntimeMessage,
  RuntimePermissionMode,
  RuntimeSession,
  RuntimeSessionSummary,
  RuntimeTerminalSession,
  RuntimeTurnOptions,
  RuntimeTurnResult,
  RuntimeTurnStreamEvent,
  SessionSnapshot,
  ToolOutputTrace,
  WorkspaceDirectoryEntry,
} from "./types";

type RuntimeHost = {
  fs: WebContainerHostFileSystem;
  exec: WebContainerHostExec;
  approvals: {
    approveExec: (request: unknown) => Promise<ApprovalDecision>;
    approvePatch: (request: unknown) => Promise<ApprovalDecision>;
  };
};

type RuntimeGlobalState = {
  __browserCodexFetch?: typeof fetch;
  __browserCodexWasmModules?: Map<string, Promise<WasmCodexModule>>;
  __browserCodexWebContainer?: {
    instance?: WebContainer;
    promise?: Promise<WebContainer>;
  };
};

export class BrowserCodexRuntime {
  private webcontainer: WebContainer | undefined;
  private wasm: WasmCodexModule | undefined;
  private host: RuntimeHost | undefined;
  private initPromise: Promise<void> | undefined;
  private store: import("./storage").TursoConversationStore | undefined;
  private snapshotStore:
    | import("./workspace-snapshots").OpfsWorkspaceSnapshotStore
    | undefined;
  private activeSession: RuntimeSession | undefined;
  private workspaceRestoreQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: BrowserCodexRuntimeOptions) {}

  setProvider(provider: BrowserCodexRuntimeOptions["provider"]) {
    this.options.provider = provider;
    if (this.activeSession !== undefined) {
      this.activeSession = {
        ...this.activeSession,
        model: provider.model,
      };
    }
  }

  async init() {
    this.initPromise ??= this.doInit().catch((error: unknown) => {
      this.initPromise = undefined;
      throw error;
    });
    return this.initPromise;
  }

  private async doInit() {
    installBrowserCodexFetch();
    const [
      { WebContainer },
      { TursoConversationStore },
      { WebContainerHostExec, WebContainerHostFileSystem },
      { OpfsWorkspaceSnapshotStore },
    ] = await Promise.all([
      import("@webcontainer/api"),
      import("./storage"),
      import("./webcontainer-host"),
      import("./workspace-snapshots"),
    ]);
    this.webcontainer ??= await bootSharedWebContainer(WebContainer);
    this.wasm ??= await loadSharedWasmModule(
      this.options.wasmJsUrl,
      this.options.wasmBinaryUrl,
    );
    this.host ??= {
      fs: new WebContainerHostFileSystem(this.webcontainer),
      exec: new WebContainerHostExec(this.webcontainer),
      approvals: approvalHost(this.options.approvalHandler),
    };
    this.store ??= new TursoConversationStore(
      this.options.databasePath ?? "browser-codex.sqlite3",
    );
    this.snapshotStore ??= new OpfsWorkspaceSnapshotStore();
    await this.store.init();
  }

  async listSessions(): Promise<RuntimeSessionSummary[]> {
    await this.init();
    return this.requiredStore().listSessions();
  }

  async createSession(title = "New session"): Promise<RuntimeSession> {
    await this.init();
    const webcontainer = this.requiredWebContainer();
    const id = crypto.randomUUID();
    await this.mountInitialWorkspace();
    const session = await this.requiredStore().createSession({
      id,
      title,
      model: this.options.provider.model,
    });
    const { exportWorkspaceSnapshot } = await import("./webcontainer-host");
    await this.requiredSnapshotStore().saveLatest(
      id,
      await exportWorkspaceSnapshot(webcontainer),
    );
    this.activeSession = session;
    return session;
  }

  async loadSession(id: string): Promise<RuntimeSession> {
    await this.init();
    return this.enqueueWorkspaceRestore(async () => {
      const { restoreWorkspaceSnapshot } = await import("./webcontainer-host");
      const session = await this.requiredStore().loadSession(id);
      if (session === undefined) {
        throw new Error(`session ${id} not found`);
      }
      let workspaceRestoreError: string | undefined;
      try {
        const snapshot = await this.requiredSnapshotStore().loadLatest(id);
        if (snapshot === null) {
          workspaceRestoreError = `workspace snapshot missing at ${this.requiredSnapshotStore().pathForSession(id)}`;
          await this.mountInitialWorkspace();
        } else {
          await restoreWorkspaceSnapshot(this.requiredWebContainer(), snapshot);
        }
      } catch (error) {
        workspaceRestoreError = `workspace snapshot restore failed: ${errorToText(error)}`;
        await this.mountInitialWorkspace();
      }
      const restoredSession = {
        ...session,
        workspaceRestoreError,
      };
      this.activeSession = restoredSession;
      return restoredSession;
    });
  }

  async renameSession(id: string, title: string) {
    await this.init();
    const summary = await this.requiredStore().renameSession(id, title);
    if (this.activeSession?.id === id) {
      this.activeSession = {
        ...this.activeSession,
        title: summary.title,
        updatedAt: summary.updatedAt,
      };
    }
    return summary;
  }

  currentSession() {
    return this.activeSession;
  }

  async runTurn(
    text: string,
    options?: RuntimeTurnOptions,
  ): Promise<RuntimeTurnResult> {
    let result: RuntimeTurnResult | undefined;
    for await (const event of this.runTurnStream(text, options)) {
      if (event.type === "done") {
        result = event.result;
      }
    }
    if (result === undefined) {
      throw new Error("turn stream ended before completion");
    }
    return result;
  }

  async *runTurnStream(
    text: string,
    options?: RuntimeTurnOptions,
  ): AsyncGenerator<RuntimeTurnStreamEvent> {
    await this.init();
    const session = this.activeSession ?? (await this.createSession());
    const input: UserInput[] = [{ type: "text", text }];
    const permissions = runtimePermissionConfig(options?.permissionMode);
    const runJson = JSON.stringify({
      provider: this.options.provider,
      session: session.wasmSession,
      userInput: input,
      execApproval: permissions.execApproval,
      requirePatchApproval: permissions.requirePatchApproval,
    });
    const output = yield* this.runWasmTurnStream(runJson);
    const { exportWorkspaceSnapshot } = await import("./webcontainer-host");
    await this.requiredSnapshotStore().saveLatest(
      session.id,
      await exportWorkspaceSnapshot(this.requiredWebContainer()),
    );
    const assistantText =
      output.assistantText ?? extractAssistantText(output) ?? "Turn completed.";
    const saved = await this.requiredStore().saveTurn({
      session,
      wasmSession: output.session,
      userText: text,
      assistantText,
      trace: output.trace,
    });
    this.activeSession = saved;
    yield {
      type: "done",
      result: {
        session: saved,
        assistantText,
        trace: output.trace,
      },
    };
  }

  async listWorkspaceDirectory(
    path = "/workspace",
  ): Promise<WorkspaceDirectoryEntry[]> {
    await this.init();
    const entries = await this.requiredHost().fs.readDir(path);
    return entries
      .filter((entry) => entry.is_dir || entry.is_file)
      .map((entry) => ({
        kind: entry.is_dir ? ("directory" as const) : ("file" as const),
        name: entry.path.split("/").at(-1) ?? entry.path,
        path: entry.path,
      }))
      .sort(compareWorkspaceEntries);
  }

  async startTerminal(options?: {
    cols?: number;
    cwd?: string;
    rows?: number;
  }): Promise<RuntimeTerminalSession> {
    await this.init();
    const process = await this.requiredWebContainer().spawn("jsh", {
      cwd: terminalCwd(options?.cwd),
      output: true,
      terminal: {
        cols: options?.cols ?? 80,
        rows: options?.rows ?? 18,
      },
    });
    let inputWriter: WritableStreamDefaultWriter<string> | undefined;
    let released = false;
    const releaseInput = () => {
      if (released) return;
      released = true;
      inputWriter?.releaseLock();
    };
    return {
      exit: process.exit.finally(releaseInput),
      output: process.output,
      kill() {
        process.kill();
        releaseInput();
      },
      resize(size) {
        process.resize(size);
      },
      async write(data) {
        inputWriter ??= process.input.getWriter();
        await inputWriter.write(data);
      },
    };
  }

  private async *runWasmTurnStream(
    runJson: string,
  ): AsyncGenerator<RuntimeTurnStreamEvent, HostTurnOutput, void> {
    const wasm = this.requiredWasm();
    if (wasm.run_host_turn_stream_json === undefined) {
      const raw = await wasm.run_host_turn_json(runJson, this.requiredHost());
      const output = JSON.parse(raw) as HostTurnOutput;
      for (const event of output.events) {
        yield { type: "event", event };
      }
      return output;
    }

    const stream = wasm.run_host_turn_stream_json(runJson, this.requiredHost());
    const reader = stream.getReader();
    let output: HostTurnOutput | undefined;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        const value = normalizeStreamChunk(chunk.value);
        if (value.type === "event") {
          yield { type: "event", event: value.event };
        } else if (value.type === "done") {
          output = value.output;
        } else if (value.type === "cancelled") {
          throw new Error("turn cancelled");
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (output === undefined) {
      throw new Error("wasm turn stream ended before done");
    }
    return output;
  }

  private requiredWebContainer() {
    if (this.webcontainer === undefined) {
      throw new Error("BrowserCodexRuntime.init() must be called first");
    }
    return this.webcontainer;
  }

  private async mountInitialWorkspace() {
    const webcontainer = this.requiredWebContainer();
    await webcontainer.fs.rm("workspace", { recursive: true, force: true });
    await webcontainer.mount(
      this.options.initialWorkspace ?? defaultWorkspaceTree(),
    );
  }

  private requiredWasm() {
    if (this.wasm === undefined) {
      throw new Error("BrowserCodexRuntime.init() must be called first");
    }
    return this.wasm;
  }

  private requiredHost() {
    if (this.host === undefined) {
      throw new Error("BrowserCodexRuntime.init() must be called first");
    }
    return this.host;
  }

  private requiredStore() {
    if (this.store === undefined) {
      throw new Error("BrowserCodexRuntime.init() must be called first");
    }
    return this.store;
  }

  private requiredSnapshotStore() {
    if (this.snapshotStore === undefined) {
      throw new Error("BrowserCodexRuntime.init() must be called first");
    }
    return this.snapshotStore;
  }

  private enqueueWorkspaceRestore<T>(operation: () => Promise<T>): Promise<T> {
    // Browser adapter boundary: upstream native Codex has a single active
    // rollout/session reconstruction path in
    // external/codex/codex-rs/core/src/rollout.rs and does not remount one
    // mutable in-process workspace while history is being selected. The
    // browser runtime must serialize WebContainer mounts so rapid history
    // restores cannot interleave OPFS snapshot reads and workspace replacement.
    const run = this.workspaceRestoreQueue.then(operation, operation);
    this.workspaceRestoreQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function createRuntime(options: BrowserCodexRuntimeOptions) {
  return new BrowserCodexRuntime(options);
}

async function loadWasmModule(jsUrl: string, wasmBinaryUrl: string) {
  const runtimeImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<unknown>;
  const module = (await runtimeImport(jsUrl)) as WasmCodexModule;
  await module.default({ module_or_path: wasmBinaryUrl });
  return module;
}

function browserRuntimeGlobal() {
  return globalThis as typeof globalThis & RuntimeGlobalState;
}

function bootSharedWebContainer(
  WebContainer: typeof import("@webcontainer/api").WebContainer,
) {
  const global = browserRuntimeGlobal();
  const state = (global.__browserCodexWebContainer ??= {});
  if (state.instance !== undefined) {
    return Promise.resolve(state.instance);
  }
  state.promise ??= WebContainer.boot({
    coep: "require-corp",
    workdirName: "browser-codex",
  })
    .then((instance) => {
      state.instance = instance;
      return instance;
    })
    .catch((error: unknown) => {
      if (state.instance === undefined) {
        state.promise = undefined;
      }
      throw error;
    });
  return state.promise;
}

function loadSharedWasmModule(jsUrl: string, wasmBinaryUrl: string) {
  const global = browserRuntimeGlobal();
  const modules = (global.__browserCodexWasmModules ??= new Map());
  const key = `${jsUrl}\0${wasmBinaryUrl}`;
  let promise = modules.get(key);
  if (promise === undefined) {
    promise = loadWasmModule(jsUrl, wasmBinaryUrl).catch((error: unknown) => {
      if (modules.get(key) === promise) {
        modules.delete(key);
      }
      throw error;
    });
    modules.set(key, promise);
  }
  return promise;
}

function normalizeStreamChunk(value: unknown): WasmTurnStreamChunk {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw new Error("invalid wasm turn stream chunk");
  }
  const chunk = value as Partial<WasmTurnStreamChunk>;
  if (chunk.type === "event" && isRecord(chunk.event)) {
    return { type: "event", event: chunk.event };
  }
  if (chunk.type === "done" && isRecord(chunk.output)) {
    return { type: "done", output: chunk.output as HostTurnOutput };
  }
  if (chunk.type === "cancelled") {
    return { type: "cancelled" };
  }
  throw new Error("invalid wasm turn stream chunk");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorToText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function installBrowserCodexFetch() {
  const global = globalThis as typeof globalThis & {
    __browserCodexFetch?: typeof fetch;
  };
  global.__browserCodexFetch ??= globalThis.fetch.bind(globalThis);
}

function approvalHost(approvalHandler: ApprovalHandler) {
  return {
    approveExec(request: unknown) {
      return approvalHandler({
        type: "exec",
        request: request as Extract<
          ApprovalPrompt,
          { type: "exec" }
        >["request"],
      });
    },
    approvePatch(request: unknown) {
      return approvalHandler({
        type: "patch",
        request: request as Extract<
          ApprovalPrompt,
          { type: "patch" }
        >["request"],
      });
    },
  };
}

function runtimePermissionConfig(
  permissionMode: RuntimePermissionMode | undefined,
) {
  switch (permissionMode ?? "default") {
    case "auto-review":
      return { execApproval: "ask", requirePatchApproval: false };
    case "full-access":
      return { execApproval: "auto", requirePatchApproval: false };
    case "default":
      return { execApproval: "ask", requirePatchApproval: true };
  }
}

function compareWorkspaceEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
) {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function terminalCwd(cwd: string | undefined) {
  if (cwd === undefined || cwd === "" || cwd === "/workspace") {
    return "workspace";
  }
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized.startsWith("/workspace/")) {
    return normalized.slice(1);
  }
  if (normalized === "workspace" || normalized.startsWith("workspace/")) {
    return normalized;
  }
  throw new Error(`terminal cwd escapes workspace: ${cwd}`);
}

function extractAssistantText(output: HostTurnOutput) {
  for (const event of output.events.toReversed()) {
    if (event.type !== "item_completed") {
      continue;
    }
    const item = event.item as
      | {
          type?: string;
          content?: Array<{ type?: string; text?: string }>;
        }
      | undefined;
    if (item?.type !== "message") {
      continue;
    }
    const text = item.content
      ?.filter((content) => content.type === "output_text")
      .map((content) => content.text)
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (text !== undefined && text.length > 0) {
      return text;
    }
  }
  return undefined;
}

export { defaultWorkspaceTree };
export type { FileSystemTree };
