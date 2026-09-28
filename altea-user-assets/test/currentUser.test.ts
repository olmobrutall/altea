import "@altea/altea/server/context.node"; // [CurrentEntity] is a context variable
import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { Entity, MixinEntity } from "@altea/altea/data/entity";
import { mixin } from "@altea/altea/data/mixinDeclarations";
import { reflect } from "@altea/altea/data/reflection";
import { isLegacyMode, setLegacyMode } from "@altea/altea/data/registration";
import type { Lite } from "@altea/altea/data/lite";
import { CurrentUserConverter } from "@altea/altea-user-assets/data/FilterValueConverters/CurrentUserConverter";
import { CurrentEntityConverter } from "@altea/altea-user-assets/data/FilterValueConverters/CurrentEntityConverter";
import { parseFilterValue } from "@altea/altea-user-assets/data/FilterValueString";

// "[CurrentUser]" followed by a member path, evaluated on the entity `getCurrentUserEntity` supplies — the
// client's AppContext.currentUser in the application; a hand-built one here.

@reflect
class CuProbeDepartmentEntity extends Entity {
    name: string;
}

@reflect
class CuProbeDepartmentMixin extends MixinEntity {
    department: Lite<CuProbeDepartmentEntity> | null;
}

@reflect
@mixin(() => [CuProbeDepartmentMixin])
class CuProbeUserEntity extends Entity {
    userName: string;
    departmentLabel(): string { return "D-" + this.userName; }
}

const department = CuProbeDepartmentEntity.create({ name: "Sales" });
department.id = 7;
const user = CuProbeUserEntity.create({ userName: "ana" });
user.id = 1;
(user as unknown as CuProbeDepartmentMixin).department = department.toLite();

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
        assert.equal(CurrentUserConverter.tryParseExpression("CuProbeDepartment;7", { filterType: "Lite" }), null));

    test("a mixin field resolves to its lite", () => {
        const v = parse("[CurrentUser][CuProbeDepartmentMixin].department") as Lite<CuProbeDepartmentEntity>;
        assert.ok(v.is(department));
    });

    test("a parameterless method is invoked", () =>
        assert.equal(parse("[CurrentUser].departmentLabel"), "D-ana"));

    test("a PascalCase member only matches its camelCase field in legacy mode", () => {
        setLegacyMode(false);
        const r = CurrentUserConverter.tryParseExpression("[CurrentUser][CuProbeDepartmentMixin].Department", { filterType: "Lite" });
        assert.ok(r != null && !r.ok);

        setLegacyMode(true);
        assert.ok((parse("[CurrentUser][CuProbeDepartmentMixin].Department") as Lite<CuProbeDepartmentEntity>).is(department));
    });

    test("an undeclared mixin is an error", () => {
        const r = CurrentUserConverter.tryParseExpression("[CurrentUser][NopeMixin].department", { filterType: "Lite" });
        assert.ok(r != null && !r.ok);
    });

    test("a member path with no entity provider is an error, not a raw string", () => {
        CurrentUserConverter.getCurrentUserEntity = undefined;
        assert.throws(() => parseFilterValue("[CurrentUser][CuProbeDepartmentMixin].department", "Lite"));
    });

    test("parseFilterValue routes through it ahead of the Lite converter", () => {
        const v = parseFilterValue("[CurrentUser][CuProbeDepartmentMixin].department", "Lite") as Lite<CuProbeDepartmentEntity>;
        assert.ok(v.is(department));
    });
});

// "[CurrentEntity]": the same member paths, on the entity the parse is scoped to with `withCurrentEntity`.
describe("CurrentEntityConverter", () => {

    test("the bare form is the scoped entity's lite; outside a scope it is no value", () => {
        const v = CurrentEntityConverter.withCurrentEntity(user, () => parseFilterValue("[CurrentEntity]", "Lite")) as Lite<CuProbeUserEntity>;
        assert.ok(v.is(user));
        assert.equal(parseFilterValue("[CurrentEntity]", "Lite"), undefined);
    });

    test("a member path is evaluated on the scoped entity", () => {
        const v = CurrentEntityConverter.withCurrentEntity(user,
            () => parseFilterValue("[CurrentEntity][CuProbeDepartmentMixin].department", "Lite")) as Lite<CuProbeDepartmentEntity>;
        assert.ok(v.is(department));
    });

    test("a member path over a thin lite is an error", () =>
        assert.throws(() => CurrentEntityConverter.withCurrentEntity(user.toLite(),
            () => parseFilterValue("[CurrentEntity][CuProbeDepartmentMixin].department", "Lite"))));

    test("a list value resolves each part", () => {
        const v = CurrentEntityConverter.withCurrentEntity(user,
            () => parseFilterValue("[CurrentEntity] | [CurrentUser]", "Lite", undefined, { isList: true })) as Lite<CuProbeUserEntity>[];
        assert.equal(v.length, 2);
        assert.ok(v[0].is(user));
    });
});
