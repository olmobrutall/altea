import "@altea/altea/server";
import { Schema } from "@altea/altea/server/schema";
import type { Table } from "@altea/altea/server/schema/table";
import {
    FieldReference, FieldImplementedBy, FieldEmbedded, FieldMixin,
    type EntityField,
} from "@altea/altea/server/schema/field";
import { isNullableToBool } from "@altea/altea/server/schema/dbType";
import { ObjectName, SchemaName, DatabaseName } from "@altea/altea/server/schema/objectName";
// NOT the `server/connection` barrel: that re-exports BOTH dialect connectors, so importing it pulls the
// `pg` and `mssql` drivers into the graph of every host that installs this module — which is exactly what
// the barrel's own comment says it exists to avoid.
import { Connector } from "@altea/altea/server/connection/connector";
import { view } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { PgNamespace } from "@altea/altea/server/sync/postgres/postgresCatalog";
import { PostgresFunctions } from "@altea/altea/server/sync/postgres/postgresFunctions";
import { SysTables, SysPartitions, SysAllocationUnits } from "@altea/altea/server/sync/sqlServer/sysTables";
import { Entity, type Type } from "@altea/altea/data/entity";
import { getLocation, cleanTypeName, enumNameOf } from "@altea/altea/data/registration";
import { tryGetTypeInfo } from "@altea/altea/data/reflection";
import { isEnumEntityType, getBoundEnum } from "@altea/altea/data/enumEntity";
import { Enum } from "@altea/altea/data/enum";
import { Symbol as SymbolBase } from "@altea/altea/data/symbol";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import { TypeAllowedBasic } from "@altea/altea-auth/data/Rules";
import type { EntityBaseType, RelationInfo, SchemaMapInfo, TableInfo } from "../data/Map";
import { MapColorProvider } from "./MapColorProvider.server";

// Port of Signum.Map's SchemaMap.cs — turn the live Schema into the node/edge graph the schema-map page
// draws: one node per mapped table, one edge per foreign key, plus each table's runtime size read from the
// database's own catalog views.
//
// altea divergences:
//  - **No MList half.** Signum emits a nested `mlistTables` list per table and a second edge list for
//    them. altea's collections are `@part` CHILD ROWS of ordinary entity tables, so they are already
//    nodes in `tables` and their back reference is already an edge in `relations` — see data/Map.ts. What
//    is kept is the FLAG that made a virtual MList readable: `isBackReference`, straight off
//    `FieldInfo.isBackReference` (Signum has to look the route up in
//    `VirtualMList.RegisteredVirtualMLists`).
//  - **Single database.** `Schema.DatabaseNames()` / `Administrator.OverrideDatabaseInSysViews` are
//    dropped, the same divergence `server/sync/schemaAssets.ts` already documents — altea has no
//    cross-database schema.
//  - **`namespace` is package + declaring folder** (see data/Map.ts).
//  - **The type-READ gate is resolved up front.** Signum filters inline with the synchronous
//    `Schema.IsAllowed(t.Type, true) == null`; altea's type authorization is async, so the allowed set is
//    computed once and the two passes below filter against it — the same shape altea-omnibox's
//    OmniboxAuth uses.
//  - The stats read runs in `ExecutionMode.global`: it queries the CATALOG, which no application rule
//    describes, and the page itself is already gated by `MapPermission.ViewMap`.
export namespace SchemaMap {

    export async function getMapInfo(): Promise<SchemaMapInfo> {
        const schema = Schema.current;
        const stats = await getRuntimeStats();

        // Real entity tables only: a raw database view (ViewBuilder) is not part of the model graph, and
        // Signum's `Schema.Tables` holds no views either.
        const entries = [...schema.tables.entries()]
            .filter(([, t]) => !t.isView) as [Type<Entity>, Table][];

        const isAllowed = await allowedTypes(entries.map(([ctor]) => ctor));
        const mapped = entries.filter(([ctor]) => isAllowed(ctor));

        const tables = mapped.map(([ctor, table]) => {
            const key = table.name.toString();
            const historyKey = table.systemVersioned?.historyTableName.toString();
            const stat = stats.get(key);
            const historyStat = historyKey == null ? undefined : stats.get(historyKey);
            const ti = tryGetTypeInfo(ctor);

            return {
                typeName: cleanTypeName(ctor),
                // An enum table's display name is the ENUM's, not the generated `EnumEntity<X>` wrapper's
                // (Signum's `EnumEntity.Extract(t.Type) ?? t.Type`).
                niceName: niceNameOf(ctor),
                tableName: key,
                entityKind: ti?.entityKind,
                entityData: ti?.entityData,
                entityBaseType: entityBaseTypeOf(ctor),
                namespace: namespaceOf(ctor),
                columns: Object.keys(table.columns).length,
                rows: stat?.rows ?? null,
                total_size_kb: stat?.total_size_kb ?? null,
                rows_history: historyStat?.rows ?? null,
                total_size_kb_history: historyStat?.total_size_kb ?? null,
                extra: {},
            } satisfies TableInfo;
        });

        const providers = await MapColorProvider.all();

        for (const provider of providers)
            if (provider.addExtra != null)
                for (const t of tables)
                    provider.addExtra(t);

        const allowedTableNames = new Set(tables.map(t => t.tableName));

        const relations = mapped.flatMap(([, table]) =>
            [...references(table)]
                .filter(r => allowedTableNames.has(r.toTable))
                .map(r => ({ ...r, fromTable: table.name.toString() } satisfies RelationInfo)));

        return {
            tables,
            relations,
            providers: providers.map(p => ({ name: p.name, niceName: p.niceName })),
        };
    }

