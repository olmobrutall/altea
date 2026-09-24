import { describe, test, beforeAll, afterEach } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { Replacements } from "@altea/altea/server/sync/synchronizer";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import { AuthImportExport, InvalidRoleGraphException } from "@altea/altea-auth/server/AuthImportExport";
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

    // A rename is answered no-rename unless the test says otherwise.
    const noRename: Replacements["autoReplacement"] = ({ oldValue }) => ({ oldValue, newValue: null });

    test("export produces Signum's AuthRules XML shape", () => {
        assert.match(xml, /<Auth>/);
        assert.match(xml, /<Role Name="AuthTest_Sales" Contains="AuthTest_Base"/);
        // Sales single-dimension overrides.
        assert.match(xml, /<Type Resource="Sample" Allowed="Read"/);
        // Manager's secret=Read differs from what it inherits (Sales' None), so it is exported.
        assert.match(xml, /<Property Resource="Sample\|secret" Allowed="Read"/);
        assert.match(xml, /<Operation Resource="SampleOperation\.Save\/Sample" Allowed="Allow"/);
        assert.doesNotMatch(xml, /OnType=/);
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
        assert.doesNotMatch(roleBlock(xml, "Properties", "AuthTest_Sales") ?? "", /Resource="Sample\|secret"/);
    });

    // Signum's import is a full sync: a role missing from a section loses its rules there.
    test("import removes the rules of a role the file does not list", async () => {
        const salesTypes = roleBlock(xml, "Types", "AuthTest_Sales");
        assert.ok(salesTypes, "precondition: Sales has a Types block");
        await Transaction.noCommit(async () => {
            assert.equal(await salesCanRead(), true, "precondition: Sales reads Sample");

            await AuthImportExport.automaticImportAuthRules(xml.replace(salesTypes!, ""), noRename);
            resetAuthCaches();

            assert.equal(await salesCanRead(), false, "Sales' Sample=Read rule was removed with its block");
        });
    });

    test("import restores a rule deleted from the DB (round-trip)", async () => {
        await Transaction.noCommit(async () => {
            await deleteSalesSampleTypeRule();
            assert.equal(await salesCanRead(), false, "precondition: Sales lost Read after the rule was deleted");

            await AuthImportExport.automaticImportAuthRules(xml, noRename);
            resetAuthCaches();

            assert.equal(await salesCanRead(), true, "import restored Sales' Sample=Read rule");
        });
    });

    test("import applies a TYPE rename (Sample renamed in the file → mapped back)", async () => {
        // The file calls the type "OldSample"; a Replacement maps it to the current "Sample".
        const renamedXml = xml.replace(/Resource="Sample"/g, 'Resource="OldSample"');

        await Transaction.noCommit(async () => {
            await deleteSalesSampleTypeRule();
            assert.equal(await salesCanRead(), false, "precondition: rule deleted");

            const asked: string[] = [];
            await AuthImportExport.automaticImportAuthRules(renamedXml, ({ replacementKey, oldValue, newValues }) => {
                asked.push(replacementKey);
                return oldValue === "OldSample" && (newValues?.includes("Sample") ?? false)
                    ? { oldValue: "OldSample", newValue: "Sample" }
                    : { oldValue, newValue: null };
            });
            resetAuthCaches();

            assert.ok(asked.includes("AuthRules:TypeEntity"), "asked under Signum's key");
            assert.equal(await salesCanRead(), true, "the renamed type resolved back to Sample and the rule was applied");
        });
    });

    // Signum's ImportRulesScript: the script is only built — nothing is written until it is executed.
    test("importRulesScript writes nothing", async () => {
        await Transaction.noCommit(async () => {
            await deleteSalesSampleTypeRule();
            const script = await AuthImportExport.importRulesScript(xml, false, noRename);
            assert.ok(script, "the deleted rule makes a script");
            assert.match(script!.plainSql(), /-- Type Sample for AuthTest_Sales \(Read\)/);
            resetAuthCaches();
            assert.equal(await salesCanRead(), false, "building the script did not restore the rule");
        });
    });

    test("a second import of the same file has nothing to do", async () => {
        await Transaction.noCommit(async () => {
            await AuthImportExport.automaticImportAuthRules(xml, noRename);
            assert.equal(await AuthImportExport.importRulesScript(xml, false, noRename), undefined);
        });
    });

    // A resource the database no longer has is dropped (as in Signum), and listed in the script.
    test("a rule for an unknown type is skipped, not fatal", async () => {
        const salesTypes = roleBlock(xml, "Types", "AuthTest_Sales")!;
        const withGhost = xml.replace(salesTypes, salesTypes.replace("</Role>", "<Type Resource=\"Ghost\" Allowed=\"Read\"/></Role>"));
        await Transaction.noCommit(async () => {
            await deleteSalesSampleTypeRule();
            const script = await AuthImportExport.importRulesScript(withGhost, false, noRename);
            assert.match(script!.plainSql(), /-- Skipped Type Ghost \(not found\)/);
        });
    });

    // The role graph is not imported: a role the database lacks fails the import before any rule.
    test("a role the database lacks throws InvalidRoleGraphException", async () => {
        const withGhostRole = xml.replace("<Roles>", "<Roles><Role Name=\"AuthTest_Ghost\" Contains=\"\"/>");
        await assert.rejects(AuthImportExport.importRulesScript(withGhostRole, false, noRename), InvalidRoleGraphException);
    });

    test("a different merge strategy throws InvalidRoleGraphException", async () => {
        const changed = xml.replace(/<Role Name="AuthTest_Sales"/, "<Role Name=\"AuthTest_Sales\" MergeStrategy=\"Intersection\"");
        await assert.rejects(AuthImportExport.importRulesScript(changed, false, noRename), /Merge strategy of AuthTest_Sales is Union in the database but is Intersection in the file/);
    });

    // Signum's SynchronizeRoles, non-interactive: it saves as it goes, so the role graph matches after it.
    test("synchronizeRoles creates a role the file adds", async () => {
        const withNewRole = xml.replace("<Roles>", "<Roles><Role Name=\"AuthTest_New\" Contains=\"AuthTest_Sales\"/>");
        await Transaction.noCommit(async () => {
            await AuthImportExport.synchronizeRoles(withNewRole, false, "sync", noRename);
            const created = await table(RoleEntity).filter(r => r.name == "AuthTest_New").singleOrNull() as RoleEntity | null;
            assert.ok(created, "the role was created");
            assert.deepEqual(created!.inheritsFrom.map(i => i.inheritsFrom.toString()), ["AuthTest_Sales"]);
            AuthLogic.invalidateRoles();
            // …and the rules import no longer fails on it.
            await AuthImportExport.importRulesScript(withNewRole, false, noRename);
        });
    });
});
