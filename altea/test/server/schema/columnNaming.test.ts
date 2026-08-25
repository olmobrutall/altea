import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { reflect } from "@altea/altea/data/reflection"; // anchor for the transformer's @field injection
import type { FieldInfo } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, column, implementedBy } from "@altea/altea/data/decorators";
import { SchemaBuilder } from "@altea/altea/server/schema";

// Physical COLUMN NAMING: the convention, its two override points (SchemaBuilder.columnName /
// .idiomatic — Signum's GenerateFieldName / Idiomatic), and what an explicit `@column({ columnName })`
// means. DB-free: builds the schema in memory and inspects table.columns.

// A plain TS enum, auto-registered by the transformer — the idiom the other fixtures use.
export enum NameState { Open, Closed }

@entity("Main", "Master")
class NameTarget extends Entity {
    title: string;
}

@entity("Main", "Master")
class NameOther extends Entity {
    title: string;
}

@reflect
class NameAddress extends EmbeddedEntity {
    city: string;
    postalCode: string | null;
}

@entity("Main", "Transactional")
class NameOrder extends Entity {
    // the plain convention: camelCase field → PascalCase column
    shipName: string;
    // @column with options but NO columnName — must still follow the convention (the bug that made a
    // decorated field come out camelCase while its siblings were PascalCase)
    @column({ size: 200 }) trackingCode: string | null;
    // an explicit rename: this IS the column name, verbatim
    @column({ columnName: "LegacyRef" }) reference: string | null;
    // reference / enum / embedded, to check the `ID` suffix and the embedded prefix
    target: Lite<NameTarget> | null;
    state: NameState;
    address: NameAddress;
    // an explicit rename on a REFERENCE: verbatim too — NOT "LegacyOwnerID"
    @column({ columnName: "LegacyOwner" }) owner: Lite<NameTarget> | null;
    // an explicit rename on an EMBEDDED: replaces the prefix its members hang off
    @column({ columnName: "Ship" }) shipTo: NameAddress | null;
}

@entity("Main", "Transactional")
class NamePoly extends Entity {
    @implementedBy(() => [NameTarget, NameOther]) who: Lite<Entity> | null;
}

@entity("Main", "Transactional")
class NamePolyRenamed extends Entity {
    @column({ columnName: "Whatever" })
    @implementedBy(() => [NameTarget, NameOther]) who: Lite<Entity> | null;
}

function columnsOf(ctor: any, sb: SchemaBuilder = new SchemaBuilder()): string[] {
    return Object.keys(sb.include(ctor).table.columns);
}

describe("column naming", () => {

    test("the convention is PascalCase, and @column options do not change it", () => {
        const cols = columnsOf(NameOrder);
        assert.ok(cols.includes("ShipName"), cols.join(", "));
        // the regression: `@column({ size })` must not leak the raw camelCase key
        assert.ok(cols.includes("TrackingCode"), cols.join(", "));
        assert.ok(!cols.includes("trackingCode"), cols.join(", "));
    });

    test("a reference gets the ID suffix, an enum too, an embedded prefixes its members", () => {
        const cols = columnsOf(NameOrder);
        assert.ok(cols.includes("TargetID"), cols.join(", "));
        assert.ok(cols.includes("StateID"), cols.join(", "));
        assert.ok(cols.includes("Address_City"), cols.join(", "));
        assert.ok(cols.includes("Address_PostalCode"), cols.join(", "));
    });

    test("an @implementedBy field gets one column per implementation", () => {
        const cols = columnsOf(NamePoly);
        assert.ok(cols.includes("WhoID_NameTarget"), cols.join(", "));
        assert.ok(cols.includes("WhoID_NameOther"), cols.join(", "));
    });

    test("@column({ columnName }) IS the column name — verbatim, for every kind", () => {
        const cols = columnsOf(NameOrder);
        // a value field: no change of case, and no embedded prefix
        assert.ok(cols.includes("LegacyRef"), cols.join(", "));
        // a REFERENCE: verbatim, so NO "ID" suffix appended
        assert.ok(cols.includes("LegacyOwner"), cols.join(", "));
        assert.ok(!cols.includes("LegacyOwnerID"), cols.join(", "));
        // an EMBEDDED: replaces the prefix its members hang off
        assert.ok(cols.includes("Ship_City"), cols.join(", "));
        assert.ok(!cols.includes("ShipTo_City"), cols.join(", "));
    });

    test("a polymorphic reference cannot be named by @column({ columnName })", () => {
        assert.throws(() => columnsOf(NamePolyRenamed), /one column per implementation/);
    });

    test("Postgres snake_cases every column (SchemaBuilder.idiomatic)", () => {
        const sb = new SchemaBuilder();
        sb.settings.isPostgres = true;
        const cols = columnsOf(NameOrder, sb);
        assert.ok(cols.includes("ship_name"), cols.join(", "));
        assert.ok(cols.includes("tracking_code"), cols.join(", "));
        assert.ok(cols.includes("target_id"), cols.join(", "));
        assert.ok(cols.includes("address_city"), cols.join(", "));
        assert.ok(cols.includes("id"), cols.join(", "));
        assert.ok(cols.includes("ticks"), cols.join(", "));
        // an explicit name is NOT re-spelled: a hand-picked column name is not altea's to change
        assert.ok(cols.includes("LegacyRef"), cols.join(", "));
    });

    test("columnName is the override point for every field a FieldInfo describes", () => {
        class Prefixed extends SchemaBuilder {
            protected override columnName(fi: FieldInfo): string {
                return "z" + super.columnName(fi);
            }
        }
        const cols = columnsOf(NameOrder, new Prefixed());
        assert.ok(cols.includes("zShipName"), cols.join(", "));
        assert.ok(cols.includes("zTargetID"), cols.join(", "));   // reference
        assert.ok(cols.includes("zStateID"), cols.join(", "));    // enum
        assert.ok(cols.includes("zAddress_zCity"), cols.join(", ")); // embedded + its member
        assert.ok(columnsOf(NamePoly, new Prefixed()).includes("zWhoID_NameTarget"));
        // the fixed columns have no FieldInfo, so they are `idiomatic`'s business, not this hook's
        assert.ok(cols.includes("ID") && cols.includes("Ticks"), cols.join(", "));
    });

    test("idiomatic is the override point that also covers the fixed columns", () => {
        class Loud extends SchemaBuilder {
            protected override idiomatic(logical: string): string {
                return super.idiomatic(logical).toUpperCase();
            }
        }
        const cols = columnsOf(NameOrder, new Loud());
        assert.ok(cols.includes("SHIPNAME"), cols.join(", "));
        assert.ok(cols.includes("TARGETID"), cols.join(", "));
        assert.ok(cols.includes("TICKS"), cols.join(", "));
    });
});
