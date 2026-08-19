import { Connector } from "../connection/connector";
import type { ObjectName } from "../schema/objectName";
import { SqlPreCommandSimple } from "./sqlPreCommand";

// Low-level helpers behind the synchronizers' table reads: Signum's Administrator.ExistsTable and the
// SynchronizationScript error-commenting. The actual row reading lives in Administrator.tryRetrieveAll,
// which scopes the in-memory Table to its pre-rename name (Synchronizer.useOldTableName) and then runs an
// ordinary LINQ query — no raw SQL.

// Signum's Administrator.ExistsTable: a lightweight catalog existence check. Postgres to_regclass
// returns NULL for a missing relation; SQL Server OBJECT_ID returns NULL. The name is model-derived (not
// user input), so inlining it as a string literal is safe (single quotes are still escaped defensively).
export async function existsTable(name: ObjectName): Promise<boolean> {
    const connector = Connector.current();
    const rendered = connector.sqlBuilder.objectName(name);
    const literal = rendered.replace(/'/g, "''");
    const sql = connector.isPostgres
        ? `SELECT to_regclass('${literal}') AS r`
        : `SELECT OBJECT_ID('${literal}') AS r`;
    const rows = await connector.executeQuery(sql) as Array<{ r: unknown }>;
    return rows[0]?.r != null;
}

// Signum's SynchronizationScript catch: turn a thrown sync error into a COMMENTED-OUT command so script
// generation continues and the error is visible in the output (and no-ops if the script is executed)
// instead of aborting the whole synchronization. (Signum's guidance: "…it's probably ok, execute this
// script and try again".)
export function commentedError(where: string, error: unknown): SqlPreCommandSimple {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const body = [`-- Exception on ${where}`, ...message.split("\n").map(l => "-- " + l)].join("\n");
    return new SqlPreCommandSimple(body);
}
