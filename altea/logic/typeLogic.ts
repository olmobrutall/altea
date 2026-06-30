import { Connector } from "./connection/connector";
import { cleanTypeName } from "../entities/registration";
import { TypeEntity } from "../entities/typeEntity";
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
    private constructor() {}

    private static typeToIdMap = new Map<Function, PrimaryKey>();
    private static idToTypeMap = new Map<PrimaryKey, Function>();
    private static idToEntityMap = new Map<PrimaryKey, TypeEntity>();

    // Assigns each entity type its TypeEntity id, builds the bidirectional caches,
    // and registers the generation step that seeds the rows. Called from
    // SchemaBuilder.complete() once every table is included (Signum's
    // TypeLogic.Start + the typeCaches lazy). Idempotent per schema.
    static start(schema: Schema): void {
        this.typeToIdMap = new Map();
        this.idToTypeMap = new Map();
        this.idToEntityMap = new Map();
        rows = [];

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
            this.typeToIdMap.set(ctor, id);
            this.idToTypeMap.set(id, ctor);

            const te = new TypeEntity();
            (te as { id: PrimaryKey }).id = id;
            te.isNew = false;
            te.tableName = tableName;
            te.cleanName = cleanName;
            te.namespace = "";
            te.className = ctor.name;
            this.idToEntityMap.set(id, te);

            rows.push({ id, tableName, cleanName, namespace: "", className: ctor.name });
        });

        if (!schema.generating.includes(seedTypeEntities))
            schema.generating.push(seedTypeEntities);
    }

    // The discriminator id for an entity type (Signum's TypeToId.GetOrThrow).
    static typeToId(ctor: Function): PrimaryKey {
        const id = this.typeToIdMap.get(ctor);
        if (id == null)
            throw new Error(`Type '${ctor.name}' is not registered in TypeLogic. Was its table included before SchemaBuilder.complete()?`);
        return id;
    }

    // The entity type for a discriminator id, or undefined if unknown (Signum's
    // Schema.GetType / IdToType lookup — the IBA materialisation path).
    static tryGetType(id: PrimaryKey | null): Function | undefined {
        return id == null ? undefined : this.idToTypeMap.get(id);
    }

    static getType(id: PrimaryKey): Function {
        const ctor = this.idToTypeMap.get(id);
        if (ctor == null)
            throw new Error(`No registered entity type for TypeEntity id '${id}'.`);
        return ctor;
    }

    // The TypeEntity row for a discriminator id (Signum's IdToType + TypeToEntity).
    static idToEntity(id: PrimaryKey): TypeEntity | undefined {
        return this.idToEntityMap.get(id);
    }

    // The clean type name (Signum's Reflector.CleanTypeName) — used to populate the
    // TypeEntity.cleanName column and for display, NOT as the stored discriminator.
    static getCleanName(ctor: Function): string {
        return cleanTypeName(ctor);
    }
}

interface TypeRow {
    readonly id: PrimaryKey;
    readonly tableName: string;
    readonly cleanName: string;
    readonly namespace: string;
    readonly className: string;
}

// The rows the last `start()` assigned, seeded by the generation step below.
// Module-level so the named handler can be deduped in `schema.generating`.
let rows: TypeRow[] = [];

// Generation step (Signum's TypeLogic.Schema_Generating): INSERT one row per
// entity type into the TypeEntity table with its assigned id. Runs after the
// tables exist (pushed last onto `schema.generating`).
function seedTypeEntities(schema: Schema): SqlPreCommand | undefined {
    const table = schema.tryTable(TypeEntity as never);
    if (table == null || rows.length === 0)
        return undefined;
    return Connector.current().sqlBuilder.insertTypeEntities(table, rows);
}
