import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { Entity, EmbeddedEntity, MixinEntity } from "@altea/altea/data/entity";
import { reflect, resolveField, getTypeInfo } from "@altea/altea/data/reflection";
import type { FieldInfo } from "@altea/altea/data/reflection";
import { entity, part, mixin, column, bindParent, isReadOnly } from "@altea/altea/data/decorators";
import { validate } from "@altea/altea/data/validators";
import { bindParents, tryGetParentEntity, tryGetOwnerEntity, setParentEntity } from "@altea/altea/data/parentEntity";
import { Binding } from "@altea/altea/client/binding";

// The three model RULES that resolve against an instance, and the two-level field lookup all of them go
// through. DB-free by construction: everything here is reflection plus a WeakMap.
//
// Local fixture classes rather than the shared music model, so a rule declared for a test can never widen
// the schema the DB-backed suites generate.

@reflect
class NoteMixin extends MixinEntity {
    // A mixin's field is NOT on the owner's TypeInfo — the whole reason `resolveField` exists.
    @validate<NoteMixin>(n => n.tag === "bad" ? "tag is bad" : null)
    tag: string | null = null;

    @isReadOnly<NoteMixin>(n => n.tag === "frozen")
    note: string | null = null;
}

@reflect
class LineExtraEmbedded extends EmbeddedEntity {
    comment: string | null = null;
}

@part
@mixin(() => [NoteMixin])
class RuleLineEntity extends Entity {
    @isReadOnly(true)
    stamped: string | null = null;

    // Reads its OWNER, which is what @bindParent is for (Southwind's discount rule in one line).
    @validate<RuleLineEntity>(l =>
        tryGetParentEntity(l, RuleOwnerEntity)?.strict === true && (l.amount ?? 0) < 0
            ? "amount must not be negative on a strict owner"
            : null)
    amount: number | null = null;

    // The escape hatch: `false` beats the owner's whole-entity rule.
    @isReadOnly<RuleLineEntity>(() => false)
    alwaysEditable: string | null = null;

    plain: string | null = null;

    @bindParent
    extra: LineExtraEmbedded | null = null;
}

@entity("Main", "Transactional")
// Two rules about EVERY member at once — Signum's `IsPropertyReadonly` override. The second NAMES the
// states that freeze rather than negating the initial one, which is the only phrasing safe against an
// uninitialized field (see the test).
@isReadOnly<RuleOwnerEntity>(o => o.locked ? true : undefined)
@isReadOnly<RuleOwnerEntity>(o => o.stage === "closed" ? true : undefined)
class RuleOwnerEntity extends Entity {
    @column(false)
    locked: boolean = false;

    // Deliberately NOT initialized, as altea entity fields are not.
    @column(false)
    stage: string | null;

    @column(false)
    strict: boolean = false;

    @bindParent
    lines: RuleLineEntity[] = [];

    @bindParent
    single: RuleLineEntity | null = null;

    // NOT marked, so its value gets no parent — the marker is what says "this is mine".
    unmarked: RuleLineEntity | null = null;
}

const fieldOf = (ctor: Function, member: string): FieldInfo =>
    resolveField(ctor, member) ?? assert.fail(`no FieldInfo for ${ctor.name}.${member}`);

describe("resolveField — the two-level lookup", () => {

    test("a mixin's field is absent from the owner's TypeInfo but found by resolveField", () => {
        assert.equal(getTypeInfo(RuleLineEntity)!.fields["tag"], undefined,
            "a mixin keeps its own TypeInfo — this is the lookup that used to answer undefined");
        assert.equal(resolveField(RuleLineEntity, "tag"), getTypeInfo(NoteMixin)!.fields["tag"]);
    });

    test("an own field still resolves, and an unknown member answers undefined", () => {
        assert.equal(resolveField(RuleLineEntity, "amount"), getTypeInfo(RuleLineEntity)!.fields["amount"]);
        assert.equal(resolveField(RuleLineEntity, "nope"), undefined);
    });

    test("Binding.getError reports a MIXIN field's validator (it never ran in the live pass before)", () => {
        const line = RuleLineEntity.create({});
        // a mixin's member is reached through mixin(), since it is not on the owner's TYPE either
        line.mixin(NoteMixin).tag = "bad";
        assert.equal(new Binding(line, "tag").getError(), "tag is bad");
        line.mixin(NoteMixin).tag = "fine";
        assert.equal(new Binding(line, "tag").getError(), undefined);
    });
});

