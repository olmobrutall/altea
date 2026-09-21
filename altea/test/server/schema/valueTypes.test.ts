import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { reflect } from "@altea/altea/data/reflection"; // anchor for the transformer's @field injection
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { entity, column, decimalsValidator, forceNotNullable, forceNullable } from "@altea/altea/data/decorators";
import {
    Decimal, Temporal, type float, type int, type long, type short, type uuid,
} from "@altea/altea/data/basics";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { IsNullable } from "@altea/altea/server/schema/dbType";

// What a value field's COLUMN is — the mapping from a TypeScript type to a database one. JavaScript has
// one number type and no GUID, so the narrower shapes are the branded aliases in data/basics; a database
// has five numeric widths and a uuid, and the widths are the difference between a Signum-compatible
// schema and a merely working one. DB-free: builds the schema in memory and inspects the columns.

@entity("Main", "Master")
class VtWidths extends Entity {
    // The branded numeric aliases, narrowest first.
    smallNumber: short;
    plainInt: int;
    bigNumber: long;
    single: float;
    // A bare `number` is DOUBLE precision — the widest thing that always holds a JS number.
    double: number;
    money: Decimal;
    // The two ways to say "four decimals", in Signum's order of preference: an explicit
    // [DbType(Scale=…)] first, then [DecimalsValidator(n)] — which is the one an entity author normally
    // writes, since it also validates the value and fixes the display format.
    @column({ scale: 4 })
    preciseMoney: Decimal;
    @decimalsValidator(4)
    validatedMoney: Decimal;
    // Both, disagreeing: the COLUMN wins, as SchemaSettings.GetSqlScale reads it first.
    @column({ scale: 6 })
    @decimalsValidator(4)
    bothMoney: Decimal;
    // A GUID is a string in the object model and a `uuid` in the database.
    identifier: uuid;
    // Signum's TimeSpan → Time (not Postgres `interval`).
    howLong: Temporal.Duration;
}

// The two deliberate disagreements between a field's nullability and its column's.
@entity("Main", "Master")
class VtNullability extends Entity {
    // Ordinary: they agree.
    required: string;
    optional: string | null = null;
    // @forceNullable — non-null field, nullable column (Signum's [ForceNullable]).
    @forceNullable
    looseColumn: string;
    // @forceNotNullable — nullable field, NOT NULL column (Signum's [ForceNotNullable]).
    @forceNotNullable
    strictColumn: string | null = null;
}

// A nullable embedded holding ANOTHER nullable embedded: the outer one's absence makes its sub-columns
// nullable, but a HasValue flag is never one of them.
@reflect
class VtInner extends EmbeddedEntity {
    amount: int | null = null;
}

@reflect
class VtOuter extends EmbeddedEntity {
    label: string | null = null;
    inner: VtInner | null = null;
}

@entity("Main", "Master")
class VtNested extends Entity {
    outer: VtOuter | null = null;
}

function pgColumns(type: any): Record<string, { pg: string; nullable: IsNullable; scale?: number; precision?: number }> {
    const sb = new SchemaBuilder();
    sb.settings.isPostgres = true;
    const table = sb.include(type).table;
    sb.complete();
    const out: Record<string, { pg: string; nullable: IsNullable; scale?: number; precision?: number }> = {};
    for (const [name, c] of Object.entries(table.columns))
        out[name] = { pg: c.dbType.postgres, nullable: c.nullable, scale: c.scale, precision: c.precision };
    return out;
}

describe("Value type → column mapping", () => {
    test("each numeric alias picks its own width; a bare number is double precision", () => {
        const c = pgColumns(VtWidths);
        assert.equal(c["small_number"]!.pg, "int2");
        assert.equal(c["plain_int"]!.pg, "int4");
        assert.equal(c["big_number"]!.pg, "int8");
        assert.equal(c["single"]!.pg, "float4", "float is SINGLE precision (Signum's float / real)");
        assert.equal(c["double"]!.pg, "float8", "a bare number stays double");
    });

    test("a GUID field is a uuid column, not text", () => {
        assert.equal(pgColumns(VtWidths)["identifier"]!.pg, "uuid");
    });

    test("a Duration is Signum's `time`, not Postgres `interval`", () => {
        assert.equal(pgColumns(VtWidths)["how_long"]!.pg, "time");
    });

    test("a decimal defaults to Signum's money shape, and both scale sources override it", () => {
        const c = pgColumns(VtWidths);
        assert.equal(c["money"]!.pg, "numeric");
        assert.equal(c["money"]!.precision, 18);
        assert.equal(c["money"]!.scale, 2, "Signum's defaultScale for Decimal");
        assert.equal(c["precise_money"]!.scale, 4, "@column({ scale }) — Signum's [DbType(Scale=…)]");
        assert.equal(c["validated_money"]!.scale, 4, "@decimalsValidator(n) is where the scale comes from");
        assert.equal(c["both_money"]!.scale, 6, "an explicit column scale wins (GetSqlScale reads it first)");
    });
});

describe("Field vs column nullability", () => {
    test("they agree unless told otherwise", () => {
        const c = pgColumns(VtNullability);
        assert.equal(c["required"]!.nullable, IsNullable.No);
        assert.equal(c["optional"]!.nullable, IsNullable.Yes);
    });

    test("@forceNullable → nullable COLUMN for a non-null field", () => {
        assert.equal(pgColumns(VtNullability)["loose_column"]!.nullable, IsNullable.Forced);
    });

    test("@forceNotNullable → NOT NULL column for a nullable field", () => {
        assert.equal(pgColumns(VtNullability)["strict_column"]!.nullable, IsNullable.No);
    });

    test("a nullable embedded makes its sub-columns nullable — but never a HasValue flag", () => {
        const c = pgColumns(VtNested);
        // The outer embedded's own flag, and its ordinary sub-column made nullable by its absence.
        assert.equal(c["outer_has_value"]!.nullable, IsNullable.No);
        assert.equal(c["outer_label"]!.nullable, IsNullable.Yes);
        // The NESTED embedded's flag stays NOT NULL: `false` already says "absent", so a nullable
        // presence flag would invent a third state. No Signum database has one.
        assert.equal(c["outer_inner_has_value"]!.nullable, IsNullable.No);
        assert.equal(c["outer_inner_amount"]!.nullable, IsNullable.Yes);
    });
});
