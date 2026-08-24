/**
 * Store selection — one config knob (RFC-001 §4: SQLite solo, Postgres team, ONE
 * repository interface). A `postgres://` storePath opens the team driver; anything else
 * is a local SQLite file path. `pg` is imported lazily so the solo path never loads it.
 */
import { openPgStore, openStore, type Store } from '@spicyspec/store';

export async function openConfiguredStore(storePath: string): Promise<Store> {
  if (/^postgres(ql)?:\/\//.test(storePath)) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: storePath });
    return openPgStore({ client: pool as never, end: () => pool.end() });
  }
  return openStore(storePath);
}