describe("@bindParent", () => {

    test("bindParents stamps a collection's elements and a single reference", () => {
        const owner = RuleOwnerEntity.create({});
        const inList = RuleLineEntity.create({});
        const single = RuleLineEntity.create({});
        const loose = RuleLineEntity.create({});
        owner.lines = [inList];
        owner.single = single;
        owner.unmarked = loose;

        bindParents(owner);

        assert.equal(tryGetParentEntity(inList, RuleOwnerEntity), owner);
        assert.equal(tryGetParentEntity(single, RuleOwnerEntity), owner);
        assert.equal(tryGetParentEntity(loose, RuleOwnerEntity), undefined, "an unmarked field is not followed");
    });

    test("it RECURSES, so one call binds a whole graph", () => {
        const owner = RuleOwnerEntity.create({});
        const line = RuleLineEntity.create({});
        const extra = LineExtraEmbedded.create({});
        line.extra = extra;
        owner.lines = [line];

        bindParents(owner);

        assert.equal(tryGetParentEntity(extra, RuleLineEntity), line);
        // and the chain climbs past the embedded to the nearest ENTITY
        assert.equal(tryGetOwnerEntity(extra, RuleOwnerEntity), owner);
    });

    test("a MOVED child answers undefined rather than its old owner (the read verifies)", () => {
        const first = RuleOwnerEntity.create({});
        const line = RuleLineEntity.create({});
        first.lines = [line];
        bindParents(first);
        assert.equal(tryGetParentEntity(line, RuleOwnerEntity), first);

        first.lines = [];
        assert.equal(tryGetParentEntity(line, RuleOwnerEntity), undefined,
            "the slot records the member it was bound under, so a stale binding is detected");
    });

    test("Binding.setValue binds on the client's own write funnel", () => {
        const owner = RuleOwnerEntity.create({});
        const line = RuleLineEntity.create({});

        new Binding<RuleLineEntity | null>(owner, "single").setValue(line);
        assert.equal(tryGetParentEntity(line, RuleOwnerEntity), owner);

        // a collection write re-stamps the whole array (EntityListBase hands back the same one)
        const a = RuleLineEntity.create({}), b = RuleLineEntity.create({});
        owner.lines.push(a, b);
        new Binding<RuleLineEntity[]>(owner, "lines").setValue(owner.lines);
        assert.equal(tryGetParentEntity(a, RuleOwnerEntity), owner);
        assert.equal(tryGetParentEntity(b, RuleOwnerEntity), owner);

        // ...and an UNMARKED field's write stamps nothing
        const loose = RuleLineEntity.create({});
        new Binding<RuleLineEntity | null>(owner, "unmarked").setValue(loose);
        assert.equal(tryGetParentEntity(loose, RuleOwnerEntity), undefined);
    });

    test("a @validate on the child can read the owner", () => {
        const owner = RuleOwnerEntity.create({ strict: true });
        const line = RuleLineEntity.create({ amount: -1 });
        owner.lines = [line];

        // unbound: the rule stands down rather than refusing
        assert.equal(new Binding(line, "amount").getError(), undefined);

        bindParents(owner);
        assert.equal(new Binding(line, "amount").getError(), "amount must not be negative on a strict owner");

        owner.strict = false;
        assert.equal(new Binding(line, "amount").getError(), undefined);
    });
});

