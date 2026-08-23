import { reflect } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { entity, quoted, stringLengthValidator, uniqueIndex } from "@altea/altea/data/decorators";

// A tiny, purpose-built domain for the ISOLATION suite — one type per strategy, because each strategy is a
// different query filter and a different save rule:
//
//   ProjectEntity   Isolated — every row belongs to exactly one tenant, the field is required, and its
//                   UNIQUE index on `name` must become unique PER TENANT (two tenants may both have
//                   "Website"). This is the type most assertions are about.
//   TagEntity       Optional — a row may be GLOBAL (no tenant) and is then visible from every tenant, so
//                   its filter is `mine OR null` and its field must NOT be required.
//   CatalogEntity   None — not isolated at all: no column, no filter, and a tenant sees every row. It is
//                   also what proves the strategy assertion accepts a type that opts out.
//
// A fourth type is deliberately absent: `assertIsolationStrategies` is exercised by REGISTERING nothing for
// one of these (see isolationStartup.test.ts), which needs no extra entity.

@reflect
@entity("String", "Transactional")
export class ProjectEntity extends Entity {
    @uniqueIndex
    @stringLengthValidator({ min: 1, max: 100 })
    name: string;

    @quoted toString(): string { return this.name; }
}

@reflect
@entity("String", "Master")
export class TagEntity extends Entity {
    @stringLengthValidator({ min: 1, max: 100 })
    name: string;

    @quoted toString(): string { return this.name; }
}

@reflect
@entity("String", "Master")
export class CatalogEntity extends Entity {
    @stringLengthValidator({ min: 1, max: 100 })
    name: string;

    /** A reference INTO an isolated type, so the "referenced by" hint of the assertion has something to find. */
    mainProject: Lite<ProjectEntity> | null;

    @quoted toString(): string { return this.name; }
}
