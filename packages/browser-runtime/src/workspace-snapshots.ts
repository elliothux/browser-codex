// Browser runtime persistence adapter for workspace bytes. Upstream native
// Codex reconstructs rollout/session state through
// external/codex/codex-rs/core/src/rollout.rs while filesystem state remains
// in the native execution environment. This browser runtime owns the missing
// WebContainer filesystem boundary by storing binary workspace snapshots in
// OPFS and keeping SQLite limited to session/message metadata.

const rootDir = "browser-codex";
const workspacesDir = "workspaces";
const latestSnapshotFile = "latest.wcsnap";

export class OpfsWorkspaceSnapshotStore {
  async saveLatest(sessionId: string, snapshot: Uint8Array): Promise<void> {
    const directory = await this.workspaceDirectory(sessionId, true);
    const file = await directory.getFileHandle(latestSnapshotFile, {
      create: true,
    });
    const writable = await file.createWritable();
    try {
      await writable.write(arrayBufferCopy(snapshot));
    } finally {
      await writable.close();
    }
  }

  async loadLatest(sessionId: string): Promise<Uint8Array | null> {
    try {
      const directory = await this.workspaceDirectory(sessionId, false);
      if (directory === null) {
        return null;
      }
      const file = await directory.getFileHandle(latestSnapshotFile);
      return new Uint8Array(await (await file.getFile()).arrayBuffer());
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw new Error(`workspace snapshot load failed: ${errorToText(error)}`);
    }
  }

  pathForSession(sessionId: string) {
    return `/${rootDir}/${workspacesDir}/${safeSegment(sessionId)}/${latestSnapshotFile}`;
  }

  private async workspaceDirectory(
    sessionId: string,
    create: true,
  ): Promise<FileSystemDirectoryHandle>;
  private async workspaceDirectory(
    sessionId: string,
    create: false,
  ): Promise<FileSystemDirectoryHandle | null>;
  private async workspaceDirectory(sessionId: string, create: boolean) {
    const root = await opfsRoot();
    const app = await getDirectory(root, rootDir, create);
    if (app === null) return null;
    const workspaces = await getDirectory(app, workspacesDir, create);
    if (workspaces === null) return null;
    return getDirectory(workspaces, safeSegment(sessionId), create);
  }
}

async function opfsRoot() {
  if (navigator.storage?.getDirectory === undefined) {
    throw new Error("OPFS is unavailable in this browser context");
  }
  return navigator.storage.getDirectory();
}

async function getDirectory(
  parent: FileSystemDirectoryHandle,
  name: string,
  create: boolean,
) {
  try {
    return await parent.getDirectoryHandle(name, { create });
  } catch (error) {
    if (!create && isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function arrayBufferCopy(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function isNotFoundError(error: unknown) {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function errorToText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