describe("@isReadOnly — the resolution order", () => {

    const readOnly = (line: RuleLineEntity, member: string): boolean =>
        fieldOf(RuleLineEntity, member).isReadOnlyFor(line);

    test("a field's static declaration wins, and an undeclared member is editable", () => {
        const line = RuleLineEntity.create({});
        assert.equal(readOnly(line, "stamped"), true);
        assert.equal(readOnly(line, "plain"), false);
    });

    test("the OWNER's class rule reaches every member — including a mixin's, which it cannot name", () => {
        const owner = RuleOwnerEntity.create({ locked: true });
        const line = RuleLineEntity.create({});
        owner.lines = [line];
        bindParents(owner);

        // the owner's rule is about ITS members, so it does not gate the line...
        assert.equal(readOnly(line, "plain"), false);
        // ...whereas on the owner itself every member is frozen, mixin fields included
        assert.equal(fieldOf(RuleOwnerEntity, "strict").isReadOnlyFor(owner), true);
    });

    test("a class rule answering undefined DEFERS (that is what replaces `super`)", () => {
        const unlocked = RuleOwnerEntity.create({ locked: false });
        assert.equal(fieldOf(RuleOwnerEntity, "strict").isReadOnlyFor(unlocked), false);
    });

    // The trap a class rule has to be written around: altea does NOT initialize a field to its type
    // default, so a fresh entity's enum / boolean is UNDEFINED, not 0 / false. A rule phrased as "anything
    // that is not the initial value freezes" therefore freezes a NEW entity — which is exactly what
    // happened to eastwind's OrderEntity until it named the three stored states instead of negating `New`.
    // Signum is only safe from it because C# initializes the field.
    test("an unset field reaches the rule as undefined, not as the type default", () => {
        const fresh = new RuleOwnerEntity();
        assert.equal(fresh.stage, undefined, "no initializer, so no default — this is the trap");

        const fi = fieldOf(RuleOwnerEntity, "strict");
        assert.equal(fi.isReadOnlyFor(fresh), false, "the stage rule names its states, so it defers");

        fresh.stage = "closed";
        assert.equal(fi.isReadOnlyFor(fresh), true);
    });

    test("a field-level `false` WINS over the class rule", () => {
        const line = RuleLineEntity.create({});
        // put the whole-entity rule on the LINE's own type for this one case
        const ti = getTypeInfo(RuleLineEntity)!;
        (ti.isReadOnly ??= []).push(() => true);
        try {
            assert.equal(readOnly(line, "plain"), true, "the pushed class rule freezes an undeclared member");
            assert.equal(readOnly(line, "alwaysEditable"), false, "@isReadOnly(false) on the field beats it");
            assert.equal(readOnly(line, "stamped"), true);
        } finally {
            ti.isReadOnly!.pop();
        }
    });

    test("a MIXIN's class rule gates the mixin's own member", () => {
        const line = RuleLineEntity.create({});
        line.mixin(NoteMixin).tag = "frozen";
        assert.equal(readOnly(line, "note"), true);
        line.mixin(NoteMixin).tag = "thawed";
        assert.equal(readOnly(line, "note"), false);
    });

    test("the rules are DATA, so they can be pushed imperatively (an app overriding a framework type)", () => {
        const line = RuleLineEntity.create({});
        const fi = fieldOf(RuleLineEntity, "plain");
        assert.equal(fi.isReadOnlyFor(line), false);
        fi.isReadOnly = true;
        try {
            assert.equal(fi.isReadOnlyFor(line), true);
        } finally {
            fi.isReadOnly = undefined;
        }
    });

    test("setParentEntity is idempotent and re-binding to a new owner wins (no throw, unlike Signum)", () => {
        const a = RuleOwnerEntity.create({}), b = RuleOwnerEntity.create({});
        const line = RuleLineEntity.create({});
        a.lines = [line];
        b.lines = [line];
        setParentEntity(line, a, "lines");
        setParentEntity(line, b, "lines");
        assert.equal(tryGetParentEntity(line, RuleOwnerEntity), b);
    });
});
