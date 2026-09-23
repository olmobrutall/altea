import { describe, test, beforeAll, afterEach } from "vitest";
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

// Import / Export of AuthRules, against the seeded
// fixture. Export is a pure read; the import tests MUTATE inside Transaction.noCommit (rolled back) and
// reset the auth caches in afterEach so the shared fixture is untouched for other suites.

describe.skipIf(hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable")("AuthImportExport", () => {

    let sales: RoleEntity, restricted: RoleEntity;
    let typeId: PrimaryKey;
    let xml: string;

    beforeAll(async () => {
        await start();
        [sales, restricted] = await Promise.all([role(Roles.Sales), role(Roles.Restricted)]);
        typeId = (await TypeLogic.caches()).typeToId(SampleEntity);
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
        // Manager's secret=Read differs from what it inherits (Sales' None), so it is exported.
        assert.match(xml, /<Property OnType="Sample" Resource="secret" Allowed="Read"/);
        assert.match(xml, /<Operation OnType="Sample" Resource="SampleOperation\.Save" Allowed="Allow"/);
        // Restricted's row-level condition round-trips as a nested <Condition>.
        assert.match(xml, /<Condition Name="[^"]*SampleTypeCondition\.Public[^"]*" Allowed="Read"/);
        void restricted;
    });

    // One role's block inside one section of the export.
    const roleBlock = (doc: string, sectionName: string, roleName: string): string | undefined =>
        doc.match(new RegExp(`<${sectionName}>[\\s\\S]*?</${sectionName}>`))?.[0]
            .match(new RegExp(`<Role Name="${roleName}"[^>]*>[\\s\\S]*?</Role>`))?.[0];

    // Signum's export filter: a stored rule equal to what the role inherits is left out. Sales' secret=None is
    // exactly its no-rule default (no AutomaticUpgradeOfProperties), so it is such a rule.
    test("export leaves out a stored rule equal to what the role inherits", () => {
        assert.doesNotMatch(roleBlock(xml, "Properties", "AuthTest_Sales") ?? "", /Resource="secret"/);
    });

    // Signum's import is a full sync: a role missing from a section loses its rules there.
    test("import removes the rules of a role the file does not list", async () => {
        const salesTypes = roleBlock(xml, "Types", "AuthTest_Sales");
        assert.ok(salesTypes, "precondition: Sales has a Types block");
        await Transaction.noCommit(async () => {
            assert.equal(await salesCanRead(), true, "precondition: Sales reads Sample");

            const repl = new Replacements();
            repl.interactive = false;
            await AuthImportExport.importAuthRules(xml.replace(salesTypes!, ""), repl);
            resetAuthCaches();

            assert.equal(await salesCanRead(), false, "Sales' Sample=Read rule was removed with its block");
        });
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
