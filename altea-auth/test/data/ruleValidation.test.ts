import { describe, test } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import { toInt } from "@altea/altea/data/basics";
import { RoleEntity, RoleEntity_InheritsFrom, MergeStrategy } from "@altea/altea-auth/data/Role";
import {
    ConditionRuleModel, WithConditionsModel,
    RuleTypeEntity, RuleTypeConditionEntity, RuleTypeConditionEntity_Condition,
    TypeAllowed, TypeConditionSymbol,
} from "@altea/altea-auth/data/Rules";

// The two rule-shape validations Signum performs and altea had dropped. Both are pure data-layer rules,
// so this suite needs no database: the authorization admin can reach every state below by hand.
//
//  - RoleEntity.PropertyValidation's three trivial-merge branches (RoleEntity.cs);
//  - NoRepeatValidatorAttribute.ByKey over a rule's condition ROWS, declared three times in
//    RulesEntities.cs and once more in RulePackModels.cs: two rows may not name the same SET of
//    conditions, because last-match-wins makes the later one silently shadow the earlier.

function inherits(name: string): RoleEntity_InheritsFrom {
    const link = RoleEntity_InheritsFrom.create({});
    const parent = RoleEntity.create({ name });
    parent.id = toInt(name.length);
    parent.isNew = false;
    link.inheritsFrom = parent.toLite();
    return link;
}

function trivial(): RoleEntity {
    const r = RoleEntity.create({ name: "A | B" });
    r.isTrivialMerge = true;
    r.mergeStrategy = MergeStrategy.Union;
    r.inheritsFrom = [inherits("Alpha"), inherits("Beta")];
    r.description = null;
    return r;
}

function errors(e: Parameters<typeof entityIntegrityCheck>[0]): { [field: string]: string } {
    return entityIntegrityCheck(e, "Saving")?.errors ?? {};
}

describe("RoleEntity trivial merge", () => {

    test("a well-formed trivial merge passes", () => {
        assert.deepEqual(errors(trivial()), {});
    });

    test("it must merge at least two roles", () => {
        const r = trivial();
        r.inheritsFrom = [inherits("Alpha")];
        assert.ok(errors(r)["inheritsFrom"] != null, "one parent is not a merge");

        r.inheritsFrom = [];
        assert.ok(errors(r)["inheritsFrom"] != null, "no parent is not a merge either");
    });

    test("its merge strategy is pinned to Union", () => {
        const r = trivial();
        r.mergeStrategy = MergeStrategy.Intersection;
        assert.ok(errors(r)["mergeStrategy"] != null);
    });

    test("it carries no description — nobody wrote this role", () => {
        const r = trivial();
        r.description = "hand-written";
        assert.ok(errors(r)["description"] != null);
    });

    test("none of the three applies to an ORDINARY role", () => {
        const r = RoleEntity.create({ name: "Sales" });
        r.isTrivialMerge = false;
        r.mergeStrategy = MergeStrategy.Intersection;
        r.inheritsFrom = [inherits("Alpha")];
        r.description = "hand-written";
        assert.deepEqual(errors(r), {});
    });
});

describe("rule condition rows may not repeat a condition SET", () => {

    function symbol(key: string): TypeConditionSymbol {
        const s = TypeConditionSymbol.create({});
        s.key = key;
        s.id = toInt(key.length);
        s.isNew = false;
        return s;
    }

    function conditionRow(...keys: string[]): RuleTypeConditionEntity {
        const row = RuleTypeConditionEntity.create({});
        row.allowed = TypeAllowed.Read;
        row.conditions = keys.map(k => {
            const c = RuleTypeConditionEntity_Condition.create({});
            c.symbol = symbol(k).toLite();
            return c;
        });
        return row;
    }

    function rule(...rows: RuleTypeConditionEntity[]): RuleTypeEntity {
        const r = RuleTypeEntity.create({});
        r.fallback = TypeAllowed.None;
        r.conditionRules = rows;
        return r;
    }

    test("distinct condition sets are fine", () => {
        assert.equal(errors(rule(conditionRow("Sample.Own"), conditionRow("Sample.Confidential")))["conditionRules"],
            undefined);
    });

    test("the same set twice is refused", () => {
        assert.ok(errors(rule(conditionRow("Sample.Own"), conditionRow("Sample.Own")))["conditionRules"] != null);
    });

    test("the set is ORDER-INSENSITIVE — the symbols under a row are AND-ed", () => {
        const e = errors(rule(
            conditionRow("Sample.Own", "Sample.Confidential"),
            conditionRow("Sample.Confidential", "Sample.Own")));
        assert.ok(e["conditionRules"] != null, "the same two conditions, listed the other way round");
    });

    test("a strict SUBSET is not a repeat", () => {
        assert.equal(errors(rule(
            conditionRow("Sample.Own"),
            conditionRow("Sample.Own", "Sample.Confidential")))["conditionRules"], undefined);
    });

    test("the same rule holds on the rule-PACK model the admin UI edits", () => {
        function modelRow(...keys: string[]): ConditionRuleModel {
            const m = ConditionRuleModel.create({});
            m.allowed = TypeAllowed.Read;
            m.typeConditions = keys.map(k => symbol(k).toLite());
            return m;
        }
        const withConditions = WithConditionsModel.create({});
        withConditions.fallback = TypeAllowed.None;

        withConditions.conditionRules = [modelRow("Sample.Own"), modelRow("Sample.Confidential")];
        assert.equal(errors(withConditions)["conditionRules"], undefined);

        withConditions.conditionRules = [modelRow("Sample.Own"), modelRow("Sample.Own")];
        assert.ok(errors(withConditions)["conditionRules"] != null);
    });
});
