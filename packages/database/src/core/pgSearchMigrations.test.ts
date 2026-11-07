import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// @ts-ignore tsgo handle esm import cjs and compatibility issues
import {
  assertPgSearchReady,
  PgSearchNotReadyError,
} from '../../../../scripts/migrateServerDB/pgSearchGuard';

const migrationsFolder = join(__dirname, '../../migrations');

/**
 * Self-hosted deployments on plain PostgreSQL (Aiven, RDS, Neon without pg_search) select
 * `FTS_SEARCH_PROVIDER=pg_like` or `elasticsearch`, so the historical pg_search migrations must
 * skip themselves instead of aborting the upgrade. PGlite ships without pg_search, matching them.
 */
describe('pg_search migrations on a database without the extension', () => {
  const client = new PGlite({ extensions: { vector } });
  const db = drizzle({ client });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder });
    // Replaying every migration takes ~1s alone but can exceed the default timeout under a
    // fully parallel suite.
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it('applies every migration and skips BM25 setup', async () => {
    const applied = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(applied.rows[0].count).toBe(readMigrationFiles({ migrationsFolder }).length);

    const extension = await db.execute(sql`SELECT 1 FROM pg_extension WHERE extname = 'pg_search'`);
    expect(extension.rows).toHaveLength(0);

    const bm25Indexes = await db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE indexname LIKE '%_bm25_idx'`,
    );
    expect(bm25Indexes.rows).toHaveLength(0);
  });

  /** The migration entrypoints run this guard, so a skipped pg_search cannot reach the first search. */
  describe('startup guard', () => {
    const query = (text: string) => db.execute(sql.raw(text));

    it('stops a deployment that leaves the provider at the pg_search default', async () => {
      const error = await assertPgSearchReady(query, {}).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(PgSearchNotReadyError);
      expect((error as Error).message).toContain('`pg_search` (the default)');
      expect((error as Error).message).toContain('FTS_SEARCH_PROVIDER=pg_like');
    });

    it('stops a deployment that selects pg_search explicitly', async () => {
      await expect(
        assertPgSearchReady(query, { FTS_SEARCH_PROVIDER: 'pg_search' }),
      ).rejects.toBeInstanceOf(PgSearchNotReadyError);
    });

    it.each(['pg_like', 'elasticsearch'])('lets %s start without pg_search', async (provider) => {
      await expect(
        assertPgSearchReady(query, { FTS_SEARCH_PROVIDER: provider }),
      ).resolves.toBeUndefined();
    });
  });
});

// PGlite cannot advertise pg_search or install a custom extension. Inject the database's
// response at the CREATE EXTENSION statement while executing the real migration and handler.
describe('pg_search advertised but installation denied', () => {
  const migrationPath = join(migrationsFolder, '0090_enable_pg_search.sql');
  const availabilityCheck =
    "EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search')";
  const installStatement = 'CREATE EXTENSION IF NOT EXISTS pg_search;';

  const injectInstallError = (migration: string, code: string) => {
    expect(migration.split(availabilityCheck)).toHaveLength(2);
    expect(migration.split(installStatement)).toHaveLength(2);
    return migration
      .replace(availabilityCheck, 'TRUE')
      .replace(
        installStatement,
        `RAISE EXCEPTION 'simulated extension install failure' USING ERRCODE = '${code}';`,
      );
  };

  it('continues replay after insufficient privilege without creating BM25 indexes', async () => {
    const { cp, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const temporaryFolder = await mkdtemp(join(tmpdir(), 'pg-search-migrations-'));
    const client = new PGlite({ extensions: { vector } });

    try {
      await cp(migrationsFolder, temporaryFolder, { recursive: true });
      const migration = await readFile(migrationPath, 'utf8');
      await writeFile(
        join(temporaryFolder, '0090_enable_pg_search.sql'),
        injectInstallError(migration, '42501'),
      );
      const db = drizzle({ client });
      await migrate(db, { migrationsFolder: temporaryFolder });

      const applied = await db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
      );
      expect(applied.rows[0].count).toBe(readMigrationFiles({ migrationsFolder }).length);
      const extension = await db.execute(
        sql`SELECT 1 FROM pg_extension WHERE extname = 'pg_search'`,
      );
      expect(extension.rows).toHaveLength(0);
      const indexes = await db.execute(
        sql`SELECT indexname FROM pg_indexes WHERE indexname LIKE '%_bm25_idx'`,
      );
      expect(indexes.rows).toHaveLength(0);
    } finally {
      await client.close();
      await rm(temporaryFolder, { force: true, recursive: true });
    }
  }, 30_000);

  it('propagates unexpected installation errors', async () => {
    const { readFile } = await import('node:fs/promises');
    const client = new PGlite();
    try {
      const migration = await readFile(migrationPath, 'utf8');
      await expect(client.exec(injectInstallError(migration, '0A000'))).rejects.toMatchObject({
        code: '0A000',
      });
    } finally {
      await client.close();
    }
  });
});
