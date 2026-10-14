/**
 * Contrato mínimo de base de datos SQL.
 *
 * Es un subconjunto de la API de Cloudflare D1, así el código de negocio
 * funciona igual con:
 *   • Cloudflare D1 (producción gratuita)        → se usa directamente.
 *   • SQLite local con node:sqlite o better-sqlite3 (Node/EC2) → ver nodeSqliteDatabase.ts.
 *
 * Reglas de uso:
 *   • SIEMPRE parámetros con "?" y bind(); nunca concatenar valores en SQL.
 *   • batch() es atómico: o se aplican todas las sentencias o ninguna.
 */

export type SqlValue = string | number | null;

export interface SqlRunResult {
  meta: { changes: number };
}

export interface SqlAllResult<TRow> {
  results: TRow[];
}

export interface SqlStatement {
  bind(...values: SqlValue[]): SqlStatement;
  first<TRow = Record<string, unknown>>(): Promise<TRow | null>;
  all<TRow = Record<string, unknown>>(): Promise<SqlAllResult<TRow>>;
  run(): Promise<SqlRunResult>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<Array<SqlRunResult & Partial<SqlAllResult<unknown>>>>;
}

/** Convierte booleanos a 0/1 (SQLite no tiene tipo booleano). */
export function toSqlBoolean(value: boolean): number {
  return value ? 1 : 0;
}

/** Genera un "?, ?, ?" para cláusulas IN con parámetros. */
export function sqlPlaceholders(count: number): string {
  if (count < 1) throw new Error('sqlPlaceholders requiere al menos un valor');
  return Array.from({ length: count }, () => '?').join(', ');
}
