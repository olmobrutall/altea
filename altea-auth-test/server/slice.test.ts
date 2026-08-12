import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { Transaction } from "@altea/altea/server/connection/transaction";
import type { Lite } from "@altea/altea/data/lite";
import type { RoleEntity } from "@altea/altea-auth/data/Role";
import { PropertyAuthLogic } from "@altea/altea-auth/server/PropertyAuthLogic";
import { PropertyConditionRuleModel, PropertyAllowed } from "@altea/altea-auth/data/Rules";
import type { PropertyWithConditionsModel, TypeConditionSymbol } from "@altea/altea-auth/data/Rules";
import { start, hasDb, role, Roles, resetAuthCaches } from "./setup";

// Phase 4 — the property/operation rule editor's type-condition SLICE model. The pack now carries
// `availableTypeConditions` (the type's configured condition sets for the role), and each property row is
// edited one slice at a time. The Restricted fixture role has SampleEntity fallback None + [Public]→Read,
// so its only condition set is [Public]. (Property WithConditions come pre-padded with the type's sets via
// the property engine's typeDefaultWC, so the slice binding reads real values without synthesising.)

const setKey = (tcs: readonly Lite<TypeConditionSymbol>[]): string => tcs.map(l => String(l.id)).sort().join("&");
// The value a WithConditionsModel shows for a slice — the matching condition rule, else the fallback.
const sliceValue = (wc: PropertyWithConditionsModel, set: Lite<TypeConditionSymbol>[]): PropertyAllowed =>
    wc.conditionRules.find(c => setKey(c.typeConditions) === setKey(set))?.allowed ?? wc.fallback;
// Mimic the client slice binding's write: update the matching condition rule, else create it.
const setSlice = (wc: PropertyWithConditionsModel, set: Lite<TypeConditionSymbol>[], v: PropertyAllowed): void => {
    const cr = wc.conditionRules.find(c => setKey(c.typeConditions) === setKey(set));
    if (cr) cr.allowed = v;
    else wc.conditionRules.push(PropertyConditionRuleModel.create({ typeConditions: [...set], allowed: v }));
};

describe("Property rule slices (type conditions)", { skip: hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable" }, () => {
    let restricted: RoleEntity;

    before(async () => {
        await start();
        restricted = await role(Roles.Restricted);
    });

    test("availableTypeConditions = the type's condition sets for the role", async () => {
        const pack = await PropertyAuthLogic.getPropertyRulePack("Sample", restricted.id);
        assert.equal(pack.availableTypeConditions.length, 1, "Restricted has one Sample condition set");
        const set = pack.availableTypeConditions[0].typeConditions;
        assert.equal(set.length, 1);
        assert.ok(set[0].toString().endsWith(".Public"), `expected [Public], got ${set[0].toString()}`);
    });

    test("coerced is per-slice: [Public]→Read (type Read) but Fallback→None (type None)", async () => {
        // Restricted's SampleEntity type rule is fallback None + [Public]→Read, so a property can be at most
        // None on the Fallback slice and at most Read on the [Public] slice.
        const pack = await PropertyAuthLogic.getPropertyRulePack("Sample", restricted.id);
        const publicSet = pack.availableTypeConditions[0].typeConditions;
        const secret = pack.rules.find(r => r.path === "secret")!;
        assert.equal(secret.coerced.fallback, PropertyAllowed.None, "Fallback ceiling is None (type None)");
        assert.equal(sliceValue(secret.coerced, publicSet), PropertyAllowed.Read, "[Public] ceiling is Read (type Read)");
    });

    test("editing a property's [Public] slice round-trips; setting it back to base clears the override", async () => {
        await Transaction.noCommit(async () => {
            const pack = await PropertyAuthLogic.getPropertyRulePack("Sample", restricted.id);
            const publicSet = pack.availableTypeConditions[0].typeConditions;
            const secret = pack.rules.find(r => r.path === "secret")!;

            // Pick a target that differs from the current base value for the [Public] slice, within coerce.
            const base = sliceValue(secret.allowedBase, publicSet);
            const target = base === PropertyAllowed.None ? PropertyAllowed.Read : PropertyAllowed.None;
            setSlice(secret.allowed, publicSet, target);

            await PropertyAuthLogic.setPropertyRulePack(pack);
            resetAuthCaches();

            const p2 = await PropertyAuthLogic.getPropertyRulePack("Sample", restricted.id);
            const secret2 = p2.rules.find(r => r.path === "secret")!;
            assert.equal(sliceValue(secret2.allowed, publicSet), target, "the [Public] slice override persisted");

            // Now set it back to the base value → the explicit override should disappear on save.
            setSlice(secret2.allowed, publicSet, sliceValue(secret2.allowedBase, publicSet));
            await PropertyAuthLogic.setPropertyRulePack(p2);
            resetAuthCaches();

            const p3 = await PropertyAuthLogic.getPropertyRulePack("Sample", restricted.id);
            const secret3 = p3.rules.find(r => r.path === "secret")!;
            assert.equal(sliceValue(secret3.allowed, publicSet), sliceValue(secret3.allowedBase, publicSet),
                "the [Public] slice is back to the inherited value (override cleared)");
        });
    });
});
