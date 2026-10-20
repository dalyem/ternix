import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './migrations.js';

export type Db = Database.Database;

export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Apply every migration that is not yet recorded. Returns the ids that ran. */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    db
      .prepare<[], { id: number }>('SELECT id FROM schema_migrations')
      .all()
      .map((row) => row.id),
  );
  const record = db.prepare(
    'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
  );
  const ran: number[] = [];
  for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, migration.name, new Date().toISOString());
    })();
    ran.push(migration.id);
  }
  return ran;
}

/** Caches prepared statements by SQL text. */
export class Sql {
  private readonly cache = new Map<string, Database.Statement>();
  constructor(readonly db: Db) {}

  q<Params extends unknown[] = unknown[], Row = unknown>(
    sql: string,
  ): Database.Statement<Params, Row> {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt as Database.Statement<Params, Row>;
  }
}
