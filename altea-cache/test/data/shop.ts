import { reflect } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { Lite, LiteImp, registerCustomLite } from "@altea/altea/data/lite";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { entity, quoted, backReference, rowOrder, stringLengthValidator } from "@altea/altea/data/decorators";
import { registerEnum } from "@altea/altea/data/registration";
import { type int, toInt, Decimal, Temporal } from "@altea/altea/data/basics";

// A tiny, purpose-built domain for the CACHE test suite — the altea-cache analogue of altea-auth-test's
// `sample`. Every entity here exists to exercise one thing the cache has to get right:
//
//   CountryEntity        Master, CACHED — value columns of every materialisation shape (int / Decimal /
//                        PlainDate / enum / embedded), plus one reference of each kind below.
//   CountryEntity_Region a `@part` collection with `@rowOrder` — served from the CHILD's own cached table
//                        through its back-reference index (altea has no MList table).
//   CurrencyEntity       Master, CACHED, and its `toString()` is HAND-WRITTEN — so the table has a ToStr
//                        column, and its lite must still come out right (built from the full cached row).
//   EmployeeEntity       Transactional ⇒ SEMI: referenced by a cached row as `Lite<EmployeeEntity>` with a
//                        CUSTOM LITE over (name, email). The cache must hold ONLY those columns, for ONLY
//                        the referenced rows — never the whole row (`secretNotes`, `department`).
//   OrderEntity          Transactional ⇒ SEMI with a HAND-WRITTEN toString: the trimmed table holds the
//                        ToStr column and nothing else.
//   DepartmentEntity     Master, referenced ONLY by the semi-cached Employee. It must NOT be cached: that
//                        is the transitive-containment guard — following a semi type's own references is
//                        how caching one Master type ends up pulling in most of the database.

export enum ContinentEnum {
    Europe = 0,
    America = 1,
    Asia = 2,
}
registerEnum(ContinentEnum);

@reflect
export class GeoEmbedded extends EmbeddedEntity {
    latitude: Decimal;
    longitude: Decimal;
}

@reflect
@entity("String", "Master")
export class DepartmentEntity extends Entity {
    @stringLengthValidator({ min: 1, max: 100 })
    name: string;

    @quoted toString(): string { return this.name; }
}

@reflect
@entity("String", "Master")
export class CurrencyEntity extends Entity {
    @stringLengthValidator({ min: 1, max: 10 })
    isoCode: string;

    @stringLengthValidator({ min: 1, max: 10 })
    symbol: string;

    // HAND-WRITTEN (no @quoted): the schema materialises a ToStr column for it, which is the case the
    // cache has to treat specially — there is no expression to read the display string from.
    toString(): string {
        return `${this.isoCode} (${this.symbol})`;
    }
}

@reflect
@entity("Main", "Transactional")
export class EmployeeEntity extends Entity {
    @stringLengthValidator({ min: 1, max: 100 })
    name: string;

    @stringLengthValidator({ max: 200 })
    email: string;

    // Must NEVER be cached (not part of the lite).
    @stringLengthValidator({ max: 500 })
    secretNotes: string = "";

    // A reference of the semi type: following it would drag Department into the cache. It must not.
    department: Lite<DepartmentEntity>;

    @quoted toString(): string { return this.name; }
}

// The custom lite of Employee — altea's equivalent of a Signum lite MODEL. `fromEntity` is a Quoted lambda:
// it runs verbatim in memory AND carries its expression tree, which is what LiteColumnsFinder walks to
// decide that only `name` (through toString) and `email` have to be cached.
export class EmployeeLite extends LiteImp<EmployeeEntity> {
    constructor(id: PrimaryKey, toStr: string, readonly email: string) {
        super(id, EmployeeEntity, toStr);
    }
    static isCompatible(json: Record<string, unknown>): boolean { return typeof json.email === "string"; }
    static fromJson(json: Record<string, unknown>): Lite<EmployeeEntity> {
        return new EmployeeLite(json.id as PrimaryKey, (json.toStr as string) ?? "", json.email as string);
    }
}

registerCustomLite(EmployeeEntity, EmployeeLite, e => new EmployeeLite(e.id, e.toString(), e.email), true);

@reflect
@entity("Main", "Transactional")
export class OrderEntity extends Entity {
    @stringLengthValidator({ min: 1, max: 50 })
    number: string;

    total: Decimal;

    // HAND-WRITTEN on a SEMI type: the trimmed lite table holds the ToStr column and nothing else.
    toString(): string {
        return `Order ${this.number}`;
    }
}

@reflect
@entity("Main", "Master")
export class CountryEntity extends Entity {
    @stringLengthValidator({ min: 2, max: 3 })
    isoCode: string;

    @stringLengthValidator({ min: 1, max: 100 })
    name: string;

    population: int = toInt(0);

    area: Decimal;

    independenceDay: Temporal.PlainDate | null = null;

    continent: ContinentEnum = ContinentEnum.Europe;

    center: GeoEmbedded | null = null;

    // Master → Master: the target is cached too, so its lite comes from its OWN cached rows.
    currency: Lite<CurrencyEntity>;

    // Master → Transactional: SEMI. Only the columns EmployeeLite needs, for only the referenced rows.
    salesRep: Lite<EmployeeEntity> | null = null;

    // Master → Transactional with a hand-written toString: SEMI over the ToStr column.
    lastOrder: Lite<OrderEntity> | null = null;

    // A `@part` collection: child rows in the child's own table, ordered by @rowOrder.
    regions: CountryEntity_Region[];

    @quoted toString(): string { return this.name; }
}

@reflect
@entity("Part")
export class CountryEntity_Region extends Entity {
    @backReference country: Lite<CountryEntity>;

    @rowOrder rowOrder: int;

    @stringLengthValidator({ min: 1, max: 100 })
    name: string;

    @quoted toString(): string { return this.name; }
}
