import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalPrompt,
  BrowserCodexRuntimeOptions,
  HostTurnOutput,
  RuntimeSession,
  RuntimeSessionSummary,
  RuntimeTurnResult,
  UserInput,
  WasmCodexModule,
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
  RuntimeSession,
  RuntimeSessionSummary,
  RuntimeTurnResult,
  SessionSnapshot,
  ToolOutputTrace,
} from "./types";

type RuntimeHost = {
  fs: WebContainerHostFileSystem;
  exec: WebContainerHostExec;
  approvals: {
    approveExec: (request: unknown) => Promise<ApprovalDecision>;
    approvePatch: (request: unknown) => Promise<ApprovalDecision>;
  };
};

export class BrowserCodexRuntime {
  private webcontainer: WebContainer | undefined;
  private wasm: WasmCodexModule | undefined;
  private host: RuntimeHost | undefined;
  private store: import("./storage").TursoConversationStore | undefined;
  private activeSession: RuntimeSession | undefined;

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
    installBrowserCodexFetch();
    const [
      { WebContainer },
      { TursoConversationStore },
      { WebContainerHostExec, WebContainerHostFileSystem },
    ] = await Promise.all([
      import("@webcontainer/api"),
      import("./storage"),
      import("./webcontainer-host"),
    ]);
    this.webcontainer ??= await WebContainer.boot({
      coep: "require-corp",
      workdirName: "browser-codex",
    });
    this.wasm ??= await loadWasmModule(
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
    await this.store.init();
  }

  async listSessions(): Promise<RuntimeSessionSummary[]> {
    await this.init();
    return this.requiredStore().listSessions();
  }

  async createSession(title = "New session"): Promise<RuntimeSession> {
    await this.init();
    const webcontainer = this.requiredWebContainer();
    await webcontainer.fs.rm("workspace", { recursive: true, force: true });
    await webcontainer.mount(
      this.options.initialWorkspace ?? defaultWorkspaceTree(),
    );
    const { exportWorkspaceSnapshot } = await import("./webcontainer-host");
    const workspaceSnapshot = await exportWorkspaceSnapshot(webcontainer);
    const session = await this.requiredStore().createSession({
      id: crypto.randomUUID(),
      title,
      model: this.options.provider.model,
      workspaceSnapshot,
    });
    this.activeSession = session;
    return session;
  }

  async loadSession(id: string): Promise<RuntimeSession> {
    await this.init();
    const { restoreWorkspaceSnapshot } = await import("./webcontainer-host");
    const session = await this.requiredStore().loadSession(id);
    if (session === undefined) {
      throw new Error(`session ${id} not found`);
    }
    if (session.workspaceSnapshot !== null) {
      await restoreWorkspaceSnapshot(
        this.requiredWebContainer(),
        session.workspaceSnapshot,
      );
    } else {
      await this.requiredWebContainer().mount(
        this.options.initialWorkspace ?? defaultWorkspaceTree(),
      );
    }
    this.activeSession = session;
    return session;
  }

  currentSession() {
    return this.activeSession;
  }

  async runTurn(text: string): Promise<RuntimeTurnResult> {
    await this.init();
    const session = this.activeSession ?? (await this.createSession());
    const input: UserInput[] = [{ type: "text", text }];
    const runJson = JSON.stringify({
      provider: this.options.provider,
      session: session.wasmSession,
      userInput: input,
      execApproval: "ask",
      requirePatchApproval: true,
    });
    const raw = await this.requiredWasm().run_host_turn_json(
      runJson,
      this.requiredHost(),
    );
    const output = JSON.parse(raw) as HostTurnOutput;
    const { exportWorkspaceSnapshot } = await import("./webcontainer-host");
    const workspaceSnapshot = await exportWorkspaceSnapshot(
      this.requiredWebContainer(),
    );
    const assistantText =
      output.assistantText ?? extractAssistantText(output) ?? "Turn completed.";
    const saved = await this.requiredStore().saveTurn({
      session,
      wasmSession: output.session,
      workspaceSnapshot,
      userText: text,
      assistantText,
      trace: output.trace,
    });
    this.activeSession = saved;
    return {
      session: saved,
      assistantText,
      trace: output.trace,
    };
  }

  private requiredWebContainer() {
    if (this.webcontainer === undefined) {
      throw new Error("BrowserCodexRuntime.init() must be called first");
    }
    return this.webcontainer;
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