    // ---- nodes -----------------------------------------------------------------------------------

    function niceNameOf(ctor: Function): string {
        const boundEnum = getBoundEnum(ctor);
        if (boundEnum != null)
            return Enum.niceTypeName(boundEnum as Record<string, string | number>) ?? ctor.name;
        return (ctor as unknown as Type<Entity>).niceName();
    }

    /** Signum's `SchemaMap.GetEntityBaseType`, minus SemiSymbol and MList (see data/Map.ts). */
    function entityBaseTypeOf(ctor: Function): EntityBaseType {
        if (isEnumEntityType(ctor))
            return "EnumEntity";

        if (ctor === SymbolBase || ctor.prototype instanceof SymbolBase)
            return "Symbol";

        const kind = tryGetTypeInfo(ctor)?.entityKind;
        if (kind === "Part" || kind === "SharedPart")
            return "Part";

        return "Entity";
    }

    /**
     * The grouping level Signum colours by. There is no C# namespace here; the analogue at the same
     * granularity is the owning npm package plus the folder the type is declared in — the pair
     * altea-translations groups a package's translations by, read off the transformer's `__fileInfo`.
     * `"@altea/altea-auth/data"`, `"eastwind/orders"`.
     */
    function namespaceOf(ctor: Function): string {
        // An enum table is a GENERATED `EnumEntity<X>` subclass, so it has no registration of its own —
        // its location is the ENUM's, which is what Signum's `EnumEntity.Extract(t.Type).Namespace` reads.
        const boundEnum = getBoundEnum(ctor);
        const registeredName = boundEnum != null ? enumNameOf(boundEnum) : ctor.name;

        const location = registeredName == null ? undefined : getLocation(registeredName);
        if (location == null)
            return "";
        const slash = location.fileName.lastIndexOf("/");
        const folder = slash < 0 ? "" : location.fileName.substring(0, slash);
        return folder === "" ? location.packageName : `${location.packageName}/${folder}`;
    }

    // ---- edges -----------------------------------------------------------------------------------

    /**
     * Every FK this table's row carries, as an edge (Signum's `Table.DependentTables()` restricted to the
     * non-collection ones — the collection half was the MList tables, which altea does not have).
     *
     * Walks the FIELD tree rather than the flattened `table.columns`, because the two facts that make an
     * edge readable live on the field: whether the reference is a `Lite<T>` and whether it is the
     * `@backReference` of a `@part` collection. `@implementedByAll` contributes NO edge — it points at
     * every table at once, so Signum's DependentTables cannot express it either.
     */
    function* references(table: Table): Generator<Omit<RelationInfo, "fromTable">> {
        yield* walk(Object.values(table.fields));

        for (const mixin of Object.values(table.mixins))
            yield* walk(Object.values(mixin.fields));

        function* walk(fields: EntityField[]): Generator<Omit<RelationInfo, "fromTable">> {
            for (const ef of fields) {
                const field = ef.field;

                // FieldEnum extends FieldReference, so an enum FK is an edge to its enum table too —
                // exactly as in Signum.
                if (field instanceof FieldReference) {
                    yield {
                        toTable: field.column.referenceTable!.name.toString(),
                        nullable: isNullableToBool(field.column.nullable),
                        lite: field.column.isLite,
                        isBackReference: ef.fieldInfo.isBackReference === true ? true : undefined,
                    };
                }
                else if (field instanceof FieldImplementedBy) {
                    for (const col of field.implementationColumns)
                        yield {
                            toTable: col.referenceTable!.name.toString(),
                            // Every implementation column is physically nullable (at most one is set), so
                            // the edge's "nullable" is the PROPERTY's — which is what the map means by it.
                            nullable: true,
                            lite: field.isLite,
                            isBackReference: ef.fieldInfo.isBackReference === true ? true : undefined,
                        };
                }
                else if (field instanceof FieldEmbedded) {
                    yield* walk(Object.values(field.embeddedFields));
                }
                else if (field instanceof FieldMixin) {
                    yield* walk(Object.values(field.fields));
                }
            }
        }
    }

    // ---- runtime stats ---------------------------------------------------------------------------

    interface RuntimeStats {
        rows: number;
        total_size_kb: number;
    }

