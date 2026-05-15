import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

type CaseFile = {
  path: string;
  text: string;
};

type OracleCase = {
  initialFiles?: CaseFile[];
  userInput: Array<Record<string, any>>;
  modelResponses: Array<Array<Record<string, any>>>;
  approvals?: string;
  supportsParallelToolCalls?: boolean;
  exec?: Array<Record<string, any>>;
};

type ToolCall = {
  kind: string;
  name: string;
  call_id: string;
  input?: string;
  arguments?: string;
};

type CanonicalToolOutput = {
  call_id: string;
  output_type: string;
  success: boolean | null;
  text: string | null;
};

type CanonicalEvent = {
  type: string;
  delta?: string;
  retry?: number;
};

type CanonicalRequest = {
  input: Array<Record<string, any>>;
  tools: any[];
  parallel_tool_calls: boolean;
};

export type CanonicalTrace = {
  model_requests: CanonicalRequest[];
  assistant_messages: string[];
  event_summaries: CanonicalEvent[];
  tool_outputs: CanonicalToolOutput[];
  final_files: CaseFile[];
};

export function canonicalizeTrace(trace: any): CanonicalTrace {
  return {
    model_requests: (trace.model_requests ?? []).map(canonicalRequestFromTrace),
    assistant_messages: assistantMessagesFromEvents(trace.events ?? []),
    event_summaries: canonicalEventsFromTrace(trace.events ?? []),
    tool_outputs: (trace.tool_outputs ?? []).map((output: any) => ({
      call_id: output.call_id,
      output_type: output.output_type ?? output.type,
      success: output.success ?? null,
      text: output.text ?? null,
    })),
    final_files: [...(trace.final_files ?? [])].sort(comparePath),
  };
}

export function runUpstreamOracle(
  repoRoot: string,
  caseJson: string,
): CanonicalTrace {
  const parsed = JSON.parse(caseJson) as OracleCase;
  const toolCalls = toolCallsFromCase(parsed);
  const patchOracle = runUpstreamApplyPatchSequence(
    repoRoot,
    parsed.initialFiles ?? [],
    toolCalls,
  );
  const expectedOutputs = expectedToolOutputs(
    parsed,
    toolCalls,
    patchOracle.byCallId,
  );

  return {
    model_requests: expectedModelRequests(
      parsed,
      expectedOutputs,
      upstreamToolSpecs(repoRoot),
    ),
    assistant_messages: assistantMessagesFromCase(parsed),
    event_summaries: canonicalEventsFromCase(parsed),
    tool_outputs: expectedOutputs,
    final_files: patchOracle.finalFiles,
  };
}

function canonicalRequestFromTrace(request: any): CanonicalRequest {
  return {
    input: (request.input ?? []).map(canonicalInputItem),
    tools: canonicalToolSpecs(request.tools ?? []),
    parallel_tool_calls: request.parallel_tool_calls === true,
  };
}

function expectedModelRequests(
  parsed: OracleCase,
  toolOutputs: CanonicalToolOutput[],
  toolSpecs: any[],
): CanonicalRequest[] {
  // Upstream references:
  // - external/codex/codex-rs/core/src/session/turn.rs::build_prompt
  // - external/codex/codex-rs/core/src/context_manager/history.rs::for_prompt
  // - external/codex/codex-rs/core/tests/common/responses.rs::validate_request_body_invariants
  const requests: CanonicalRequest[] = [];
  const input: Array<Record<string, any>> =
    parsed.userInput.map(userInputToMessage);
  const outputByCallId = new Map(
    toolOutputs.map((output) => [output.call_id, output]),
  );

  for (const response of parsed.modelResponses) {
    requests.push({
      input: input.map((item) => ({ ...item })),
      tools: toolSpecs,
      parallel_tool_calls: parsed.supportsParallelToolCalls ?? true,
    });

    const responseItems = response
      .filter(
        (event) => event.type === "response.output_item.done" && event.item,
      )
      .map((event) => canonicalInputItem(event.item));
    input.push(...responseItems);

    for (const item of responseItems) {
      if (!isToolCallItem(item)) {
        continue;
      }
      const output = outputByCallId.get(item.call_id);
      if (output === undefined) {
        throw new Error(`missing expected tool output for ${item.call_id}`);
      }
      input.push(toolOutputToInputItem(output));
    }
  }

  return requests;
}

