import type { FileSystemTree } from "@webcontainer/api";

export type ProviderConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type UserInput = {
  type: "text";
  text: string;
};

export type ApprovalDecision = {
  approved: boolean;
  reason?: string;
};

export type ExecApprovalRequest = {
  call_id: string;
  cmd: string;
  workdir: string;
};

export type ApplyPatchApprovalRequest = {
  call_id: string;
  workdir: string;
  affected_paths: string[];
};

export type ApprovalPrompt =
  | {
      type: "exec";
      request: ExecApprovalRequest;
    }
  | {
      type: "patch";
      request: ApplyPatchApprovalRequest;
    };

export type ApprovalHandler = (
  prompt: ApprovalPrompt,
) => Promise<ApprovalDecision>;

export type SessionSnapshot = {
  sessionId: string;
  threadId: string;
  history: unknown;
  nextId: number;
};

export type TraceFile = {
  path: string;
  text: string;
};

export type ToolOutputTrace = {
  call_id: string;
  type: string;
  success?: boolean;
  text?: string;
};

export type AgentTrace = {
  model_requests: unknown[];
  events: Array<Record<string, unknown>>;
  tool_outputs: ToolOutputTrace[];
  final_files: TraceFile[];
  approvals?: unknown[];
  exec?: unknown[];
};

export type HostTurnOutput = {
  assistantText?: string | null;
  session: SessionSnapshot;
  trace: AgentTrace;
  events: Array<Record<string, unknown>>;
};

export type WasmCodexModule = {
  default: (input?: string | { module_or_path: string }) => Promise<void>;
  run_host_turn_json: (runJson: string, host: unknown) => Promise<string>;
};

export type RuntimeSessionSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
};

export type RuntimeMessage = {
  id: string;
  sessionId: string;
  role: "assistant" | "user";
  text: string;
  createdAt: number;
  trace?: AgentTrace;
};

export type RuntimeSession = RuntimeSessionSummary & {
  wasmSession: SessionSnapshot | null;
  workspaceSnapshot: FileSystemTree | null;
  messages: RuntimeMessage[];
};

export type RuntimeTurnResult = {
  session: RuntimeSession;
  assistantText: string;
  trace: AgentTrace;
};

export type ExecOutputSnapshot = {
  wall_time_ms: number;
  output: Uint8Array | number[];
  process_id?: number | null;
  exit_code?: number | null;
  original_token_count?: number | null;
};

export type ExecRequest = {
  cmd: string;
  workdir: string;
  shell?: string | null;
  login: boolean;
  yield_time_ms: number;
  max_output_tokens?: number | null;
  tty: boolean;
  terminal_size?: { cols: number; rows: number } | null;
};

export type OutputPollOptions = {
  yield_time_ms: number;
  max_output_tokens?: number | null;
};

export type BrowserCodexRuntimeOptions = {
  provider: ProviderConfig;
  wasmJsUrl: string;
  wasmBinaryUrl: string;
  databasePath?: string;
  approvalHandler: ApprovalHandler;
  initialWorkspace?: FileSystemTree;
};
