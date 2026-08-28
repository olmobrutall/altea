import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { table } from "@altea/altea/server/table";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import type { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import type { RoleEntity } from "@altea/altea-auth/data/Role";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import { ConditionRuleModel, TypeAllowed, TypeConditionSymbol } from "@altea/altea-auth/data/Rules";
import { SampleEntity, SampleTypeCondition } from "../data/sample";
import { start, hasDb, role, Roles, asRole, resetAuthCaches } from "./setup";

// `OperationLogic.anyReadonly` — the seam @altea/altea-auth fills for Signum's `OperationController
// .AnyReadonly`: "is any of the SELECTED rows read-only for this role?", which the SearchControl's
// contextual menu uses to hide the operations that would fail anyway.
//
// The interesting case is the third one: a role whose allowance STRADDLES Read/Write through a type
// condition, where neither Min nor Max short-circuits and the conditions have to decide row by row. That
// answer is a single `SELECT COUNT(*) … WHERE id IN (…) AND NOT(<condition algebra>)` (Signum's
// `CountReadonly`), so this suite is what pins that the predicate really lowers to SQL — it is built at
// EXPRESSION level, since the algebra only exists at runtime and `Query.count` takes a build-time `Quoted`.
describe("Contextual read-only (OperationLogic.anyReadonly)", { skip: hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable" }, () => {

    let sales: RoleEntity;
    let manager: RoleEntity;
    let pub: Lite<Entity>;
    let conf: Lite<Entity>;

    before(async () => {
        await start();
        sales = await role(Roles.Sales);
        manager = await role(Roles.Manager);

        const rows = await table(SampleEntity)
            .filter(s => s.name == "PublicSample" || s.name == "ConfidentialSample")
            .toArray() as SampleEntity[];
        pub = rows.find(r => r.name === "PublicSample")!.toLite();
        conf = rows.find(r => r.name === "ConfidentialSample")!.toLite();
    });

    test("a flat Write allowance is answered by the Min bound — nothing is read-only", async () => {
        // Manager: Sample fallback Write, no condition rules ⇒ min(UI) == Write.
        assert.equal(await asRole(manager, () => OperationLogic.anyReadonly([pub, conf])), false);
    });

    test("an allowance that never reaches Write is answered by the Max bound — everything is read-only", async () => {
        // Sales: Sample fallback Read, no condition rules ⇒ max(UI) == Read.
        assert.equal(await asRole(sales, () => OperationLogic.anyReadonly([pub, conf])), true);
    });

    test("conditions straddling Read/Write are counted in SQL, per row", async () => {
        await Transaction.noCommit(async () => {
            // Give Sales `fallback Read + [Public] → Write`, so neither bound decides: the PublicSample row
            // (confidential = false ⇒ the Public condition holds) is writable, the ConfidentialSample one is not.
            const pack = await TypeAuthLogic.getTypeRulePack(sales.id);
            const sampleTypeId = TypeLogic.typeToId(SampleEntity);
            const rule = pack.rules.find(r => String(r.resource.id) === String(sampleTypeId))!;
            rule.allowed.conditionRules.push(ConditionRuleModel.create({
                typeConditions: [TypeConditionSymbol.newLite(SampleTypeCondition.Public.id, SampleTypeCondition.Public.key)],
                allowed: TypeAllowed.Write,
            }));
            await TypeAuthLogic.setTypeRulePack(pack);
            resetAuthCaches();

            await asRole(sales, async () => {
                assert.equal(await OperationLogic.anyReadonly([pub]), false, "the Public row IS writable");
                assert.equal(await OperationLogic.anyReadonly([conf]), true, "the Confidential row is not");
                assert.equal(await OperationLogic.anyReadonly([pub, conf]), true, "ANY read-only row makes the selection read-only");
            });
        });

        // The transaction rolled the rule back; the caches still hold it.
        resetAuthCaches();
    });
});
