import { test, describe } from "vitest";
import assert from "node:assert/strict";
import * as React from "react";
import "@altea/altea/data/globals";
import { Dic } from "@altea/altea/data/globals";
import { Temporal, Decimal } from "@altea/altea/data/basics";
import { Entity } from "@altea/altea/data/entity";
import { field } from "@altea/altea/data/reflection"; // the quote-transformer anchors its injected @field on it
import { entity, isReadOnly } from "@altea/altea/data/decorators";
import { validate } from "@altea/altea/data/validators";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { LineBaseController } from "@altea/altea/client/Lines/LineBase";
import type { StyleOptions } from "@altea/altea/client/TypeContext";
import "@altea/altea/client/AppContext"; // registers Dic.skipClasses.push(React.Component)

// The memo every line is wrapped in (LineBaseController.propEquals → TypeContext.equals). A view builds a
// NEW context chain for every line on every render, so the question is never "same object?" but "would
// the line render the same?" — and, because a context is what the line WRITES through, "is it still bound
// to the same object?". DB-free: local fixtures, contexts built the way FramePage + a view build them.

@entity("Main", "Transactional")
class MemoEntity extends Entity {
    locked: boolean = false;
    strict: boolean = false;

    @isReadOnly<MemoEntity>(m => m.locked)
    @validate<MemoEntity>(m => m.strict && m.name === "x" ? "x is not allowed when strict" : null)
    name: string | null = null;

    day: Temporal.PlainDate | null = null;

    amount: Decimal | null = null;
}

function newMemo(name: string): MemoEntity {
    const m = new MemoEntity();
    m.name = name;
    m.day = Temporal.PlainDate.from("2026-10-03");
    m.amount = new Decimal("1.50");
    return m;
}

const pack = (e: MemoEntity) => ({ entity: e, canExecute: {} });

// One "render" of FramePage + a view: a fresh frame literal, root context, styled context (the
// `ctx.subCtx({ labelColumns })` every Signum view uses) and line context — all new objects every time.
function render(pk: { entity: MemoEntity }, member: "name" | "day" | "amount" = "name"): TypeContext<unknown> {
    const frame = {
        pack: pk,
        refreshCount: 0,
        frameComponent: { forceUpdate: () => { }, type: render },
        entityComponent: undefined,
        onReload: () => { },
        isExecuting: () => false,
    };
    const root = TypeContext.root(pk.entity, { readOnly: false, frame } as unknown as StyleOptions);
    const styled = root.subCtx({ labelColumns: { sm: 4 } });
    return styled.subCtx(member);
}

/** What the line itself reads while rendering (LineBase's error + read-only tasks). */
function lineRendered(ctx: TypeContext<unknown>): void {
    const own = ctx.subCtx({});   // the line renders through `ctx.subCtx(styleOptions)`, sharing the binding
    void own.error;
    void own.bindingIsReadonly;
}

