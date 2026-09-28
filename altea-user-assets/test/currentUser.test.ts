import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { Entity, MixinEntity } from "@altea/altea/data/entity";
import { mixin } from "@altea/altea/data/mixinDeclarations";
import { reflect } from "@altea/altea/data/reflection";
import { isLegacyMode, setLegacyMode } from "@altea/altea/data/registration";
import type { Lite } from "@altea/altea/data/lite";
import { CurrentUserConverter } from "@altea/altea-user-assets/data/FilterValueConverters/CurrentUserConverter";
import { parseFilterValue } from "@altea/altea-user-assets/data/FilterValueString";

// "[CurrentUser]" followed by a member path, evaluated on the entity `getCurrentUserEntity` supplies — the
// client's AppContext.currentUser in the application; a hand-built one here.

@reflect
class CuProbeUnitEntity extends Entity {
    name: string;
}

@reflect
class CuProbeCareerMixin extends MixinEntity {
    organizationalUnit: Lite<CuProbeUnitEntity> | null;
}

@reflect
@mixin(() => [CuProbeCareerMixin])
class CuProbeUserEntity extends Entity {
    userName: string;
    unitName(): string { return "U-" + this.userName; }
}

const unit = CuProbeUnitEntity.create({ name: "Sales" });
unit.id = 7;
const user = CuProbeUserEntity.create({ userName: "ana" });
user.id = 1;
(user as unknown as CuProbeCareerMixin).organizationalUnit = unit.toLite();

let wasLegacy = false;
beforeEach(() => {
    wasLegacy = isLegacyMode();
    CurrentUserConverter.getCurrentUserEntity = () => user;
});
afterEach(() => {
    setLegacyMode(wasLegacy);
    CurrentUserConverter.getCurrentUserEntity = undefined;
});

function parse(expression: string): unknown {
    const r = CurrentUserConverter.tryParseExpression(expression, { filterType: "Lite" });
    assert.ok(r != null, `'${expression}' was not claimed`);
    assert.ok(r.ok, `'${expression}' failed: ${r.ok ? "" : r.error}`);
    return r.value;
}

describe("CurrentUserConverter", () => {

    test("an unrelated string is not claimed", () =>
        assert.equal(CurrentUserConverter.tryParseExpression("CuProbeUnit;7", { filterType: "Lite" }), null));

    test("a mixin field resolves to its lite", () => {
        const v = parse("[CurrentUser][CuProbeCareerMixin].organizationalUnit") as Lite<CuProbeUnitEntity>;
        assert.ok(v.is(unit));
    });

    test("a parameterless method is invoked", () =>
        assert.equal(parse("[CurrentUser].unitName"), "U-ana"));

    test("a PascalCase member only matches its camelCase field in legacy mode", () => {
        setLegacyMode(false);
        const r = CurrentUserConverter.tryParseExpression("[CurrentUser][CuProbeCareerMixin].OrganizationalUnit", { filterType: "Lite" });
        assert.ok(r != null && !r.ok);

        setLegacyMode(true);
        assert.ok((parse("[CurrentUser][CuProbeCareerMixin].OrganizationalUnit") as Lite<CuProbeUnitEntity>).is(unit));
    });

    test("an undeclared mixin is an error", () => {
        const r = CurrentUserConverter.tryParseExpression("[CurrentUser][NopeMixin].organizationalUnit", { filterType: "Lite" });
        assert.ok(r != null && !r.ok);
    });

    test("a member path with no entity provider is an error, not a raw string", () => {
        CurrentUserConverter.getCurrentUserEntity = undefined;
        assert.throws(() => parseFilterValue("[CurrentUser][CuProbeCareerMixin].organizationalUnit", "Lite"));
    });

    test("parseFilterValue routes through it ahead of the Lite converter", () => {
        const v = parseFilterValue("[CurrentUser][CuProbeCareerMixin].organizationalUnit", "Lite") as Lite<CuProbeUnitEntity>;
        assert.ok(v.is(unit));
    });
});
