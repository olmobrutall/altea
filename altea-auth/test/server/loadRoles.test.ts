import { describe, test, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import { AuthImportExport } from "@altea/altea-auth/server/AuthImportExport";
import { start, hasDb } from "./setup";

// Signum's AuthLogic.LoadRoles — the one-shot creation of a new database's `<Roles>` section. The point
// of the suite is the SAVE, not the parse: every role is built in memory with fat lites at the roles it
// contains and the whole set goes down as ONE graph (`saveList`), so the Saver's dependency ordering is
// what has to hold. Both tests MUTATE inside Transaction.noCommit, so the shared fixture is untouched.

describe.skipIf(hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable")("LoadRoles", () => {

    beforeAll(async () => { await start(); });

    // Deliberately adverse: every role is listed BEFORE the roles it contains, the chain is three deep and
    // ZZ_Mid is reached two ways. Nothing in the file says what order to write in — that is the Saver's job.
    const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Auth>
  <Roles>
    <Role Name="ZZ_Top" Contains="ZZ_Left,ZZ_Right" />
    <Role Name="ZZ_Left" Contains="ZZ_Mid" />
    <Role Name="ZZ_Right" Contains="ZZ_Mid" />
    <Role Name="ZZ_Mid" Contains="ZZ_Leaf" />
    <Role Name="ZZ_Leaf" Contains="" MergeStrategy="Intersection" />
  </Roles>
</Auth>`;

    test("an out-of-order hierarchy saves, and inheritsFrom points where the file said", async () => {
        await Transaction.noCommit(async () => {
            await AuthImportExport.loadRoles(xml);

            const saved = (await table(RoleEntity).toArray() as RoleEntity[]).filter(r => r.name.startsWith("ZZ_"));
            assert.equal(saved.length, 5, "all five roles saved");
            assert.ok(saved.every(r => r.id != null), "every role got an id");

            const byName = new Map(saved.map(r => [r.name, r]));
            const contains = (name: string): string[] =>
                byName.get(name)!.inheritsFrom
                    .map(row => saved.find(r => String(r.id) === String(row.inheritsFrom.id))!.name)
                    .sort();

            // Two lites at DIFFERENT unsaved roles must not read as a repeat to @noRepeatValidator —
            // they have no id to tell them apart, only their referenced entity (see data/validators
            // comparisonKey, which follows Lite.is).
            assert.deepEqual(contains("ZZ_Top"), ["ZZ_Left", "ZZ_Right"]);
            assert.deepEqual(contains("ZZ_Left"), ["ZZ_Mid"]);
            assert.deepEqual(contains("ZZ_Right"), ["ZZ_Mid"]);
            assert.deepEqual(contains("ZZ_Mid"), ["ZZ_Leaf"]);
            assert.deepEqual(contains("ZZ_Leaf"), []);
        });
    });

    test("a repeated Name is refused rather than silently last-one-wins", async () => {
        const duplicated = xml.replace('<Role Name="ZZ_Leaf" Contains="" MergeStrategy="Intersection" />',
            '<Role Name="ZZ_Leaf" Contains="" /><Role Name="ZZ_Leaf" Contains="" />');
        await Transaction.noCommit(async () => {
            await assert.rejects(() => AuthImportExport.loadRoles(duplicated), /Repeated key ZZ_Leaf/);
        });
    });
});
