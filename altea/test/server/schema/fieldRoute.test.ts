import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { field, reflect } from "@altea/altea/data/reflection"; // anchor for the transformer's @field injection
import { Entity, EmbeddedEntity, MixinEntity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { entity, mixin } from "@altea/altea/data/decorators";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { FieldRoute } from "@altea/altea/data/fieldRoute";
import { SchemaBuilder } from "@altea/altea/server/schema";

// FieldRoute: a field of ONE table's row — own or mixin field, then embedded steps only. Built from a
// lambda or step by step, checked against reflection as it grows, spelled one way (the clean type name, so
// `FrEntity` is `(Fr)`). DB-free.

void field;

@reflect
class FrStampMixin extends MixinEntity {
    stampedBy: string | null = null;
}

@reflect
class FrAddressEmbedded extends EmbeddedEntity {
    city: string = "";
    zip: string | null = null;
}

@entity("Main", "Master")
class FrTarget extends Entity {
    name: string = "";
}

@reflect
class FrFlagMixin extends MixinEntity {
    flag: boolean = false;
}

@entity("Main", "Master")
@mixin(() => [FrFlagMixin])
class FrEntity extends Entity {
    code: string = "";
    address: FrAddressEmbedded | null = null;
    target: Lite<FrTarget> | null = null;
}

MixinDeclarations.register(FrAddressEmbedded, FrStampMixin);

describe("FieldRoute", () => {
    test("spelled one way, however it is built", () => {
        const fromLambda = FrEntity.fieldRoute(e => e.address!.city);
        const stepByStep = FieldRoute.root(FrEntity).add("address").add("city");
        assert.equal(fromLambda.toString(), "(Fr).address.city");
        assert.ok(fromLambda.equals(stepByStep));
        assert.equal(fromLambda.fieldInfo!.name, "city");
        assert.deepEqual(fromLambda.fieldPath, ["address", "city"]);
    });

    test("a mixin is an explicit step — on the entity, and on an embedded", () => {
        assert.equal(FrEntity.fieldRoute(e => e.mixin(FrFlagMixin).flag).toString(), "(Fr).[FrFlagMixin].flag");
        const stamp = FrEntity.fieldRoute(e => e.address).addLambda((a: FrAddressEmbedded) => a.mixin(FrStampMixin).stampedBy);
        assert.equal(stamp.toString(), "(Fr).address.[FrStampMixin].stampedBy");
        // …but the value is read off the instance by field names alone (mixins are inlined).
        assert.deepEqual(stamp.fieldPath, ["address", "stampedBy"]);
    });

    test("refuses what leaves the row, or does not exist", () => {
        assert.throws(() => FieldRoute.root(FrEntity).add("target").add("name"), /not an embedded field/);
        assert.throws(() => FieldRoute.root(FrEntity).add("nope"), /'nope' is not a field of Fr\.$/);
        assert.throws(() => FieldRoute.root(FrEntity).addMixin(FrStampMixin), /not a mixin declared on Fr\.$/);
        assert.throws(() => FieldRoute.root(FrEntity).addMixin(FrFlagMixin).addMixin(FrFlagMixin), /cannot follow another/);
    });

    test("ignoreFieldRoute takes the route: an own field, a mixin field, an embedded's mixin field", () => {
        const sb = new SchemaBuilder();
        sb.include(FrTarget);
        sb.settings.ignoreFieldRoute(FrEntity, e => e.address!.zip);
        sb.settings.ignoreFieldRoute(FieldRoute.root(FrEntity).addMixin(FrFlagMixin).add("flag"));
        sb.settings.ignoreFieldRoute(FrEntity.fieldRoute(e => e.address).addLambda((a: FrAddressEmbedded) => a.mixin(FrStampMixin).stampedBy));
        const table = sb.include(FrEntity).table;

        assert.throws(() => table.field(FrEntity.fieldRoute(e => e.address!.zip)), /has no column/);
        assert.throws(() => table.field(FrEntity.fieldRoute(e => e.mixin(FrFlagMixin).flag)), /has no column/);
        assert.throws(() => table.field(FrEntity.fieldRoute(e => e.address).addLambda((a: FrAddressEmbedded) => a.mixin(FrStampMixin).stampedBy)), /has no column/);
        assert.equal(table.field(FrEntity.fieldRoute(e => e.address!.city)).fieldInfo.name, "city");
    });
});