    /**
     * Signum's `SchemaMap.GetRuntimeStats`, keyed the same way the model's `ObjectName.toString()` is, so
     * a stat lines up with its table. `partitions` is dropped (SQL-Server-only, nothing renders it) and
     * the multi-database loop is gone (see the header).
     *
     * The two dialects answer differently and neither is exact:
     *  - Postgres gives the PLANNER's estimate (`pg_class.reltuples`, -1 until the table is analysed) and
     *    the true byte size (`pg_total_relation_size`, indexes + TOAST included).
     *  - SQL Server gives the clustered index's partition row counts (exact enough) and the page count of
     *    every partition's allocation units, at 8 kB a page.
     *
     * A read failure is swallowed to an empty map: the map page is diagnostic, and a missing colour scale
     * is a far better outcome than no page at all (a restricted database login may not see the catalog).
     */
    async function getRuntimeStats(): Promise<Map<string, RuntimeStats>> {
        try {
            return await ExecutionMode.global(() =>
                Connector.current().isPostgres ? postgresStats() : sqlServerStats());
        } catch {
            // A restricted database login may not see the catalog. The map is diagnostic: a missing
            // colour scale beats no page at all.
            return new Map();
        }
    }

    async function postgresStats(): Promise<Map<string, RuntimeStats>> {
        const rows = await view(PgNamespace)
            .filter(ns => !ns.isInternal())
            .flatMap(ns => ns.tables(), (ns, t) => ({
                schema: ns.nspname,
                name: t.relname,
                rows: t.reltuples,
                bytes: PostgresFunctions.pg_total_relation_size(t.oid),
            }))
            .toArray();

        return new Map(rows.map(r => [objectKey(r.schema, r.name), {
            // reltuples is -1 until the table has been analysed; report that as 0 rather than a
            // negative feeding the log colour scale.
            rows: Math.max(0, Math.round(r.rows)),
            total_size_kb: Math.round(r.bytes / 1024),
        }]));
    }

    /**
     * ALTEA DIVERGENCE: three flat reads joined IN MEMORY, where Signum expresses the whole thing as one
     * LINQ query with two nested aggregates. Both produce the same numbers; this shape does not depend on
     * the provider lowering a `SUM` over a two-level correlated navigation, which is a lot of machinery to
     * lean on for an admin diagnostic. The catalog rows are a few thousand at most.
     */
    async function sqlServerStats(): Promise<Map<string, RuntimeStats>> {
        const tables = await view(SysTables)
            .map(t => ({ objectId: t.object_id, schema: t.schema().$v!.name, name: t.name }))
            .toArray();

        const partitions = await view(SysPartitions)
            .map(p => ({ objectId: p.object_id, indexId: p.index_id, partitionId: p.partition_id, rows: p.rows }))
            .toArray();

        const allocationUnits = await view(SysAllocationUnits)
            .map(a => ({ containerId: a.container_id, totalPages: a.total_pages }))
            .toArray();

        const pagesByContainer = new Map<number, number>();
        for (const a of allocationUnits)
            pagesByContainer.set(a.containerId, (pagesByContainer.get(a.containerId) ?? 0) + a.totalPages);

        const statsByObject = new Map<number, RuntimeStats>();
        for (const p of partitions) {
            const s = statsByObject.get(p.objectId) ?? { rows: 0, total_size_kb: 0 };
            // Rows come from the base rowset only — the HEAP (index_id 0) or the CLUSTERED index
            // (index_id 1); every nonclustered index repeats the same rows. Pages come from ALL of them,
            // because the indexes are part of what the table costs on disk.
            if (p.indexId <= CLUSTERED_INDEX)
                s.rows += p.rows;
            s.total_size_kb += (pagesByContainer.get(p.partitionId) ?? 0) * 8;
            statsByObject.set(p.objectId, s);
        }

        return new Map(tables
            .filter(t => statsByObject.has(t.objectId))
            .map(t => [objectKey(t.schema, t.name), statsByObject.get(t.objectId)!]));
    }

    /** `sys.indexes.type` / `sys.partitions.index_id` for a clustered index (Signum's DiffIndexType.Clustered). */
    const CLUSTERED_INDEX = 1;

    /** The same key the model's `ObjectName.toString()` produces, with the default schema normalised. */
    function objectKey(schemaName: string, name: string): string {
        const normalized = schemaName === "dbo" || schemaName === "public" ? "" : schemaName;
        return new ObjectName(name, new SchemaName(normalized, new DatabaseName(""))).toString();
    }

    // ---- authorization -------------------------------------------------------------------------

    /**
     * Signum's `Schema.Current.IsAllowed(type, inUserInterface: true) == null`, resolved to a Set because
     * altea's check is async (the same adaptation altea-omnibox's `allowedTypeFilter` makes). Permissive
     * when authorization is not started, so an unsecured host shows the whole schema.
     */
    async function allowedTypes(candidates: Type<Entity>[]): Promise<(ctor: Function) => boolean> {
        if (!TypeAuthLogic.isStarted())
            return () => true;

        const allowed = new Set<Function>();
        for (const ctor of candidates) {
            let typeId;
            try {
                typeId = TypeLogic.typeToId(ctor);
            } catch {
                continue; // not a persisted type (or the caches aren't loaded) — hide it
            }
            if (await TypeAuthLogic.isAllowedForType(typeId, TypeAllowedBasic.Read, true))
                allowed.add(ctor);
        }
        return ctor => allowed.has(ctor);
    }
}

