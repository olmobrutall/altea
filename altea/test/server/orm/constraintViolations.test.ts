import { beforeAll, describe } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { Schema } from "@altea/altea/server/schema/schema";
import { ForeignKeyException, UniqueKeyException } from "@altea/altea/server/connection/databaseExceptions";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { hasDb, start, txTest } from "../setup";
import { AlbumEntity, LabelEntity } from "../../data/music";

// The live half of the ForeignKeyException / UniqueKeyException port (Signum/Engine/Exceptions.cs):
// provoke each violation against a real database and check that what comes back out of the Connector
// seam is the localized sentence, not the driver's text. The message WORDING is asserted exhaustively
// in test/server/connection/constraintExceptions.test.ts, which needs no database; what this file adds
// is the part no offline test can claim — that the driver really raises these codes, with these fields,
// for these statements.
//
// Every case runs inside txTest (Transaction.noCommit), so the writes are rolled back. Note that a
// failed statement leaves a PostgreSQL transaction ABORTED, so nothing may query after the assertion.

/** Run `fn` and return the error it threw (failing the test if it did not throw). */
async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
    try {
        await fn();
    } catch (e) {
        return e;
    }
    assert.fail("expected the statement to violate a constraint");
}

describe.skipIf(!hasDb)("ConstraintViolationTest", () => {
    beforeAll(async () => { await start(); });

    // Deleting every label is blocked by the albums that still point at one. This is the case
    // `EngineMessage.ThereAre0ThatReferThisEntityByProperty1` exists for, and the one the raw driver
    // error ("Key (id)=(1) is still referenced from table \"album\"") says nothing useful about.
    txTest("DeleteBlockedByForeignKey", async () => {
        const e = await thrown(() => table(LabelEntity).executeDelete());

        assert.ok(e instanceof ForeignKeyException, `expected a ForeignKeyException, got ${e}`);
        assert.equal(e.isInsert, false);
        assert.equal(e.table, Schema.current.table(AlbumEntity));
        assert.equal(e.message,
            `There are '${AlbumEntity.nicePluralName()}' that refer to this entity by property 'Label'`);
    });

    // The other side of the same error code: a statement that WRITES a reference to a row that is not
    // there. Issued as raw SQL built from the schema, because the object model cannot express a
    // dangling reference — which is the point.
    txTest("WriteDanglingForeignKey", async () => {
        const connector = Connector.current();
        const albumTable = Schema.current.table(AlbumEntity);
        const labelTable = Schema.current.table(LabelEntity);
        const fk = Object.values(albumTable.columns).find(c => c.referenceTable === labelTable)!;
        const sql = `UPDATE ${connector.sqlBuilder.objectName(albumTable.name)} `
            + `SET ${connector.sqlBuilder.sqlEscape(fk.name)} = -1`;

        const e = await thrown(() => connector.executeNonQuery(sql));

        assert.ok(e instanceof ForeignKeyException, `expected a ForeignKeyException, got ${e}`);
        assert.equal(e.isInsert, true);
        assert.equal(e.table, albumTable);
        assert.equal(e.referedTable, labelTable);
        assert.equal(e.message,
            `The column ${fk.name} of the ${AlbumEntity.niceName()} does not refer to a valid ${LabelEntity.niceName()}`);
    });

    // A unique index rejecting a duplicate. TypeEntity is the fixture because it is the one table in the
    // music environment that carries a `@uniqueIndex` (on `cleanName`), and the row it collides with is
    // one the environment generated — so the case needs no schema change and no regeneration.
    txTest("DuplicateUniqueIndex", async () => {
        const existing = await table(TypeEntity).first();
        const duplicate = TypeEntity.create({
            tableName: "constraint_violation_probe",
            cleanName: existing.cleanName,   // the collision
            package: existing.package,
            className: existing.className,
            namespace: null,
            isPart: false,
        });

        const e = await thrown(() => duplicate.save());

        assert.ok(e instanceof UniqueKeyException, `expected a UniqueKeyException, got ${e}`);
        assert.equal(e.table, Schema.current.table(TypeEntity));
        assert.deepEqual(e.properties, [TypeEntity.nicePropertyName(t => t.cleanName)]);
        assert.equal(e.message,
            `There is already a ${TypeEntity.niceName()} with [${TypeEntity.nicePropertyName(t => t.cleanName)}] `
            + `equals to ${existing.cleanName}`);
    });
});