function userInputToMessage(input: Record<string, any>) {
  if (input.type !== "text") {
    throw new Error(`unsupported user input type ${input.type}`);
  }
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: String(input.text ?? "") }],
  };
}

function isToolCallItem(item: Record<string, any>) {
  return (
    item.type === "function_call" ||
    item.type === "custom_tool_call" ||
    (item.type === "tool_search_call" &&
      item.execution === "client" &&
      typeof item.call_id === "string")
  );
}

function toolOutputToInputItem(output: CanonicalToolOutput) {
  if (output.output_type === "tool_search_output") {
    return {
      type: "tool_search_output",
      call_id: output.call_id,
      status: "completed",
      execution: "client",
      tools: [],
    };
  }
  return {
    type: output.output_type,
    call_id: output.call_id,
    output: output.text ?? "",
  };
}

function canonicalInputItem(item: any): Record<string, any> {
  switch (item.type) {
    case "message":
      return {
        type: "message",
        role: item.role,
        content: (item.content ?? []).map(canonicalContentItem),
      };
    case "reasoning":
      return {
        type: "reasoning",
        summary: item.summary ?? [],
        content: item.content ?? null,
      };
    case "function_call":
      return {
        type: "function_call",
        name: item.name,
        namespace: item.namespace ?? null,
        arguments: item.arguments,
        call_id: item.call_id,
      };
    case "custom_tool_call":
      return {
        type: "custom_tool_call",
        call_id: item.call_id,
        name: item.name,
        input: item.input,
      };
    case "tool_search_call":
      return {
        type: "tool_search_call",
        call_id: item.call_id ?? null,
        status: item.status ?? null,
        execution: item.execution,
        arguments: item.arguments ?? {},
      };
    case "function_call_output":
    case "custom_tool_call_output":
      return {
        type: item.type,
        call_id: item.call_id,
        output: canonicalOutputText(item.output),
      };
    case "tool_search_output":
      return {
        type: "tool_search_output",
        call_id: item.call_id ?? null,
        status: item.status,
        execution: item.execution,
        tools: item.tools ?? [],
      };
    default:
      return { type: item.type ?? "other" };
  }
}

function canonicalContentItem(item: any) {
  if (item.type === "input_text" || item.type === "output_text") {
    return { type: item.type, text: item.text };
  }
  if (item.type === "input_image") {
    return { type: item.type, detail: item.detail ?? null };
  }
  return { type: item.type ?? "other" };
}

function canonicalOutputText(output: any) {
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    return output
      .filter((item) => item.type === "input_text")
      .map((item) => item.text)
      .join("\n");
  }
  return "";
}

function canonicalToolSpecs(tools: any[]) {
  return tools.map(canonicalJson);
}

let upstreamToolSpecsCache: any[] | undefined;