describe("TypeContext.equals — when a memoized line may skip a render", () => {

    test("a re-render that changed nothing is equal, styled context included", () => {
        // The bug this replaced: the root binding is reached twice (styled.binding IS root.binding), and the
        // old deep compare's cycle guard called every second visit 'not equal' — so the memo never held.
        const pk = pack(newMemo("a"));
        const prev = render(pk);
        lineRendered(prev);
        assert.equal(TypeContext.equals(prev, render(pk)), true);
    });

    test("an in-place edit made elsewhere is seen through the binding's snapshot", () => {
        const pk = pack(newMemo("a"));
        const prev = render(pk);
        pk.entity.name = "b";   // an onChange on another line, an operation, …
        assert.equal(TypeContext.equals(prev, render(pk)), false);
    });

    test("a reload re-renders even when the new graph is deep-equal: the line must not keep the dead object", () => {
        const prev = render(pack(newMemo("a")));
        const next = render(pack(newMemo("a")));
        assert.equal(TypeContext.equals(prev, next), false);
    });

    test("the entity is never walked, so its size costs nothing", () => {
        const e = newMemo("a");
        // Anything that enumerates the entity (the old deep compare walked a 600 KB file per line) trips this.
        Object.defineProperty(e, "trap", { enumerable: true, get() { throw new Error("the entity was walked"); } });

        const pk = pack(e);
        assert.equal(TypeContext.equals(render(pk), render(pk)), true);

        const other = newMemo("a");
        Object.defineProperty(other, "trap", { enumerable: true, get() { throw new Error("the entity was walked"); } });
        assert.equal(TypeContext.equals(render(pk), render(pack(other))), false);
    });

    test("a cross-field @isReadOnly the line rendered is asked again", () => {
        const pk = pack(newMemo("a"));
        const prev = render(pk);
        lineRendered(prev);
        pk.entity.locked = true;   // name's own value is unchanged, but it is now read-only
        assert.equal(TypeContext.equals(prev, render(pk)), false);
    });

    test("a cross-field validation error the line rendered is asked again", () => {
        const pk = pack(newMemo("x"));
        const prev = render(pk);
        lineRendered(prev);
        pk.entity.strict = true;   // name is still "x", but now it is an error
        assert.equal(TypeContext.equals(prev, render(pk)), false);
    });

    test("a field value is compared by what it denotes: a new equal PlainDate is the same", () => {
        const pk = pack(newMemo("a"));
        const prev = render(pk, "day");
        pk.entity.day = Temporal.PlainDate.from("2026-10-03");
        assert.equal(TypeContext.equals(prev, render(pk, "day")), true);

        pk.entity.day = Temporal.PlainDate.from("2026-10-04");
        assert.equal(TypeContext.equals(prev, render(pk, "day")), false);
    });

    test("a decimal is compared by value: NumberLine stores a new Decimal on every edit", () => {
        const pk = pack(newMemo("a"));
        const prev = render(pk, "amount");
        pk.entity.amount = new Decimal("1.5");
        assert.equal(TypeContext.equals(prev, render(pk, "amount")), true);

        pk.entity.amount = new Decimal("1.51");
        assert.equal(TypeContext.equals(prev, render(pk, "amount")), false);
    });

    test("style options are compared by value; a changed one re-renders", () => {
        const pk = pack(newMemo("a"));
        const prev = render(pk).subCtx({ readOnly: false });
        assert.equal(TypeContext.equals(prev, render(pk).subCtx({ readOnly: false })), true);
        assert.equal(TypeContext.equals(prev, render(pk).subCtx({ readOnly: true })), false);
    });
});

describe("LineBaseController.propEquals", () => {

    test("compares ctx with TypeContext.equals and the remaining props deeply", () => {
        const pk = pack(newMemo("a"));
        const props = (label: string) => ({ ctx: render(pk), label: React.createElement("span", null, label), onChange: () => { } });

        assert.equal(LineBaseController.propEquals(props("Name"), props("Name")), true);
        assert.equal(LineBaseController.propEquals(props("Name"), props("Other")), false);
    });
});

describe("Dic.equals", () => {

    test("typed arrays compare by reference: a file is replaced by a new upload, never edited in place", () => {
        const bytes = new Uint8Array(5_000_000);
        assert.equal(Dic.equals({ b: bytes }, { b: bytes }, true), true);
        assert.equal(Dic.equals({ b: new Uint8Array([1, 2, 3]) }, { b: new Uint8Array([1, 2, 3]) }, true), false);
        assert.equal(Dic.equals({ b: new Uint8Array([1, 2, 3]) }, { b: [1, 2, 3] }, true), false);
    });

    test("bigints compare by value: one with no keys must not make every pair equal", () => {
        assert.equal(Dic.equals<unknown>(1n, 2n, true), false);
        assert.equal(Dic.equals({ rowVersion: 639266567231330000n }, { rowVersion: 639266567231330001n }, true), false);
        assert.equal(Dic.equals({ rowVersion: 639266567231330000n }, { rowVersion: 639266567231330000n }, true), true);
    });

    test("decimals compare by value", () => {
        assert.equal(Dic.equals(new Decimal("1.50"), new Decimal("1.5"), true), true);
        assert.equal(Dic.equals(new Decimal("1.5"), new Decimal("2"), true), false);
    });

    test("Temporal values compare by what they denote, not by their (absent) own keys", () => {
        assert.equal(Dic.equals(Temporal.PlainDate.from("2020-01-01"), Temporal.PlainDate.from("2020-01-01"), true), true);
        assert.equal(Dic.equals(Temporal.PlainDate.from("2020-01-01"), Temporal.PlainDate.from("2025-12-31"), true), false);
        assert.equal(Dic.equals<unknown>(Temporal.PlainDate.from("2020-01-01"), Temporal.PlainDateTime.from("2020-01-01T00:00"), true), false);
    });

    test("a class component is never walked (skipClasses): different instances are 'changed'", () => {
        class View extends React.Component { }
        const v = new View({});
        assert.equal(Dic.equals({ c: v }, { c: v }, true), true);
        assert.equal(Dic.equals({ c: v }, { c: new View({}) }, true), false);
    });
});
