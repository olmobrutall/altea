import { describe, test, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { MergeStrategy, RoleEntity } from "@altea/altea-auth/data/Role";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { start, hasDb } from "./setup";

// A role saved inside a transaction is in the role graph once that transaction COMMITS. The graph is a
// global lazy that reloads from committed state; reset only as the write happened, a reload before the
// commit cached the graph WITHOUT the new role until the process restarted (a terminal's CreateRoles
// followed by ImportAuthRules failed with "roles … not found on the database").
//
// This one COMMITS (it is about the commit), so it deletes its role again.

describe.skipIf(hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable")("role graph invalidation", () => {

    beforeAll(async () => { await start(); });

    test("a role saved in a transaction is in the graph after the commit", async () => {
        const name = "AuthTest_Committed_" + Date.now();
        let role!: RoleEntity;
        await Transaction.create(async () => {
            role = RoleEntity.create({ name, mergeStrategy: MergeStrategy.Union, isTrivialMerge: false, description: null, inheritsFrom: [] });
            await role.save();
        });

        try {
            const graph = await AuthLogic.roleGraph();
            assert.ok([...graph.rolesByKey.values()].some(r => r.name === name), "the committed role is in the graph");
        } finally {
            await Transaction.create(async () => { await role.delete(); });
        }

        const after = await AuthLogic.roleGraph();
        assert.ok(![...after.rolesByKey.values()].some(r => r.name === name), "the deleted role left the graph");
    });
});
