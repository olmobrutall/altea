import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { reflect } from "@altea/altea/data/reflection"; // anchor for the transformer's @field injection
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, uniqueIndex } from "@altea/altea/data/decorators";
import { SchemaBuilder } from "@altea/altea/server/schema";
import type { Table } from "@altea/altea/server/schema/table";
import type { Connector } from "@altea/altea/server/connection/connector";
import { PostgresConnector } from "@altea/altea/server/connection/postgresConnector";
import { SqlServerConnector } from "@altea/altea/server/connection/sqlServerConnector";
import { ForeignKeyException, UniqueKeyException } from "@altea/altea/server/connection/databaseExceptions";

// Port coverage for Signum's ForeignKeyException / UniqueKeyException (Signum/Engine/Exceptions.cs):
// a driver constraint error is re-read through the Schema and re-raised as a sentence naming the entity
// type and the property.
//
// DB-FREE, and deliberately so: the whole translation is a pure function of (schema, driver error,
// failing SQL), so feeding each connector's `replaceException` a hand-built error object exercises the
// entire path — including the SQL SERVER one, whose message regexes are otherwise untestable on a
// machine with no SQL Server instance. The end-to-end proof that these codes really arrive in this shape
// lives in test/server/orm/constraintViolations.test.ts, which provokes them against a real database.

@entity("Main", "Master")
class CxLabel extends Entity {
    @uniqueIndex name: string = "";
}

@entity("Main", "Master")
class CxAlbum extends Entity {
    title: string = "";
    label: Lite<CxLabel> | null = null;  // FK → CxLabel
}

// A connector subclass purely to reach the PROTECTED seam (Signum's `ReplaceException`). Neither
// constructor connects — the pool is created on first use — so this stays offline.
class ProbePostgres extends PostgresConnector {
    translate(error: unknown, sql: string): unknown { return this.replaceException(error, sql); }
}
class ProbeSqlServer extends SqlServerConnector {
    translate(error: unknown, sql: string): unknown { return this.replaceException(error, sql); }
}

interface Fixture {
    readonly connector: Connector & { translate(error: unknown, sql: string): unknown };
    readonly albumTable: Table;
    readonly labelTable: Table;
    /** The FK column CxAlbum.label owns, and the constraint name the generator would give it. */
    readonly fkColumn: string;
    readonly fkName: string;
    /** CxLabel's unique index over `name`, by the name the generator would give it. */
    readonly uniqueName: string;
}

function build(isPostgres: boolean): Fixture {
    const sb = new SchemaBuilder();
    sb.settings.isPostgres = isPostgres;
    const labelTable = sb.include(CxLabel).table;
    const albumTable = sb.include(CxAlbum).table;
    sb.complete();

    const connector = isPostgres
        ? new ProbePostgres(sb.schema, "postgresql://offline/none")
        : new ProbeSqlServer(sb.schema, "Server=offline;Database=none;");

    const fkColumn = Object.values(albumTable.columns).find(c => c.referenceTable === labelTable)!;
    const uniqueIx = labelTable.indexes.find(ix => ix.unique)!;
    return {
        connector,
        albumTable,
        labelTable,
        fkColumn: fkColumn.name,
        fkName: connector.sqlBuilder.foreignKeyName(albumTable.name.name, fkColumn.name),
        uniqueName: connector.sqlBuilder.indexName(uniqueIx),
    };
}

// The two shapes node-postgres hands up: a `DatabaseError` carrying SQLSTATE plus the structured
// schema / table / constraint / detail fields the server sent.
function pgError(message: string, fields: Record<string, string>): Error {
    return Object.assign(new Error(message), fields);
}

// The one shape mssql hands up: a `RequestError` whose only structured field is the SQL Server error
// number — everything else has to come out of the (localized) message.
function ssError(message: string, number: number): Error {
    return Object.assign(new Error(message), { number });
}

