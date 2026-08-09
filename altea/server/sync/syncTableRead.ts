import { Connector } from "../connection/connector";
import { ObjectName } from "../schema/objectName";
import type { Table } from "../schema/table";
import { Replacements } from "./synchronizer";
import { SqlPreCommandSimple } from "./sqlPreCommand";

// Helpers shared by the symbol & enum synchronizers (and any table-data sync) to read the CURRENT rows
// of a seeded table safely — ports of Signum's Administrator.ExistsTable / Synchronizer.UseOldTableName
// and the SynchronizationScript error-commenting. The point is: never blindly assume "empty → insert
// everything". Distinguish three cases:
//   • the table was RENAMED this run          → read it by its OLD name (readObjectName)
//   • the table does not exist yet             → no current rows (its CREATE is later in THIS script)
//   • the read fails for any other reason      → let it throw; the caller turns it into a commented
//                                                 SqlPreCommand so the script surfaces it, not a crash.

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

// Signum's Synchronizer.UseOldTableName: the name to READ current rows from during synchronization is
// the table's OLD (pre-rename) DB name when a rename was learned this run, else its current model name —
// the RENAME DDL is only in the script being generated, not yet applied, so the physical table still has
// its old name at read time. Uses the keyTablesInverse map (model-new-name → old-DB-name) populated by
// the tables synchronizer.
export function readObjectName(table: Table, replacements: Replacements): ObjectName {
    const inverse = replacements.tryGetC(Replacements.keyTablesInverse);
    const oldFull = inverse?.get(table.name.toString());
    if (oldFull == null)
        return table.name;
    // A rename changes the bare name, not the schema — reuse the model table's schema and swap the name.
    const schemaStr = table.name.schema.toString();
    const bare = schemaStr && oldFull.startsWith(schemaStr + ".") ? oldFull.slice(schemaStr.length + 1) : oldFull;
    return new ObjectName(bare, table.name.schema);
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
