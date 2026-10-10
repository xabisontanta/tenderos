import pg from "pg";

// Return timestamps as ISO strings and numerics as numbers, matching the
// shapes in types/database.ts.
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz
pg.types.setTypeParser(1114, (v) => new Date(`${v}Z`).toISOString()); // timestamp
pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric
pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // int8

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max, application_name: "tenderos-worker" });
}

/**
 * Runs fn inside a transaction. When actorAgentId is given it is recorded as
 * the acting agent for audit and tender-history triggers.
 */
export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>, actorAgentId?: string | null): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (actorAgentId) await client.query("select set_config('app.actor_agent_id', $1, true)", [actorAgentId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