describe("ForeignKeyExceptionTest", () => {

    // A DELETE blocked because rows still point at the row being removed. PostgreSQL reports the
    // constraint's OWN table (the referencing one) and says in `detail` which table still refers.
    test("postgres blocked delete names the referring type and property", () => {
        const f = build(true);
        const ex = f.connector.translate(pgError(
            `update or delete on table "${f.labelTable.name.name}" violates foreign key constraint "${f.fkName}" on table "${f.albumTable.name.name}"`,
            {
                code: "23503",
                detail: `Key (id)=(1) is still referenced from table "${f.albumTable.name.name}".`,
                schema: f.albumTable.name.schema.name,
                table: f.albumTable.name.name,
                constraint: f.fkName,
            }),
            `DELETE FROM ${f.labelTable.name.name} WHERE id = 1`);

        assert.ok(ex instanceof ForeignKeyException, "23503 becomes a ForeignKeyException");
        assert.equal(ex.isInsert, false);
        assert.equal(ex.table, f.albumTable);
        assert.equal(ex.message, "There are 'Cx Albums' that refer to this entity by property 'Label'");
    });

    // An INSERT that wrote a reference to a row that does not exist. Signum leaves this sentence an
    // English literal (it has no EngineMessage member in any Signum translation file), and so does altea.
    test("postgres dangling write names both types", () => {
        const f = build(true);
        const ex = f.connector.translate(pgError(
            `insert or update on table "${f.albumTable.name.name}" violates foreign key constraint "${f.fkName}"`,
            {
                code: "23503",
                detail: `Key (${f.fkColumn})=(999) is not present in table "${f.labelTable.name.name}".`,
                schema: f.albumTable.name.schema.name,
                table: f.albumTable.name.name,
                constraint: f.fkName,
            }),
            `INSERT INTO ${f.albumTable.name.name} (${f.fkColumn}) VALUES ($1)`);

        assert.ok(ex instanceof ForeignKeyException);
        assert.equal(ex.isInsert, true);
        assert.equal(ex.referedTable, f.labelTable);
        assert.equal(ex.message, `The column ${f.fkColumn} of the Cx Album does not refer to a valid Cx Label`);
    });

    // SQL Server names nothing structurally: the constraint has to come out of the message, and the
    // conflicting table it reports is the REFERENCING one here (`REFERENCE constraint`).
    test("sqlServer blocked delete names the referring type and property", () => {
        const f = build(false);
        const ex = f.connector.translate(ssError(
            `The DELETE statement conflicted with the REFERENCE constraint "${f.fkName}". ` +
            `The conflict occurred in database "Music", table "dbo.${f.albumTable.name.name}", column '${f.fkColumn}'.`,
            547),
            `DELETE FROM ${f.labelTable.name.name} WHERE Id = 1`);

        assert.ok(ex instanceof ForeignKeyException);
        assert.equal(ex.isInsert, false);
        assert.equal(ex.table, f.albumTable);
        assert.equal(ex.message, "There are 'Cx Albums' that refer to this entity by property 'Label'");
    });

    // `FOREIGN KEY constraint` (not `REFERENCE`), and now the conflicting table is the REFERENCED one.
    test("sqlServer dangling write names both types", () => {
        const f = build(false);
        const ex = f.connector.translate(ssError(
            `The INSERT statement conflicted with the FOREIGN KEY constraint "${f.fkName}". ` +
            `The conflict occurred in database "Music", table "dbo.${f.labelTable.name.name}", column 'Id'.`,
            547),
            `INSERT INTO ${f.albumTable.name.name} (${f.fkColumn}) VALUES (@p0)`);

        assert.ok(ex instanceof ForeignKeyException);
        assert.equal(ex.isInsert, true);
        assert.equal(ex.referedTable, f.labelTable);
        assert.equal(ex.message, `The column ${f.fkColumn} of the Cx Album does not refer to a valid Cx Label`);
    });

    // A table the schema knows nothing about still has names to print, so it degrades to the
    // TABLE/COLUMN wording rather than to the driver's text — this is the caller
    // `EngineMessage.ThereAreRecordsIn0PointingToThisTableByColumn1` never had.
    test("an unknown table degrades to the table/column wording", () => {
        const f = build(true);
        const ex = f.connector.translate(pgError(
            'violates foreign key constraint "fk_nothing_here"',
            { code: "23503", table: "nothing", schema: "public", constraint: "fk_nothing_here" }),
            "DELETE FROM nothing WHERE id = 1") as Error;

        assert.ok(ex instanceof ForeignKeyException);
        assert.equal(ex.table, undefined);
        assert.equal(ex.message, "There are records in 'nothing' referring to this table by column 'here'");
    });

    // With nothing at all to name — no constraint, no table — it must keep the driver's own text, never
    // a half-filled sentence (Signum's `if (TableName == null) return InnerException.Message`).
    test("a nameless violation keeps the driver message", () => {
        const f = build(true);
        const driver = pgError("insert or update violates foreign key constraint", { code: "23503" });
        const ex = f.connector.translate(driver, "INSERT INTO whatever VALUES ($1)") as Error;
        assert.ok(ex instanceof ForeignKeyException);
        assert.equal(ex.message, driver.message);
    });

    // Anything that is not one of the two constraint codes comes back untouched, by identity, so an
    // untranslated error keeps its original stack (Signum's `if (nex == ex) throw;`).
    test("an unrelated error is returned unchanged", () => {
        const f = build(true);
        const driver = pgError("syntax error at or near \"SELCT\"", { code: "42601" });
        assert.equal(f.connector.translate(driver, "SELCT 1"), driver);
    });
});

