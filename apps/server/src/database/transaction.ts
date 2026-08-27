import type pg from "pg";

export async function inTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>, options: { readonlyOnly?: boolean; isolation?: "REPEATABLE READ" | "SERIALIZABLE" } = {}): Promise<T> {
  const client = await pool.connect();
  try {
    const modifiers = `${options.isolation ? ` ISOLATION LEVEL ${options.isolation}` : ""}${options.readonlyOnly ? " READ ONLY" : ""}`;
    await client.query(`BEGIN${modifiers}`);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
