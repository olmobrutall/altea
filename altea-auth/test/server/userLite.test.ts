import { describe, test, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { Serializer } from "@altea/altea/data/serializer";
import { UserEntity, UserLite, UserState } from "@altea/altea-auth/data/User";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { start, hasDb, role, Roles } from "./setup";

// A user's default lite is a UserLite (Signum's UserLiteModel): built by toLite(), projected by a query, and
// read back by the JSON codec, each with the user name and external id. The fixture has no users, so each
// test saves one inside a rolled-back transaction.

async function withUser(test: (user: UserEntity) => Promise<void>): Promise<void> {
    await Transaction.noCommit(async () => {
        const user = UserEntity.create({ userName: "userLiteTest", externalId: "oid-123", state: UserState.Active, role: (await role(Roles.Base)).toLite() });
        await user.save();
        await test(user);
    });
}

describe.skipIf(hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable")("UserLite", () => {
    beforeAll(async () => { await start(); });

    test("a query projects user lites as UserLite", () => withUser(async () => {
        const rows = await table(UserEntity).map(u => ({ lite: u.toLite(), userName: u.userName, externalId: u.externalId })).toArray();
        assert.ok(rows.length > 0);
        for (const r of rows) {
            assert.ok(r.lite instanceof UserLite);
            assert.equal(r.lite.userName, r.userName);
            assert.equal(r.lite.externalId, r.externalId);
            assert.equal(r.lite.toString(), r.userName);
        }
        assert.ok(rows.some(r => r.externalId == "oid-123"));
    }));

    test("toLite() and the JSON codec keep the UserLite", () => withUser(async user => {
        const lite = user.toLite();
        assert.ok(lite instanceof UserLite);

        const back = Serializer.parse(Serializer.stringify(lite)) as UserLite;
        assert.ok(back instanceof UserLite);
        assert.equal(back.userName, user.userName);
        assert.equal(back.externalId, user.externalId);
        assert.equal(back.photoSuffix, null);
    }));
});