describe("UniqueKeyExceptionTest", () => {

    // PostgreSQL reports the duplicate values in `detail`; Signum ignores them on this provider and
    // always falls back to the "…with the same…" wording, so altea's message is the richer of the two.
    test("postgres duplicate names the type, the property and the value", () => {
        const f = build(true);
        const ex = f.connector.translate(pgError(
            `duplicate key value violates unique constraint "${f.uniqueName}"`,
            {
                code: "23505",
                detail: "Key (name)=(Sony) already exists.",
                schema: f.labelTable.name.schema.name,
                table: f.labelTable.name.name,
                constraint: f.uniqueName,
            }),
            `INSERT INTO ${f.labelTable.name.name} (name) VALUES ($1)`);

        assert.ok(ex instanceof UniqueKeyException, "23505 becomes a UniqueKeyException");
        assert.equal(ex.table, f.labelTable);
        assert.deepEqual(ex.properties, ["Name"]);
        assert.equal(ex.message, "There is already a Cx Label with [Name] equals to Sony");
    });

    test("sqlServer duplicate names the type, the property and the value", () => {
        const f = build(false);
        const ex = f.connector.translate(ssError(
            `Cannot insert duplicate key row in object 'dbo.${f.labelTable.name.name}' with unique index '${f.uniqueName}'. ` +
            `The duplicate key value is (Sony).`,
            2601),
            `INSERT INTO ${f.labelTable.name.name} (Name) VALUES (@p0)`);

        assert.ok(ex instanceof UniqueKeyException);
        assert.equal(ex.table, f.labelTable);
        assert.deepEqual(ex.properties, ["Name"]);
        assert.equal(ex.message, "There is already a Cx Label with [Name] equals to Sony");
    });

    // The German wording of error 2601 — the second of Signum's two regexes, kept because a localized
    // SQL Server really does print this and the message is the only thing the driver gives us.
    test("sqlServer duplicate is recognised in the German wording too", () => {
        const f = build(false);
        const ex = f.connector.translate(ssError(
            `Eine Zeile mit doppeltem Schlüssel kann in das Objekt "dbo.${f.labelTable.name.name}" ` +
            `mit dem eindeutigen Index "${f.uniqueName}" nicht eingefügt werden. Der doppelte Schlüsselwert ist (Sony).`,
            2601),
            `INSERT INTO ${f.labelTable.name.name} (Name) VALUES (@p0)`);

        assert.ok(ex instanceof UniqueKeyException);
        assert.deepEqual(ex.properties, ["Name"]);
    });

    // A PRIMARY KEY collision shares SQLSTATE 23505 on Postgres but is not a registered TableIndex, so
    // the sentence falls back to the raw constraint name rather than inventing a property. Signum does
    // the same (its `Index == null` branch).
    test("postgres primary-key collision falls back to the constraint name", () => {
        const f = build(true);
        const pk = f.connector.sqlBuilder.primaryKeyName(f.labelTable.name.name);
        const ex = f.connector.translate(pgError(
            `duplicate key value violates unique constraint "${pk}"`,
            { code: "23505", detail: "Key (id)=(1) already exists.", schema: f.labelTable.name.schema.name, table: f.labelTable.name.name, constraint: pk }),
            `INSERT INTO ${f.labelTable.name.name} (id) VALUES ($1)`);

        assert.ok(ex instanceof UniqueKeyException);
        assert.equal(ex.index, undefined);
        assert.equal(ex.message, `There is already a Cx Label with ${pk} equals to 1`);
    });
});
