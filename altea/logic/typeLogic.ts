import { Connector } from "./connection/connector";
import { cleanTypeName } from "../entities/registration";
import { TypeEntity } from "../entities/typeEntity";
import { quotedFunction } from "./query";
import { ClassType } from "../entities/runtimeTypes";
import type { PrimaryKey } from "../entities/entity";
import type { Schema } from "./schema/schema";
import type { Table } from "./schema/table";
import type { SqlPreCommand } from "./sync/sqlPreCommand";

// Port of Signum's TypeLogic (Engine/Basics/TypeLogic.cs): the single server-side
// facade mapping every persistent entity type to a stable int id, via the
// TypeEntity system table. That id is the discriminator `@implementedByAll` stores
// (its type column), what `GetType()`/type-equality compares, and what the reader
// resolves back to a constructor — `TypeToId` / `IdToType` (Signum's core caches),
// plus `IdToEntity` (the `Map<PrimaryKey, TypeEntity>`).
//
// Differences vs Signum (because altea has no schema Synchronizer yet — "no Sync"):
//  - **ids are assigned deterministically in memory** (sorted by constructor name,
//    1..N over the entity tables) rather than by the database identity column and
//    read back. The same assignment runs in every process (the schema is built
//    identically), and the generation step seeds the rows with those explicit ids,
//    so the in-memory caches and the DB rows always agree without a read-back.
//    (When a Synchronizer lands, switch to loading ids from the DB like Signum;
//    only this module changes.)
//  - enum side-tables (keyed by a generic descriptor, not a constructor) get no
//    TypeEntity row — they are never `@implementedByAll` targets.
export class TypeLogic {
    private constructor() { }

    // The caches live on the Schema (not process-global statics), so multiple schemas
    // coexist in one process without clobbering each other. The read methods resolve the
    // registry from the active connection's schema (Signum reaches its caches via
    // Schema.Current); the offline binder tests wrap binding in Connector.withConnector.
    private static get schema(): Schema {
        return Connector.current().schema;
    }

    // Assigns each entity type its TypeEntity id, builds the bidirectional caches on the
    // *given* schema, and registers the generation step that seeds the rows. Called from
    // SchemaBuilder.complete() once every table is included (Signum's TypeLogic.Start +
    // the typeCaches lazy). Idempotent per schema.
    static start(schema: Schema): void {
        schema.typeToIdMap.clear();
        schema.idToTypeMap.clear();
        schema.idToEntityMap.clear();
        schema.typeRows.length = 0;

        // Only real entity constructors (skip enum side-tables, which are keyed by a
        // generic descriptor). Sorted by constructor name so the id assignment is
        // identical across processes (gen vs. run) without reading the DB back.
        const entries: [Function, Table][] = [];
        for (const [type, table] of schema.tables)
            if (typeof type === "function")
                entries.push([type, table]);
        entries.sort((a, b) => (a[0].name < b[0].name ? -1 : a[0].name > b[0].name ? 1 : 0));

        entries.forEach(([ctor, table], i) => {
            const id = i + 1;
            const cleanName = cleanTypeName(ctor);
            const tableName = table.name.name;
            schema.typeToIdMap.set(ctor, id);
            schema.idToTypeMap.set(id, ctor);

            const te = new TypeEntity();
            (te as { id: PrimaryKey }).id = id;
            te.isNew = false;
            te.tableName = tableName;
            te.cleanName = cleanName;
            te.namespace = "";
            te.className = ctor.name;
            schema.idToEntityMap.set(id, te);

            schema.typeRows.push({ id, tableName, cleanName, namespace: "", className: ctor.name });
        });

        if (!schema.generating.includes(seedTypeEntities))
            schema.generating.push(seedTypeEntities);
    }

    // The discriminator id for an entity type (Signum's TypeToId.GetOrThrow).
    static typeToId(ctor: Function): PrimaryKey {
        const id = this.schema.typeToIdMap.get(ctor);
        if (id == null)
            throw new Error(`Type '${ctor.name}' is not registered in TypeLogic. Was its table included before SchemaBuilder.complete()?`);
        return id;
    }

    // The entity type for a discriminator id, or undefined if unknown (Signum's
    // Schema.GetType / IdToType lookup — the IBA materialisation path).
    static tryGetType(id: PrimaryKey | null): Function | undefined {
        return id == null ? undefined : this.schema.idToTypeMap.get(id);
    }

    static getType(id: PrimaryKey): Function {
        const ctor = this.schema.idToTypeMap.get(id);
        if (ctor == null)
            throw new Error(`No registered entity type for TypeEntity id '${id}'.`);
        return ctor;
    }

    // The TypeEntity row for a discriminator id (Signum's IdToType + TypeToEntity).
    static idToEntity(id: PrimaryKey): TypeEntity | undefined {
        return this.schema.idToEntityMap.get(id);
    }

    // The clean type name (Signum's Reflector.CleanTypeName) — used to populate the
    // TypeEntity.cleanName column and for display, NOT as the stored discriminator.
    static getCleanName(ctor: Function): string {
        return cleanTypeName(ctor);
    }
}

// Generation step (Signum's TypeLogic.Schema_Generating): INSERT one row per
// entity type into the TypeEntity table with its assigned id. Runs after the
// tables exist (pushed last onto `schema.generating`). Reads the rows off the
// schema it is invoked with — no module-global state.
function seedTypeEntities(schema: Schema): SqlPreCommand | undefined {
    const table = schema.tryTable(TypeEntity as never);
    if (table == null || schema.typeRows.length === 0)
        return undefined;
    return Connector.current().sqlBuilder.insertTypeEntities(table, schema.typeRows);
}

// `f.constructor.toTypeEntity()` in a query (Signum's Type.ToTypeEntity() on a runtime type):
// `this` is the entity constructor, so this returns its TypeEntity row via TypeLogic's caches. A
// real in-memory body (so it also works when a lambda runs in memory) plus the query `__resultType`
// fromQuoted reads to type the call; the QueryBinder lowers it to SQL. `f.constructor` (GetType)
// and `lite.entityType` are runtime-type tokens typed `Function`, so this method lives on Function;
// `Type.FullName` maps to native `Function.name`. Lives here in TypeLogic — the entity-type ↔
// TypeEntity facade it resolves against. (`.niceName()` lives in localization.ts.)
declare global {
    interface Function {
        toTypeEntity(): TypeEntity;
    }
}
Function.prototype.toTypeEntity = function (this: Function): TypeEntity {
    return TypeLogic.idToEntity(TypeLogic.typeToId(this))!;
};
quotedFunction(Function.prototype.toTypeEntity).__resultType = () => new ClassType(TypeEntity);
