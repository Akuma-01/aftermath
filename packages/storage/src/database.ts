import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Sql {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  kind: 'PGlite' | 'PostgreSQL';
  transaction<T>(run: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDatabase(path?: string, url?: string): Promise<Database> {
  if (!url) {
    const db = await PGlite.create(path);
    return {
      kind: 'PGlite',
      query: db.query.bind(db),
      transaction: db.transaction.bind(db),
      close: () => db.close(),
    };
  }
  const pool = new pg.Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000 });
  pool.on('error', (error) => console.error('PostgreSQL idle connection error:', error.message));
  return {
    kind: 'PostgreSQL',
    async query<T>(sql: string, params?: unknown[]) {
      return { rows: (await pool.query(sql, params)).rows as T[] };
    },
    async transaction<T>(run: (tx: Sql) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await run({
          async query<R>(sql: string, params?: unknown[]) {
            return { rows: (await client.query(sql, params)).rows as R[] };
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
