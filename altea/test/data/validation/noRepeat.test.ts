import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import { noRepeatValidator } from "@altea/altea/data/validators";
import { reflect } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { entity, part, backReference, valueField } from "@altea/altea/data/decorators";
import type { Lite } from "@altea/altea/data/lite";

// Signum's [NoRepeatValidator] compares MList ELEMENTS, which are embeddeds compared structurally with
// `Equals`. altea has no MList: the collection is an array of `@part` ROWS, each a distinct object, so the
// same declaration would compare object identity and could never report. These tests pin the two halves of
// the answer: the SELECTOR form does the comparison Signum meant, and the bare form REFUSES rather than
// passing silently whenever the value it would compare has no identity of its own.

@part
class NoRepeatRow extends Entity {
    @backReference owner: Lite<NoRepeatOwner>;
    product: string = "";
    quantity: number = 0;
}

@part
class ValueRow extends Entity {
    @backReference owner: Lite<NoRepeatOwner>;
    @valueField territory: string = "";
}

@reflect
class KeylessEmbedded extends EmbeddedEntity {
    name: string = "";
}

@part
class EmbeddedValueRow extends Entity {
    @backReference owner: Lite<NoRepeatOwner>;
    @valueField element: KeylessEmbedded = new KeylessEmbedded();
}

@entity("Main", "Master")
class NoRepeatOwner extends Entity {
    @noRepeatValidator<NoRepeatRow>(a => a.product)
    lines: NoRepeatRow[] = [];
}

@entity("Main", "Master")
class BareOverRows extends Entity {
    @noRepeatValidator()
    lines: NoRepeatRow[] = [];
}

@entity("Main", "Master")
class BareOverValues extends Entity {
    @noRepeatValidator()
    territories: ValueRow[] = [];
}

@entity("Main", "Master")
class BareOverEmbeddedValues extends Entity {
    @noRepeatValidator()
    elements: EmbeddedValueRow[] = [];
}

function row(product: string, quantity: number): NoRepeatRow {
    const r = NoRepeatRow.create({});
    r.product = product;
    r.quantity = quantity;
    return r;
}

describe("noRepeatValidator", () => {

    test("the SELECTOR compares that member, so two rows sharing it repeat", () => {
        const e = NoRepeatOwner.create({});
        e.lines = [row("Chai", 1), row("Chang", 2)];
        assert.equal(entityIntegrityCheck(e, "Saving"), null);

        // Distinct ROWS, distinct quantities — and still a repeat, because the compared member matches.
        e.lines = [row("Chai", 1), row("Chai", 7)];
        assert.match(String(entityIntegrityCheck(e, "Saving")?.errors["lines"]), /Chai/);
    });

    test("a bare validator over rows with no @valueField THROWS instead of passing", () => {
        const e = BareOverRows.create({});
        e.lines = [row("Chai", 1), row("Chai", 1)];
        assert.throws(
            () => entityIntegrityCheck(e, "Saving"),
            /NoRepeatRow, which has no identity of its own/);
    });

    test("a bare validator over a @valueField holding a VALUE is the meaningful case", () => {
        const e = BareOverValues.create({});
        const a = ValueRow.create({}), b = ValueRow.create({});
        a.territory = "Seattle";
        b.territory = "Bellevue";
        e.territories = [a, b];
        assert.equal(entityIntegrityCheck(e, "Saving"), null);

        b.territory = "Seattle";
        assert.match(String(entityIntegrityCheck(e, "Saving")?.errors["territories"]), /Seattle/);
    });

    test("a @valueField holding an EMBEDDED has no identity either, so the bare form still throws", () => {
        const e = BareOverEmbeddedValues.create({});
        e.elements = [EmbeddedValueRow.create({}), EmbeddedValueRow.create({})];
        assert.throws(
            () => entityIntegrityCheck(e, "Saving"),
            /KeylessEmbedded, which has no identity of its own/);
    });

    test("a list of one, or an empty one, is never a repeat", () => {
        const e = BareOverRows.create({});
        e.lines = [row("Chai", 1)];
        assert.equal(entityIntegrityCheck(e, "Saving"), null);
        e.lines = [];
        assert.equal(entityIntegrityCheck(e, "Saving"), null);
    });
});
