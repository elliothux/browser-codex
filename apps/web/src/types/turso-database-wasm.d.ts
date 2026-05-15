declare module "@tursodatabase/database-wasm/vite" {
  export type TursoStatementResult = {
    changes: number;
    lastInsertRowid: number;
  };

  export type TursoDatabase = {
    exec(sql: string): Promise<void>;
    run(
      sql: string,
      ...bindParameters: unknown[]
    ): Promise<TursoStatementResult>;
    get(
      sql: string,
      ...bindParameters: unknown[]
    ): Promise<Record<string, unknown> | undefined>;
    all(
      sql: string,
      ...bindParameters: unknown[]
    ): Promise<Array<Record<string, unknown>>>;
    close(): Promise<void>;
  };

  export function connect(path: string): Promise<TursoDatabase>;
}

declare module "@tursodatabase/database-wasm/bundle" {
  export type TursoStatementResult = {
    changes: number;
    lastInsertRowid: number;
  };

  export type TursoDatabase = {
    exec(sql: string): Promise<void>;
    run(
      sql: string,
      ...bindParameters: unknown[]
    ): Promise<TursoStatementResult>;
    get(
      sql: string,
      ...bindParameters: unknown[]
    ): Promise<Record<string, unknown> | undefined>;
    all(
      sql: string,
      ...bindParameters: unknown[]
    ): Promise<Array<Record<string, unknown>>>;
    close(): Promise<void>;
  };

  export function connect(path: string): Promise<TursoDatabase>;
}
