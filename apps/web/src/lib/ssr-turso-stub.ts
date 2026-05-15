export async function connect(): Promise<never> {
  throw new Error("Turso browser database is unavailable during SSR.");
}

export class Database {}

export class SqliteError extends Error {}