function upstreamToolSpecs(repoRoot: string): any[] {
  if (upstreamToolSpecsCache !== undefined) {
    return upstreamToolSpecsCache;
  }
  const manifest = resolve(
    repoRoot,
    "tests/oracle/upstream-tool-specs/Cargo.toml",
  );
  const result = spawnSync(
    "cargo",
    ["run", "--quiet", "--manifest-path", manifest],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `upstream tool spec oracle failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  const specs = JSON.parse(result.stdout).map(canonicalJson);
  upstreamToolSpecsCache = specs;
  return specs;
}

function expectedToolOutputs(
  parsed: OracleCase,
  toolCalls: ToolCall[],
  applyPatchByCallId: Map<string, ApplyPatchOracleResult>,
): CanonicalToolOutput[] {
  // Upstream references:
  // - external/codex/codex-rs/core/tests/common/responses.rs::validate_request_body_invariants
  // - external/codex/codex-rs/core/src/tools/registry.rs::unsupported_tool_call_message
  // - external/codex/codex-rs/core/src/tools/context.rs::ExecCommandToolOutput::response_text
  //
  // Native upstream execution is only used for apply_patch because shell/process
  // execution is a host boundary in the wasm core. For other model-visible
  // outputs this raw-translates the upstream output helpers and validates every
  // scripted tool call rather than only the first call in a turn.
  let execIndex = 0;
  return toolCalls.map((toolCall) => {
    if (toolCall.name === "apply_patch") {
      const result = applyPatchByCallId.get(toolCall.call_id);
      if (result === undefined) {
        throw new Error(
          `missing apply_patch oracle result for ${toolCall.call_id}`,
        );
      }
      return {
        call_id: toolCall.call_id,
        output_type: "custom_tool_call_output",
        success: result.ok,
        text: result.ok
          ? result.stdout
          : `apply_patch verification failed: ${normalizeApplyPatchFailure(result.stderr || result.stdout)}`,
      };
    }
    if (toolCall.kind === "custom") {
      return {
        call_id: toolCall.call_id,
        output_type: "custom_tool_call_output",
        success: false,
        text: `unsupported custom tool call: ${toolCall.name}`,
      };
    }
    if (toolCall.kind === "tool_search") {
      return {
        call_id: toolCall.call_id,
        output_type: "tool_search_output",
        success: true,
        text: "[]",
      };
    }
    if (toolCall.name === "exec_command" && parsed.approvals === "deny") {
      return {
        call_id: toolCall.call_id,
        output_type: "function_call_output",
        success: false,
        text: "exec_command denied by approval policy: scripted denial",
      };
    }
    if (toolCall.name === "exec_command") {
      const snapshot = parsed.exec?.[execIndex];
      execIndex += 1;
      if (!snapshot) {
        throw new Error("exec_command oracle requires an exec snapshot");
      }
      const args = parseFunctionArguments(toolCall.arguments);
      return {
        call_id: toolCall.call_id,
        output_type: "function_call_output",
        success: true,
        text: formatExecOutput(
          toolCall.call_id,
          snapshot,
          args.max_output_tokens,
        ),
      };
    }
    throw new Error(
      `no upstream oracle implemented for tool '${toolCall.name}'`,
    );
  });
}

function toolCallsFromCase(parsed: OracleCase) {
  const calls: ToolCall[] = [];
  for (const response of parsed.modelResponses) {
    for (const event of response) {
      const item = event.item;
      if (
        event.type === "response.output_item.done" &&
        item?.type === "custom_tool_call"
      ) {
        calls.push({
          kind: "custom",
          name: item.name as string,
          call_id: item.call_id as string,
          input: item.input as string,
        });
      }
      if (
        event.type === "response.output_item.done" &&
        item?.type === "function_call"
      ) {
        calls.push({
          kind: "function",
          name: item.name as string,
          call_id: item.call_id as string,
          arguments: item.arguments as string,
        });
      }
      if (
        event.type === "response.output_item.done" &&
        item?.type === "tool_search_call" &&
        item.execution === "client" &&
        typeof item.call_id === "string"
      ) {
        calls.push({
          kind: "tool_search",
          name: "tool_search",
          call_id: item.call_id as string,
          arguments: JSON.stringify(item.arguments ?? {}),
        });
      }
    }
  }
  return calls;
}

function assistantMessagesFromCase(parsed: OracleCase) {
  const messages: string[] = [];
  for (const response of parsed.modelResponses) {
    for (const event of response) {
      const item = event.item;
      if (
        event.type === "response.output_item.done" &&
        item?.type === "message"
      ) {
        messages.push(outputText(item.content ?? []));
      }
    }
  }
  return messages;
}

function assistantMessagesFromEvents(events: any[]) {
  return events
    .filter(
      (event) =>
        event.type === "item_completed" && event.item?.type === "message",
    )
    .map((event) => outputText(event.item.content ?? []));
}

function canonicalEventsFromTrace(events: any[]) {
  return events.flatMap((event): CanonicalEvent[] => {
    if (event.type === "agent_message_content_delta") {
      return [{ type: event.type, delta: event.delta }];
    }
    if (event.type === "reasoning_content_delta") {
      return [{ type: event.type, delta: event.delta }];
    }
    if (event.type === "stream_error") {
      return [{ type: event.type, retry: event.retry }];
    }
    return [];
  });
}

function canonicalEventsFromCase(parsed: OracleCase) {
  const events: CanonicalEvent[] = [];
  parsed.modelResponses.forEach((response, responseIndex) => {
    let completed = false;
    for (const event of response) {
      if (event.type === "response.output_text.delta") {
        events.push({
          type: "agent_message_content_delta",
          delta: event.delta,
        });
      } else if (
        event.type === "response.reasoning_text.delta" ||
        event.type === "response.reasoning_summary_text.delta"
      ) {
        events.push({ type: "reasoning_content_delta", delta: event.delta });
      } else if (event.type === "response.completed") {
        completed = true;
      }
    }
    if (!completed && responseIndex < parsed.modelResponses.length - 1) {
      events.push({ type: "stream_error", retry: 1 });
    }
  });
  return events;
}

function outputText(content: any[]) {
  return content
    .filter((item) => item.type === "output_text" || item.type === "input_text")
    .map((item) => item.text)
    .join("\n");
}

function runUpstreamApplyPatchSequence(
  repoRoot: string,
  initialFiles: CaseFile[],
  toolCalls: ToolCall[],
) {
  const cwd = setupWorkspace(initialFiles);
  const byCallId = new Map<string, ApplyPatchOracleResult>();
  try {
    for (const toolCall of toolCalls) {
      if (toolCall.name === "apply_patch") {
        byCallId.set(
          toolCall.call_id,
          runApplyPatch(repoRoot, cwd, toolCall.input ?? ""),
        );
      }
    }
    return {
      byCallId,
      finalFiles: snapshotWorkspace(cwd),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function setupWorkspace(initialFiles: CaseFile[]) {
  const cwd = mkdtempSync(
    join(tmpdir(), "browser-codex-upstream-apply-patch-"),
  );
  for (const file of initialFiles) {
    const filePath = workspacePathToDisk(cwd, file.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, file.text);
  }
  return cwd;
}

type ApplyPatchOracleResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

function runApplyPatch(
  repoRoot: string,
  cwd: string,
  patch: string,
): ApplyPatchOracleResult {
  // Native upstream oracle for patch semantics:
  // external/codex/codex-rs/apply-patch/src/standalone_executable.rs.
  const manifest = resolve(
    repoRoot,
    "external/codex/codex-rs/apply-patch/Cargo.toml",
  );
  const result = spawnSync(
    "cargo",
    ["run", "--quiet", "--manifest-path", manifest, "--", patch],
    {
      cwd,
      encoding: "utf8",
    },
  );
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseFunctionArguments(argumentsJson: string | undefined) {
  if (!argumentsJson) {
    return {};
  }
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return {};
  }
}

function formatExecOutput(
  callId: string,
  snapshot: Record<string, any>,
  maxOutputTokens?: number,
) {
  const sections: string[] = [];
  sections.push(`Chunk ID: chunk-${callId}`);
  sections.push(
    `Wall time: ${(Number(snapshot.wall_time_ms ?? 0) / 1000).toFixed(4)} seconds`,
  );
  if (snapshot.exit_code !== null && snapshot.exit_code !== undefined) {
    sections.push(`Process exited with code ${snapshot.exit_code}`);
  }
  if (snapshot.process_id !== null && snapshot.process_id !== undefined) {
    sections.push(`Process running with session ID ${snapshot.process_id}`);
  }
  const output = execSnapshotOutput(snapshot);
  const originalTokenCount = snapshot.original_token_count;
  if (originalTokenCount !== undefined && originalTokenCount !== null) {
    sections.push(`Original token count: ${originalTokenCount}`);
  }
  sections.push("Output:");
  sections.push(
    formattedTruncateText(output, resolveMaxTokens(maxOutputTokens)),
  );
  return sections.join("\n");
}

function execSnapshotOutput(snapshot: Record<string, any>) {
  if (Array.isArray(snapshot.output)) {
    return Buffer.from(snapshot.output).toString("utf8");
  }
  if (typeof snapshot.output === "string") {
    return snapshot.output;
  }
  return "";
}

const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const APPROX_BYTES_PER_TOKEN = 4;

function resolveMaxTokens(maxOutputTokens?: number) {
  return maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

function formattedTruncateText(content: string, maxTokens: number) {
  // Raw-translated from upstream:
  // external/codex/codex-rs/utils/output-truncation/src/lib.rs::formatted_truncate_text.
  if (byteLength(content) <= approxBytesForTokens(maxTokens)) {
    return content;
  }

  const totalLines = content.split(/\n/).filter((_, index, all) => {
    return !(index === all.length - 1 && all[index] === "");
  }).length;
  return `Total output lines: ${totalLines}\n\n${truncateMiddleWithTokenBudget(content, maxTokens)[0]}`;
}

function truncateMiddleWithTokenBudget(
  text: string,
  maxTokens: number,
): [string, number | null] {
  if (text.length === 0) {
    return ["", null];
  }
  if (maxTokens > 0 && byteLength(text) <= approxBytesForTokens(maxTokens)) {
    return [text, null];
  }
  const truncated = truncateWithByteEstimate(
    text,
    approxBytesForTokens(maxTokens),
    true,
  );
  const totalTokens = approxTokenCount(text);
  return truncated === text ? [truncated, null] : [truncated, totalTokens];
}

function truncateWithByteEstimate(
  text: string,
  maxBytes: number,
  useTokens: boolean,
) {
  if (text.length === 0) {
    return "";
  }
  const chars = [...text];
  if (maxBytes === 0) {
    return formatTruncationMarker(
      useTokens,
      removedUnits(useTokens, byteLength(text), chars.length),
    );
  }
  if (byteLength(text) <= maxBytes) {
    return text;
  }
  const [leftBudget, rightBudget] = splitBudget(maxBytes);
  const [removedChars, left, right] = splitString(
    text,
    leftBudget,
    rightBudget,
  );
  const marker = formatTruncationMarker(
    useTokens,
    removedUnits(
      useTokens,
      Math.max(0, byteLength(text) - maxBytes),
      removedChars,
    ),
  );
  return `${left}${marker}${right}`;
}

function splitString(
  text: string,
  beginningBytes: number,
  endBytes: number,
): [number, string, string] {
  const chars = [...text];
  let prefix = "";
  let suffix = "";
  let removedChars = 0;
  let prefixBytes = 0;
  const totalBytes = byteLength(text);
  const tailStartTarget = Math.max(0, totalBytes - endBytes);

  for (const char of chars) {
    const charBytes = byteLength(char);
    if (prefixBytes + charBytes <= beginningBytes) {
      prefix += char;
      prefixBytes += charBytes;
    } else {
      break;
    }
  }

  let suffixBytes = 0;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]!;
    const charBytes = byteLength(char);
    if (totalBytes - suffixBytes - charBytes >= tailStartTarget) {
      suffix = `${char}${suffix}`;
      suffixBytes += charBytes;
    } else {
      break;
    }
  }

  const keptChars = [...prefix].length + [...suffix].length;
  removedChars = Math.max(0, chars.length - keptChars);
  return [removedChars, prefix, suffix];
}

function splitBudget(budget: number): [number, number] {
  const left = Math.floor(budget / 2);
  return [left, budget - left];
}

function formatTruncationMarker(useTokens: boolean, removedCount: number) {
  return useTokens
    ? `…${removedCount} tokens truncated…`
    : `…${removedCount} chars truncated…`;
}

function removedUnits(
  useTokens: boolean,
  removedBytes: number,
  removedChars: number,
) {
  return useTokens ? approxTokensFromByteCount(removedBytes) : removedChars;
}

function approxTokenCount(text: string) {
  return Math.ceil(byteLength(text) / APPROX_BYTES_PER_TOKEN);
}

function approxBytesForTokens(tokens: number) {
  return tokens * APPROX_BYTES_PER_TOKEN;
}

function approxTokensFromByteCount(bytes: number) {
  return Math.ceil(bytes / APPROX_BYTES_PER_TOKEN);
}

function byteLength(text: string) {
  return Buffer.byteLength(text, "utf8");
}

function snapshotWorkspace(cwd: string) {
  const files: CaseFile[] = [];
  visit(cwd, files, cwd);
  return files.sort(comparePath);
}

function visit(root: string, files: CaseFile[], current: string) {
  for (const entry of readdirSync(current)) {
    const path = join(current, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      visit(root, files, path);
    } else if (stats.isFile()) {
      const rel = relative(root, path).split(sep).join("/");
      files.push({
        path: `/workspace/${rel}`,
        text: readFileSync(path, "utf8"),
      });
    }
  }
}

function workspacePathToDisk(root: string, workspacePath: string) {
  if (!workspacePath.startsWith("/workspace/")) {
    throw new Error(`expected /workspace path, got ${workspacePath}`);
  }
  const rel = workspacePath.slice("/workspace/".length);
  const resolved = resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`path escapes workspace: ${workspacePath}`);
  }
  return resolved;
}

function comparePath(a: CaseFile, b: CaseFile) {
  return a.path.localeCompare(b.path);
}

function canonicalJson(value: any): any {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function normalizeApplyPatchFailure(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("Invalid patch: ")) {
    return `invalid patch: ${trimmed.slice("Invalid patch: ".length)}`;
  }
  if (trimmed.startsWith("Invalid hunk")) {
    return trimmed.replace(/^Invalid hunk/, "invalid hunk");
  }
  return trimmed;
}
