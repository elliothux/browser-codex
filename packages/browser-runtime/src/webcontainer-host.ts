// WebContainer host adapters for codex-browser-core's HostFileSystem and
// HostExec traits. Upstream native Codex routes these operations through its
// sandbox/process/filesystem services; this adapter preserves the trait shape
// while mapping it to WebContainer APIs.

import type {
  DirEnt,
  FileSystemTree,
  WebContainer,
  WebContainerProcess,
} from "@webcontainer/api";
import type {
  ExecOutputSnapshot,
  ExecRequest,
  OutputPollOptions,
  TraceFile,
} from "./types";

type RunningProcess = {
  id: number;
  process: WebContainerProcess;
  chunks: string[];
  readOffset: number;
  startedAt: number;
  exitCode: number | null;
  inputWriter?: WritableStreamDefaultWriter<string>;
  outputClosed: Promise<void>;
};

export class WebContainerHostFileSystem {
  constructor(private readonly webcontainer: WebContainer) {}

  async readFile(path: string): Promise<Uint8Array> {
    return this.webcontainer.fs.readFile(toContainerPath(path));
  }

  async writeFile(path: string, contents: Uint8Array): Promise<void> {
    const containerPath = toContainerPath(path);
    const parent = parentPath(containerPath);
    if (parent !== undefined) {
      await this.webcontainer.fs.mkdir(parent, { recursive: true });
    }
    await this.webcontainer.fs.writeFile(containerPath, contents);
  }

  async readDir(path: string) {
    const containerPath = toContainerPath(path);
    const entries = await this.webcontainer.fs.readdir(containerPath, {
      withFileTypes: true,
    });
    return entries.map((entry: DirEnt<string>) => {
      const child = `${containerPath}/${entry.name}`.replace(/\/+/g, "/");
      return {
        path: fromContainerPath(child),
        is_dir: entry.isDirectory(),
        is_file: entry.isFile(),
      };
    });
  }

  async metadata(path: string) {
    const containerPath = toContainerPath(path);
    try {
      const bytes = await this.webcontainer.fs.readFile(containerPath);
      return { is_dir: false, is_file: true, len: bytes.byteLength };
    } catch (fileError) {
      try {
        await this.webcontainer.fs.readdir(containerPath);
        return { is_dir: true, is_file: false, len: 0 };
      } catch {
        throw fileError;
      }
    }
  }

  async remove(
    path: string,
    recursive: boolean,
    force: boolean,
  ): Promise<void> {
    await this.webcontainer.fs.rm(toContainerPath(path), { recursive, force });
  }

  async mkdir(path: string, recursive: boolean): Promise<void> {
    if (recursive) {
      await this.webcontainer.fs.mkdir(toContainerPath(path), {
        recursive: true,
      });
    } else {
      await this.webcontainer.fs.mkdir(toContainerPath(path));
    }
  }

  async snapshotText(): Promise<TraceFile[]> {
    return this.snapshotDirectory("/workspace");
  }

  private async snapshotDirectory(path: string): Promise<TraceFile[]> {
    const entries = await this.readDir(path).catch(() => []);
    const files: TraceFile[] = [];
    for (const entry of entries) {
      if (entry.is_dir) {
        files.push(...(await this.snapshotDirectory(entry.path)));
      } else if (entry.is_file) {
        const bytes = await this.readFile(entry.path);
        files.push({
          path: entry.path,
          text: new TextDecoder().decode(bytes),
        });
      }
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }
}

export class WebContainerHostExec {
  private nextProcessId = 1;
  private readonly processes = new Map<number, RunningProcess>();

  constructor(private readonly webcontainer: WebContainer) {}

  async start(request: ExecRequest): Promise<ExecOutputSnapshot> {
    const id = this.nextProcessId++;
    const startedAt = performance.now();
    const shell = request.shell?.trim() || "jsh";
    const shellArgs = request.shell?.trim()
      ? [request.login ? "-lc" : "-c", request.cmd]
      : ["-c", request.cmd];
    const process = await this.webcontainer.spawn(shell, shellArgs, {
      cwd: toContainerPath(request.workdir),
      output: true,
      terminal: request.tty
        ? {
            cols: request.terminal_size?.cols ?? 80,
            rows: request.terminal_size?.rows ?? 24,
          }
        : undefined,
    });
    const record: RunningProcess = {
      id,
      process,
      chunks: [],
      readOffset: 0,
      startedAt,
      exitCode: null,
      outputClosed: Promise.resolve(),
    };
    record.outputClosed = this.pumpOutput(record);
    process.exit.then((exitCode) => {
      record.exitCode = exitCode;
    });

    await waitForYieldOrExit(record, request.yield_time_ms);
    if (record.exitCode === null) {
      this.processes.set(id, record);
    } else {
      await settleOutput(record);
    }
    return snapshot(record, request.max_output_tokens, false);
  }

