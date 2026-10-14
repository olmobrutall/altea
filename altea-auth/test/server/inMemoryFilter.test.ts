import { describe, test, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { Connector } from "@altea/altea/server/connection/connector";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { table } from "@altea/altea/server/table";
import { toInt } from "@altea/altea/data/basics";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import { SampleEntity } from "../data/sample";
import { start, hasDb, asRole, role, Roles } from "./setup";

// The IN-MEMORY half of the row-read filter (`QueryFilterHandler.inMemory`) — what a row the CACHE serves is
// filtered by, since no WHERE runs for it (Signum's FilterQueryResult.InMemoryFunction). For every fixture
// role it must keep EXACTLY the rows the SQL half keeps; `Restricted` (None + [Public] → Read) is the role
// for which the two actually have to deny something.
describe.skipIf(hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable")("in-memory row filter", () => {

    beforeAll(() => start());

    test("keeps exactly the rows the SQL filter keeps, for every role", async () => {
        await Transaction.noCommit(async () => {
            for (const [name, confidential, value] of [["imf-pub-hi", false, 5], ["imf-pub-lo", false, 0], ["imf-conf-hi", true, 5], ["imf-conf-lo", true, 0]] as const)
                await SampleEntity.create({ name, secret: "s", confidential, value: toInt(value) }).save();

            const events = Connector.current().schema.entityEvents(SampleEntity);
            const all = await ExecutionMode.global(() => table(SampleEntity).filter(s => s.name.startsWith("imf-")).toArray()) as SampleEntity[];
            assert.equal(all.length, 4);

            let denied = 0;
            for (const role of await table(RoleEntity).toArray() as RoleEntity[]) {
                await asRole(role, async () => {
                    const bySql = (await table(SampleEntity).filter(s => s.name.startsWith("imf-")).toArray() as SampleEntity[])
                        .map(s => s.name).sort();
                    const inMemory: string[] = [];
                    for (const s of all)
                        if (await events.isAllowedInMemory(SampleEntity, s))
                            inMemory.push(s.name);
                    assert.deepEqual(inMemory.sort(), bySql, `role ${role.name}`);
                    denied += all.length - inMemory.length;
                });
            }
            assert.ok(denied > 0, "some role must be denied some row, or the comparison proves nothing");
        });
    });

    test("Restricted reads only the Public rows in memory", async () => {
        await Transaction.noCommit(async () => {
            await SampleEntity.create({ name: "imf2-pub", secret: "s", confidential: false, value: toInt(1) }).save();
            await SampleEntity.create({ name: "imf2-conf", secret: "s", confidential: true, value: toInt(1) }).save();
            const all = await ExecutionMode.global(() => table(SampleEntity).filter(s => s.name.startsWith("imf2-")).toArray()) as SampleEntity[];
            const restricted = await role(Roles.Restricted);
            const events = Connector.current().schema.entityEvents(SampleEntity);

            const allowed = await asRole(restricted, async () => {
                const names: string[] = [];
                for (const s of all)
                    if (await events.isAllowedInMemory(SampleEntity, s))
                        names.push(s.name);
                return names;
            });
            assert.deepEqual(allowed, ["imf2-pub"]);
        });
    });
});
