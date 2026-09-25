import { beforeAll, describe } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { updateSqlSync, deleteSqlSync } from "@altea/altea/server/save";
import { hasDb, start, txTest } from "../setup";

// updateSqlSync / deleteSqlSync with a `where` (Signum's UpdateSqlSync(entity, where)): the row is found
// by a natural key, not by its id, so the script also runs against a database with different ids.
describe.skipIf(!hasDb)("SqlSyncWhere", () => {
    beforeAll(async () => { await start(); });

    txTest("UpdateByCleanName", async () => {
        const te = (await table(TypeEntity).toArray())[0];
        const cleanName = te.cleanName;
        te.id = -1 as never; // a script built from another database's ids still finds the row
        te.className = "Renamed";

        const cmd = updateSqlSync(Connector.current().schema.table(TypeEntity), te, t => t.cleanName == cleanName, "comment")!;
        assert.doesNotMatch(cmd.plainSql(), /= -1/);
        assert.match(cmd.plainSql(), /clean_name = /);
        await Connector.current().executeNonQuery(cmd.plainSql());

        const after = await table(TypeEntity).filter(t => t.cleanName == cleanName).single();
        assert.equal(after.className, "Renamed");
    });

    txTest("DeleteByCleanNameThrowsWhenMissing", async () => {
        const te = TypeEntity.create({ cleanName: "DoesNotExist", id: -1 as never });
        const cmd = (await deleteSqlSync(Connector.current().schema.table(TypeEntity), te, t => t.cleanName == te.cleanName))!;
        await assert.rejects(() => Connector.current().executeNonQuery(cmd.plainSql()), /not found/);
    });
});
