import { describe, test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { Replacements } from "@altea/altea/server/sync/synchronizer";
import type { PrimaryKey } from "@altea/altea/data/entity";
import type { RoleEntity } from "@altea/altea-auth/data/Role";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import { AuthImportExport } from "@altea/altea-auth/server/AuthImportExport";
import { RuleTypeEntity, TypeAllowedBasic } from "@altea/altea-auth/data/Rules";
import { SampleEntity } from "../data/sample";
import { start, hasDb, asRole, role, Roles, resetAuthCaches } from "./setup";

// Import / Export of AuthRules (Signum's AuthLogic.ExportRules / ImportRulesScript), against the seeded
// fixture. Export is a pure read; the import tests MUTATE inside Transaction.noCommit (rolled back) and
// reset the auth caches in afterEach so the shared fixture is untouched for other suites.

describe("AuthImportExport", { skip: hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable" }, () => {

    let sales: RoleEntity, restricted: RoleEntity;
    let typeId: PrimaryKey;
    let xml: string;

    before(async () => {
        await start();
        [sales, restricted] = await Promise.all([role(Roles.Sales), role(Roles.Restricted)]);
        typeId = TypeLogic.typeToId(SampleEntity);
        xml = await AuthImportExport.exportAuthRules();
    });
    afterEach(() => resetAuthCaches());

    const salesCanRead = (): Promise<boolean> =>
        asRole(sales, () => TypeAuthLogic.isAllowedForType(typeId, TypeAllowedBasic.Read, true));

    async function deleteSalesSampleTypeRule(): Promise<void> {
        const key = sales.toLite().key();
        for (const rt of await table(RuleTypeEntity).toArray() as RuleTypeEntity[])
            if (rt.role.key() === key && String(rt.resource.id) === String(typeId))
                await rt.delete();
        resetAuthCaches();
    }

    test("export produces the expected AuthRules XML shape", () => {
        assert.match(xml, /<Auth>/);
        assert.match(xml, /<Role Name="AuthTest_Sales" Contains="AuthTest_Base"/);
        // Sales single-dimension overrides.
        assert.match(xml, /<Type Resource="Sample" Allowed="Read"/);
        assert.match(xml, /<Property OnType="Sample" Resource="secret" Allowed="None"/);
        assert.match(xml, /<Operation OnType="Sample" Resource="SampleOperation\.Save" Allowed="Allow"/);
        // Restricted's row-level condition round-trips as a nested <Condition>.
        assert.match(xml, /<Condition Name="[^"]*SampleTypeCondition\.Public[^"]*" Allowed="Read"/);
        void restricted;
    });

    test("import restores a rule deleted from the DB (round-trip)", async () => {
        await Transaction.noCommit(async () => {
            await deleteSalesSampleTypeRule();
            assert.equal(await salesCanRead(), false, "precondition: Sales lost Read after the rule was deleted");

            const repl = new Replacements();
            repl.interactive = false;
            await AuthImportExport.importAuthRules(xml, repl);
            resetAuthCaches();

            assert.equal(await salesCanRead(), true, "import restored Sales' Sample=Read rule");
        });
    });

    test("import applies a TYPE rename (Sample renamed in the file → mapped back)", async () => {
        // The file calls the type "OldSample"; a Replacement maps it to the current "Sample".
        const renamedXml = xml.replace(/Resource="Sample"/g, 'Resource="OldSample"').replace(/OnType="Sample"/g, 'OnType="OldSample"');

        await Transaction.noCommit(async () => {
            await deleteSalesSampleTypeRule();
            assert.equal(await salesCanRead(), false, "precondition: rule deleted");

            const repl = new Replacements();
            repl.interactive = false;
            repl.autoReplacement = ({ oldValue, newValues }) =>
                oldValue === "OldSample" && (newValues?.includes("Sample") ?? false)
                    ? { oldValue: "OldSample", newValue: "Sample" }
                    : { oldValue, newValue: null }; // no-rename for anything else

            const result = await AuthImportExport.importAuthRules(renamedXml, repl);
            resetAuthCaches();

            assert.ok(result.renames.some(r => r.from === "OldSample" && r.to === "Sample"), "the rename was recorded");
            assert.equal(await salesCanRead(), true, "the renamed type resolved back to Sample and the rule was applied");
        });
    });
});
