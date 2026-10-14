/**
 * Adaptador de SQLite al contrato SqlDatabase (API estilo D1).
 * Solo se usa en Node (desarrollo local, pruebas o un servidor como EC2);
 * nunca se incluye en el bundle de Cloudflare.
 *
 * Motor:
 *   1. `node:sqlite`, que viene dentro de Node 22.5+ (no requiere compilar nada:
 *      evita los problemas del módulo nativo en Windows).
 *   2. `better-sqlite3` como respaldo en versiones de Node más antiguas.
 * Se puede forzar con la variable SQLITE_DRIVER=node | better-sqlite3.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { SqlAllResult, SqlDatabase, SqlRunResult, SqlStatement, SqlValue } from './database.js';

/** Lo mínimo que se necesita de cualquiera de los dos motores. */
interface DriverStatement {
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
  run(...params: SqlValue[]): { changes: number | bigint };
}

interface Driver {
  readonly name: string;
  prepare(sql: string): DriverStatement;
  exec(sql: string): void;
  /** true si la sentencia devuelve filas (SELECT, RETURNING…). */
  returnsRows(statement: DriverStatement, sql: string): boolean;
  close(): void;
}

const ROW_RETURNING_SQL = /^\s*(SELECT|WITH|PRAGMA|VALUES)\b|\bRETURNING\b/i;

/** Oculta solo el aviso "SQLite is an experimental feature" (es estable para este uso). */
function loadBuiltinSqlite(): unknown {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes('SQLite is an experimental feature')) return;
    (originalEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return process.getBuiltinModule?.('node:sqlite');
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function openNodeBuiltinDriver(filename: string): Driver | null {
  const sqliteModule = loadBuiltinSqlite() as
    | { DatabaseSync: new (filename: string) => { prepare(sql: string): DriverStatement & { columns?: () => unknown[] }; exec(sql: string): void; close(): void } }
    | undefined;
  if (!sqliteModule?.DatabaseSync) return null;
  const database = new sqliteModule.DatabaseSync(filename);
  return {
    name: 'node:sqlite',
    prepare: (sql) => database.prepare(sql),
    exec: (sql) => database.exec(sql),
    returnsRows: (statement, sql) => {
      const columns = (statement as { columns?: () => unknown[] }).columns;
      return typeof columns === 'function' ? columns.call(statement).length > 0 : ROW_RETURNING_SQL.test(sql);
    },
    close: () => database.close(),
  };
}

function openBetterSqliteDriver(filename: string): Driver {
  const require = createRequire(import.meta.url);
  const BetterSqlite = require('better-sqlite3') as new (filename: string) => {
    prepare(sql: string): DriverStatement & { reader: boolean };
    exec(sql: string): void;
    close(): void;
  };
  const database = new BetterSqlite(filename);
  return {
    name: 'better-sqlite3',
    prepare: (sql) => database.prepare(sql),
    exec: (sql) => database.exec(sql),
    returnsRows: (statement) => (statement as unknown as { reader: boolean }).reader,
    close: () => database.close(),
  };
}

function openDriver(filename: string): Driver {
  const preferred = process.env.SQLITE_DRIVER;
  if (preferred !== 'better-sqlite3') {
    const builtin = openNodeBuiltinDriver(filename);
    if (builtin) return builtin;
    if (preferred === 'node') throw new Error('Esta versión de Node no incluye node:sqlite. Usa Node 22.5 o superior.');
  }
  return openBetterSqliteDriver(filename);
}

class NodeSqliteStatement implements SqlStatement {
  constructor(
    private readonly owner: NodeSqliteDatabase,
    readonly sql: string,
    readonly params: SqlValue[] = [],
  ) {}

  bind(...values: SqlValue[]): SqlStatement {
    return new NodeSqliteStatement(this.owner, this.sql, values);
  }

  async first<TRow>(): Promise<TRow | null> {
    return normalizeRow((this.owner.driver.prepare(this.sql).get(...this.params) as TRow | undefined) ?? null);
  }

  async all<TRow>(): Promise<SqlAllResult<TRow>> {
    return { results: this.owner.driver.prepare(this.sql).all(...this.params).map((row) => normalizeRow(row as TRow)) };
  }

  async run(): Promise<SqlRunResult> {
    return this.execute();
  }

  /** Ejecuta de forma síncrona (usado dentro de transacciones). */
  execute(): SqlRunResult & Partial<SqlAllResult<unknown>> {
    const preparedStatement = this.owner.driver.prepare(this.sql);
    if (this.owner.driver.returnsRows(preparedStatement, this.sql)) {
      return { results: preparedStatement.all(...this.params).map(normalizeRow), meta: { changes: 0 } };
    }
    const info = preparedStatement.run(...this.params);
    return { meta: { changes: Number(info.changes) } };
  }
}

/** node:sqlite entrega objetos sin prototipo; se convierten en objetos normales. */
function normalizeRow<TRow>(row: TRow): TRow {
  return row && typeof row === 'object' && Object.getPrototypeOf(row) === null ? ({ ...row } as TRow) : row;
}

export class NodeSqliteDatabase implements SqlDatabase {
  /** @internal */
  readonly driver: Driver;

  constructor(filename: string) {
    this.driver = openDriver(filename);
    // Si otro proceso tiene la base ocupada, espera hasta 5 s y luego falla con un error claro (no se queda colgado).
    this.driver.exec('PRAGMA busy_timeout = 5000');
    if (filename !== ':memory:') this.driver.exec('PRAGMA journal_mode = WAL');
    this.driver.exec('PRAGMA foreign_keys = ON');
  }

  get driverName(): string {
    return this.driver.name;
  }

  prepare(sql: string): SqlStatement {
    return new NodeSqliteStatement(this, sql);
  }

  async batch(statements: SqlStatement[]): Promise<Array<SqlRunResult & Partial<SqlAllResult<unknown>>>> {
    return this.transaction(() => statements.map((statement) => (statement as NodeSqliteStatement).execute()));
  }

  /** Ejecuta todo o nada. */
  private transaction<TResult>(work: () => TResult): TResult {
    this.driver.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.driver.exec('COMMIT');
      return result;
    } catch (error) {
      this.driver.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Aplica en orden los archivos de /migrations que aún no se hayan aplicado.
   * (En Cloudflare esto lo hace `wrangler d1 migrations apply`.)
   */
  applyMigrations(migrationsDirectory: string): string[] {
    this.driver.exec('CREATE TABLE IF NOT EXISTS _app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const appliedNames = new Set(
      (this.driver.prepare('SELECT name FROM _app_migrations').all() as Array<{ name: string }>).map((row) => row.name),
    );

    const pendingFiles = readdirSync(migrationsDirectory)
      .filter((fileName) => fileName.endsWith('.sql') && !appliedNames.has(fileName))
      .sort();

    for (const fileName of pendingFiles) {
      const migrationSql = readFileSync(path.join(migrationsDirectory, fileName), 'utf8');
      this.transaction(() => {
        this.driver.exec(migrationSql);
        this.driver.prepare('INSERT INTO _app_migrations (name, applied_at) VALUES (?, ?)').run(fileName, new Date().toISOString());
      });
    }
    return pendingFiles;
  }

  close(): void {
    this.driver.close();
  }
}
