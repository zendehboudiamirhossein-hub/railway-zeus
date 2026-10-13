/**
 * Cloudflare D1 -> node:sqlite compatibility adapter.
 *
 * Supports the full D1 surface used by the panel:
 *   - db.prepare(sql)                    -> D1PreparedStatement
 *   - stmt.bind(...params)               -> new bound statement (chainable)
 *   - stmt.first(col?)                   -> Promise<row | value | null>
 *   - stmt.all()                         -> Promise<{ results, success, meta }>
 *   - stmt.run()                         -> Promise<{ success, meta: { changes, last_row_id, ... } }>
 *   - stmt.raw({ columnNames? })         -> Promise<rows-as-arrays | [cols, ...rows]>
 *   - db.batch([stmt, ...])              -> Promise<[runResults]> (transactional)
 *   - db.exec(sql)                       -> raw multi-statement execution
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

function normalizeParam(p) {
  if (p === undefined) return null;
  if (p === null || typeof p === "number" || typeof p === "string" || typeof p === "bigint") return p;
  if (typeof p === "boolean") return p ? 1 : 0;
  if (p instanceof Uint8Array) return Buffer.from(p.buffer, p.byteOffset, p.byteLength);
  if (p instanceof Date) return p.toISOString();
  return String(p);
}

const emptyMeta = () => ({
  duration: 0,
  changes: 0,
  last_row_id: 0,
  rows_read: 0,
  rows_written: 0,
  size_after: 0,
  rows_affected: 0,
  changed_db: false,
});

class D1Prepared {
  constructor(getStmt, sql, params) {
    this.__getStmt = getStmt;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new D1Prepared(this.__getStmt, this.sql, params.map(normalizeParam));
  }

  async first(col) {
    const rows = this.__getStmt(this.sql).all(...this.params);
    const row = rows.length ? rows[0] : null;
    if (row === null || row === undefined) return null;
    if (col !== undefined && col !== null) {
      return Object.prototype.hasOwnProperty.call(row, col) ? row[col] : null;
    }
    return row;
  }

  async all() {
    const rows = this.__getStmt(this.sql).all(...this.params);
    return { results: rows, success: true, meta: emptyMeta() };
  }

  async run() {
    const info = this.__getStmt(this.sql).run(...this.params);
    const changes = Number(info && info.changes) || 0;
    const lastRowId = Number(info && info.lastInsertRowid) || 0;
    return {
      success: true,
      meta: { ...emptyMeta(), changes, rows_affected: changes, last_row_id: lastRowId, changed_db: changes > 0 },
    };
  }

  async raw(opts) {
    const rows = this.__getStmt(this.sql).all(...this.params);
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const asArrays = rows.map((r) => cols.map((c) => r[c]));
    if (opts && opts.columnNames) return [cols, ...asArrays];
    return asArrays;
  }
}

export function createD1(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  try { db.exec("PRAGMA journal_mode = WAL;"); } catch { }
  try { db.exec("PRAGMA synchronous = NORMAL;"); } catch { }
  try { db.exec("PRAGMA busy_timeout = 5000;"); } catch { }
  try { db.exec("PRAGMA foreign_keys = OFF;"); } catch { }

  // Small prepared-statement cache (LRU-ish)
  const stmtCache = new Map();
  const getStmt = (sql) => {
    let s = stmtCache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      if (stmtCache.size > 400) {
        const oldest = stmtCache.keys().next().value;
        stmtCache.delete(oldest);
      }
      stmtCache.set(sql, s);
    }
    return s;
  };

  return {
    prepare(sql) {
      return new D1Prepared(getStmt, String(sql), []);
    },
    async batch(statements) {
      const list = Array.from(statements || []);
      const results = [];
      // Fully synchronous section: no await between BEGIN and COMMIT, so concurrent
      // requests can never interleave or start a nested transaction.
      db.exec("BEGIN");
      try {
        for (const s of list) {
          const stmt = getStmt(s.sql);
          if (/^\s*(select|pragma|with)\b/i.test(s.sql)) {
            results.push({ results: stmt.all(...s.params), success: true, meta: emptyMeta() });
          } else {
            const info = stmt.run(...s.params);
            const changes = Number(info && info.changes) || 0;
            results.push({
              success: true,
              meta: { ...emptyMeta(), changes, rows_affected: changes, last_row_id: Number(info && info.lastInsertRowid) || 0, changed_db: changes > 0 },
            });
          }
        }
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { }
        throw e;
      }
      return results;
    },
    async exec(sql) {
      db.exec(String(sql));
      return { success: true, meta: emptyMeta() };
    },
    async dump() {
      throw new Error("D1 dump() is not supported on Node runtime");
    },
    withSession() {
      throw new Error("D1 sessions are not supported on Node runtime");
    },
  };
}
