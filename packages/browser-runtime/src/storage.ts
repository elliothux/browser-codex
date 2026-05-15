// Browser storage adapter for the upstream Codex session/history persistence
// boundary. Upstream native Codex stores rollout/session data through native
// state crates; this package uses Turso SQLite in the browser and keeps the
// wasm core's SessionSnapshot as opaque JSON.

import { connect } from "@tursodatabase/database-wasm/bundle";
import type { FileSystemTree } from "@webcontainer/api";
import type {
  AgentTrace,
  RuntimeMessage,
  RuntimeSession,
  RuntimeSessionSummary,
  SessionSnapshot,
} from "./types";

type SessionRow = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  model: string;
  wasm_session_json: string | null;
  workspace_snapshot_json: string | null;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: "assistant" | "user";
  text: string;
  created_at: number;
  trace_json: string | null;
};

export class TursoConversationStore {
  private db: TursoDatabase | undefined;

  constructor(private readonly path: string) {}

  async init() {
    const db = (this.db ??= await connect(this.path));
    await db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        model TEXT NOT NULL,
        wasm_session_json TEXT,
        workspace_snapshot_json TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('assistant', 'user')),
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        trace_json TEXT
      );

      CREATE INDEX IF NOT EXISTS messages_session_created_idx
        ON messages(session_id, created_at);
    `);
  }

  async listSessions(): Promise<RuntimeSessionSummary[]> {
    const rows = await this.database().all(
      `SELECT id, title, created_at, updated_at, model
       FROM sessions
       ORDER BY updated_at DESC`,
    );
    return rows.map((row) => summaryFromRow(row as SessionRow));
  }

  async createSession(input: {
    id: string;
    title: string;
    model: string;
    workspaceSnapshot: FileSystemTree | null;
  }): Promise<RuntimeSession> {
    const now = Date.now();
    await this.database().run(
      `INSERT INTO sessions
        (id, title, created_at, updated_at, model, wasm_session_json, workspace_snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.title,
      now,
      now,
      input.model,
      null,
      encodeJson(input.workspaceSnapshot),
    );
    return {
      id: input.id,
      title: input.title,
      createdAt: now,
      updatedAt: now,
      model: input.model,
      wasmSession: null,
      workspaceSnapshot: input.workspaceSnapshot,
      messages: [],
    };
  }

  async loadSession(id: string): Promise<RuntimeSession | undefined> {
    const row = (await this.database().get(
      `SELECT *
       FROM sessions
       WHERE id = ?`,
      id,
    )) as SessionRow | undefined;
    if (row === undefined || row === null) {
      return undefined;
    }
    const messages = await this.messagesForSession(id);
    return {
      ...summaryFromRow(row),
      wasmSession: decodeJson<SessionSnapshot>(row.wasm_session_json),
      workspaceSnapshot: decodeJson<FileSystemTree>(
        row.workspace_snapshot_json,
      ),
      messages,
    };
  }

  async saveTurn(input: {
    session: RuntimeSession;
    wasmSession: SessionSnapshot;
    workspaceSnapshot: FileSystemTree;
    userText: string;
    assistantText: string;
    trace: AgentTrace;
  }): Promise<RuntimeSession> {
    const now = Date.now();
    const title =
      input.session.messages.length === 0
        ? titleFromUserText(input.userText)
        : input.session.title;
    await this.database().run(
      `UPDATE sessions
       SET title = ?,
           updated_at = ?,
           model = ?,
           wasm_session_json = ?,
           workspace_snapshot_json = ?
       WHERE id = ?`,
      title,
      now,
      input.session.model,
      encodeJson(input.wasmSession),
      encodeJson(input.workspaceSnapshot),
      input.session.id,
    );
    const userMessage = makeMessage({
      sessionId: input.session.id,
      role: "user",
      text: input.userText,
      createdAt: now - 1,
    });
    const assistantMessage = makeMessage({
      sessionId: input.session.id,
      role: "assistant",
      text: input.assistantText,
      createdAt: now,
      trace: input.trace,
    });
    await this.insertMessage(userMessage);
    await this.insertMessage(assistantMessage);
    return {
      ...input.session,
      title,
      updatedAt: now,
      wasmSession: input.wasmSession,
      workspaceSnapshot: input.workspaceSnapshot,
      messages: [...input.session.messages, userMessage, assistantMessage],
    };
  }

  private async messagesForSession(
    sessionId: string,
  ): Promise<RuntimeMessage[]> {
    const rows = await this.database().all(
      `SELECT *
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC`,
      sessionId,
    );
    return rows.map((row) => messageFromRow(row as MessageRow));
  }

  private async insertMessage(message: RuntimeMessage) {
    await this.database().run(
      `INSERT INTO messages
        (id, session_id, role, text, created_at, trace_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      message.id,
      message.sessionId,
      message.role,
      message.text,
      message.createdAt,
      encodeJson(message.trace ?? null),
    );
  }

  private database() {
    if (this.db === undefined) {
      throw new Error("TursoConversationStore.init() must be called first");
    }
    return this.db;
  }
}

type TursoDatabase = {
  exec: (sql: string) => Promise<void>;
  run: (sql: string, ...parameters: unknown[]) => Promise<unknown>;
  get: (sql: string, ...parameters: unknown[]) => Promise<unknown>;
  all: (sql: string, ...parameters: unknown[]) => Promise<unknown[]>;
};

function summaryFromRow(row: SessionRow): RuntimeSessionSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    model: row.model,
  };
}

function messageFromRow(row: MessageRow): RuntimeMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    text: row.text,
    createdAt: Number(row.created_at),
    trace: decodeJson<AgentTrace>(row.trace_json) ?? undefined,
  };
}

function makeMessage(input: {
  sessionId: string;
  role: "assistant" | "user";
  text: string;
  createdAt: number;
  trace?: AgentTrace;
}): RuntimeMessage {
  return {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    role: input.role,
    text: input.text,
    createdAt: input.createdAt,
    trace: input.trace,
  };
}

function titleFromUserText(text: string) {
  const compact = text.trim().replace(/\s+/g, " ");
  return compact.length > 48
    ? `${compact.slice(0, 45)}...`
    : compact || "New session";
}

function encodeJson(value: unknown) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function decodeJson<T>(value: string | null | undefined): T | null {
  if (value === null || value === undefined || value.length === 0) {
    return null;
  }
  return JSON.parse(value) as T;
}
