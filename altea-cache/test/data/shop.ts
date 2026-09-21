import { reflect } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { Lite, LiteImp, registerCustomLite } from "@altea/altea/data/lite";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { entity, part, quoted, backReference, rowOrder } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { registerEnum } from "@altea/altea/data/registration";
import { type int, toInt, Decimal, Temporal } from "@altea/altea/data/basics";

// A tiny, purpose-built domain for the CACHE test suite. Every entity exercises one thing the cache has to
// get right — the table in port/Cache.md says which, and is worth reading before changing any of
// them, because none of these shapes is incidental.

export enum Continent {
    Europe = 0,
    America = 1,
    Asia = 2,
}
registerEnum(Continent);

@reflect
export class GeoEmbedded extends EmbeddedEntity {
    latitude: Decimal;
    longitude: Decimal;
}

@entity("String", "Master")
export class DepartmentEntity extends Entity {
    @stringLengthValidator({ min: 1, max: 100 })
    name: string;

    @quoted toString(): string { return this.name; }
}

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

// The custom lite of Employee. `fromEntity` is a Quoted lambda:
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

@entity("Main", "Master")
export class CountryEntity extends Entity {
    @stringLengthValidator({ min: 2, max: 3 })
    isoCode: string;

    @stringLengthValidator({ min: 1, max: 100 })
    name: string;

    population: int = toInt(0);

    area: Decimal;

    independenceDay: Temporal.PlainDate | null = null;

    continent: Continent = Continent.Europe;

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

@part
export class CountryEntity_Region extends Entity {
    @backReference country: Lite<CountryEntity>;

    @rowOrder rowOrder: int;

    @stringLengthValidator({ min: 1, max: 100 })
    name: string;

    @quoted toString(): string { return this.name; }
}
