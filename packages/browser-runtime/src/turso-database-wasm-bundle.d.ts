declare module "@tursodatabase/database-wasm/bundle" {
  export class SqliteError extends Error {
    code: string;
    rawCode: number;
  }

  export type Database = {
    exec(sql: string): Promise<void>;
    run(sql: string, ...parameters: unknown[]): Promise<unknown>;
    get(sql: string, ...parameters: unknown[]): Promise<unknown>;
    all(sql: string, ...parameters: unknown[]): Promise<unknown[]>;
    close(): Promise<void>;
  };

  export function connect(
    path: string,
    options?: Record<string, unknown>,
  ): Promise<Database>;
}