  async writeStdin(
    processId: number,
    input: string,
    options: OutputPollOptions,
  ): Promise<ExecOutputSnapshot> {
    const record = this.requiredProcess(processId);
    record.inputWriter ??= record.process.input.getWriter();
    await record.inputWriter.write(input);
    await waitForYieldOrExit(record, options.yield_time_ms);
    if (record.exitCode !== null) {
      await settleOutput(record);
      this.processes.delete(processId);
    }
    return snapshot(record, options.max_output_tokens, true);
  }

  async pollOutput(
    processId: number,
    options: OutputPollOptions,
  ): Promise<ExecOutputSnapshot> {
    const record = this.requiredProcess(processId);
    await waitForYieldOrExit(record, options.yield_time_ms);
    if (record.exitCode !== null) {
      await settleOutput(record);
      this.processes.delete(processId);
    }
    return snapshot(record, options.max_output_tokens, true);
  }

  async kill(processId: number): Promise<void> {
    const record = this.requiredProcess(processId);
    record.process.kill();
    await record.process.exit.catch(() => undefined);
    this.processes.delete(processId);
  }

  async resize(
    processId: number,
    size: { cols: number; rows: number },
  ): Promise<void> {
    this.requiredProcess(processId).process.resize(size);
  }

  private requiredProcess(processId: number) {
    const record = this.processes.get(processId);
    if (record === undefined) {
      throw new Error(`process ${processId} is not running`);
    }
    return record;
  }

  private async pumpOutput(record: RunningProcess) {
    const reader = record.process.output.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          return;
        }
        record.chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export async function exportWorkspaceSnapshot(webcontainer: WebContainer) {
  return webcontainer.export("workspace", { format: "json" });
}

export async function restoreWorkspaceSnapshot(
  webcontainer: WebContainer,
  snapshot: FileSystemTree,
) {
  await webcontainer.fs.rm("workspace", { recursive: true, force: true });
  await webcontainer.mount(workspaceRootTree(snapshot));
}

function workspaceRootTree(snapshot: FileSystemTree): FileSystemTree {
  if ("workspace" in snapshot) {
    return snapshot;
  }
  return {
    workspace: {
      directory: snapshot,
    },
  };
}

function toContainerPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized === "/workspace") {
    return "workspace";
  }
  if (normalized.startsWith("/workspace/")) {
    return normalized.slice(1);
  }
  if (normalized === "workspace" || normalized.startsWith("workspace/")) {
    return normalized;
  }
  throw new Error(`path escapes workspace: ${path}`);
}

function fromContainerPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized === "workspace") {
    return "/workspace";
  }
  if (normalized.startsWith("workspace/")) {
    return `/${normalized}`;
  }
  throw new Error(`container path escapes workspace: ${path}`);
}

function parentPath(path: string) {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : undefined;
}

async function waitForYieldOrExit(record: RunningProcess, yieldTimeMs: number) {
  await Promise.race([
    sleep(yieldTimeMs),
    record.process.exit.then(() => undefined),
  ]);
}

async function settleOutput(record: RunningProcess) {
  await Promise.race([record.outputClosed, sleep(25)]);
}

function snapshot(
  record: RunningProcess,
  maxOutputTokens: number | null | undefined,
  onlyNewOutput: boolean,
): ExecOutputSnapshot {
  const fullOutput = record.chunks.join("");
  const output = onlyNewOutput
    ? fullOutput.slice(record.readOffset)
    : fullOutput;
  record.readOffset = fullOutput.length;
  return {
    wall_time_ms: Math.max(0, Math.round(performance.now() - record.startedAt)),
    output: new TextEncoder().encode(output),
    process_id: record.exitCode === null ? record.id : null,
    exit_code: record.exitCode,
    original_token_count:
      maxOutputTokens === null || maxOutputTokens === undefined
        ? null
        : approxTokenCount(output),
  };
}

function approxTokenCount(text: string) {
  return Math.ceil(new TextEncoder().encode(text).byteLength / 4);
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
