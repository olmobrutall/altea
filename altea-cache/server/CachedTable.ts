import type { Entity, PrimaryKey, Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { FieldInfo } from "@altea/altea/data/reflection";
import { ResetLazy } from "@altea/altea/data/resetLazy";
import type { CacheRetriever } from "@altea/altea/server/cache";
import { Connector } from "@altea/altea/server/connection/connector";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { baseTypeOfFieldInfo } from "@altea/altea/server/linq/expressions";
import { sqlEscape } from "@altea/altea/server/linq/sqlEscape";
import { denormalizeDecimal, denormalizeTemporal, denormalizeVector } from "@altea/altea/server/normalizeScalar";
import { LiteralType, TemporalType, VectorType } from "@altea/altea/server/runtimeTypes";
import type { IColumn } from "@altea/altea/server/schema/column";
import type { EntityField } from "@altea/altea/server/schema/field";
import {
    FieldEmbedded, FieldEntityArray, FieldEnum, FieldImplementedBy, FieldImplementedByAll,
    FieldPrimaryKey, FieldReference, FieldValue,
} from "@altea/altea/server/schema/field";
import { Schema } from "@altea/altea/server/schema/schema";
import type { Table } from "@altea/altea/server/schema/table";
import type { CustomLiteClass } from "@altea/altea/data/lite";
import { planLiteColumns, type LiteColumnsPlan } from "./LiteColumnsFinder";

// Port of Signum's CachedTableBase / CachedTable<T> / CachedTableConstructor (Signum.Caching). One entity
// type's rows held in memory as RAW COLUMN TUPLES plus a "completer" that fills a fresh entity instance
// from one tuple. Storing tuples rather than entities is the whole design: every read hands the caller a
// NEW instance, so mutating (or saving) what you got can never corrupt the cache.
//
// altea divergences from Signum, all consequences of altea's model rather than choices:
//  - Signum COMPILES the completer as a LINQ Expression tree; altea builds the equivalent tree of
//    CLOSURES. Same structure (one node per Field, recursing through embeddeds/mixins), no codegen.
//  - **No CachedTableMList.** altea has no MList table: a collection is `@part` child rows in the child's
//    own table with a back-reference FK — i.e. always Signum's *VirtualMList* shape — so a collection is
//    served by the CHILD type's own cached table through a back-reference index (Signum's
//    `GetBackReferenceDictionary` / `RequestByBackReference`).
//  - **The semi-cached lite table is trimmed the same way Signum's is, by a different route.** Signum's
//    ToStringColumnsFinderVisitor walks the lite MODEL expression for the columns it needs and
//    LiteModelExpressionVisitor rewrites that expression to read the cached tuple. altea's equivalent of a
//    lite model is a CUSTOM LITE, whose `fromEntity` is a `Quoted` lambda — a real JS function that also
//    carries its expression tree — so LiteColumnsFinder walks the tree for the column set and the function
//    itself is applied to a PARTIAL entity carrying exactly those columns. Same guarantee (only the display
//    columns of only the referenced rows), no expression rewriting.
//  - No SqlDependency: SQL Server query notifications (Service Broker) have no equivalent in the Node
//    driver, so a cached table is never invalidated by the database itself. Invalidation is this process's
//    save/DML events plus a broadcast from sibling processes — see CacheLogic and Broadcast/.

// One cached row: the raw column values, in the order of `CachedTable.columns`.
export type CachedRow = readonly unknown[];

// Signum's CachedTableBase: the statistics + sub-table bookkeeping every cached table shares.
export abstract class CachedTableBase {
    // Sub-tables (Signum's SubTables): the CachedTableLites this table's semi-cached lite references need.
    // They reset and load with their owner.
    readonly subTables: CachedTableBase[] = [];

    invalidations = 0;
    hits = 0;

    abstract get table(): Table;
    abstract get typeName(): string;
    abstract get count(): number | null;
    abstract get loads(): number;
    abstract get sumLoadTime(): number;

    protected abstract reset(): void;
    protected abstract loadCore(): Promise<void>;
    /** Zero the load counters this table delegates to its ResetLazy (the hits/invalidations above are its
     *  own). Split out because Signum keeps all four on CachedTableBase, altea two of them on the lazy. */
    protected abstract resetStats(): void;

    // Signum's ResetAll: drop this table's rows and its sub-tables'. `forceReset` also zeroes the
    // statistics (the panel's "Clear"); an ordinary invalidation counts up instead.
    resetAll(forceReset: boolean): void {
        this.reset();
        if (forceReset) {
            this.invalidations = 0;
            this.hits = 0;
            this.resetStats();
        } else {
            this.invalidations++;
        }
        for (const st of this.subTables)
            st.resetAll(forceReset);
    }

    // Signum's LoadAll: this table and every sub-table. Sub-tables load AFTER their owner — a
    // CachedTableLite is restricted by a JOIN back to it, so its owner must exist in the schema first.
    async loadAll(): Promise<void> {
        await this.loadCore();
        for (const st of this.subTables)
            await st.loadAll();
    }

    abstract get isLoaded(): boolean;
}

// A single field's contribution to materialising an entity: writes one member of `target` from `row`.
type FieldSetter = (row: CachedRow, retriever: CacheRetriever, target: any, ownerId: PrimaryKey) => void;

// Per-column read conversion — the same mapping the query projector applies (see
// translatorBuilder.visitColumn), derived from the owning field's reflected type so a cached
// `Temporal`/`Decimal`/`Vector`/`boolean` column materialises exactly as a queried one does.
function converterFor(fi: FieldInfo | undefined): (value: unknown) => unknown {
    if (fi == null)
        return v => v;
    const rt = baseTypeOfFieldInfo(fi);
    if (rt instanceof TemporalType)
        return v => denormalizeTemporal(v, rt.kind);
    if (rt instanceof VectorType)
        return v => denormalizeVector(v);
    if (rt === LiteralType.decimal)
        return v => denormalizeDecimal(v);
    if (rt === LiteralType.boolean)
        return v => v == null ? null : !!v;
    return v => v;
}

// The custom lite a `Lite<Target>` FIELD asks for, if any (Signum's `column.CustomLiteModelType`). A field
// may declare one per target type — a polymorphic `@implementedBy` lite has several — so it is a per-type
// lookup, exactly as the binder's fieldCustomLiteMap does it.
function customLiteOf(fi: FieldInfo, targetType: Type<Entity>): CustomLiteClass | undefined {
    for (const c of fi.customLite ?? [])
        if (c.forEntityType() === targetType)
            return c.liteClass() as CustomLiteClass;
    return undefined;
}

// A column that cannot (or need not) be cached. Signum's `ShouldBeCached` skips the Postgres tsvector
// column; altea also skips every generated column and the system-versioning period columns — none of them
// map to a field the completer would read, and a `tstzrange` has no JS materialisation here.
function shouldBeCached(column: IColumn): boolean {
    return column.computedColumn == null && column.systemVersion == null;
}

// How a cached table's rows are restricted. The ROOT of a cached graph loads its whole table; there is no
// other case: a semi-cached type gets a trimmed CachedTableLite instead, never a full table of its own.
export class CachedTable<T extends Entity> extends CachedTableBase {
    readonly table: Table;
    readonly columns: IColumn[];
    private readonly columnIndex = new Map<IColumn, number>();
    private readonly converters: ((value: unknown) => unknown)[];
    private readonly sql: string;
    private readonly rows: ResetLazy<Map<PrimaryKey, CachedRow>>;
    private setters: FieldSetter[] = [];
    private readonly pkIndex: number;
    // Signum's BackReferenceDictionaries: per back-reference FIELD, ownerId → the child ids pointing at it,
    // in `@rowOrder` order. Memoised off `rows` on first use and cleared with them (see backReferenceIds).
    private backReferences = new Map<string, Map<string, PrimaryKey[]>>();

    constructor(readonly type: Type<T>, readonly schema: Schema) {
        super();
        this.table = schema.table(type);
        this.columns = Object.values(this.table.columns).filter(shouldBeCached);
        this.columns.forEach((c, i) => this.columnIndex.set(c, i));
        this.converters = this.columns.map(() => (v: unknown) => v);
        this.pkIndex = this.columnIndex.get(this.table.primaryKey.column)!;

        // `SELECT c0, c1, … FROM <table>` with POSITIONAL aliases: the driver's row keys then can't be
        // mangled by the dialect's identifier case folding, and the reader is a plain index walk.
        const isPostgres = schema === Schema.current ? Connector.current().isPostgres : this.table.isPostgres;
        const select = this.columns.map((c, i) => `${sqlEscape(c.name, isPostgres)} AS c${i}`).join(", ");
        this.sql = `SELECT ${select} FROM ${this.table.name.toString()}`;

        this.rows = new ResetLazy<Map<PrimaryKey, CachedRow>>(() => this.executeLoad());
        this.rows.name = type.name;
    }

    // Second phase (Signum's CachedTableConstructor, run from CacheLogic once the WHOLE schema is
    // complete): build the per-field setters. Cannot happen in the constructor — a setter may need
    // another type's cached table, which may not exist yet.
    buildCompleter(): void {
        this.setters = [];
        for (const ef of Object.values(this.table.fields)) {
            if (ef.field instanceof FieldPrimaryKey)
                continue; // the id is already on the instance (the Retriever created it with one)
            const setter = this.setterFor(ef, "");
            if (setter != null)
                this.setters.push(setter);
        }
        // Mixin fields are addressed by their bare name — altea inlines them onto the owner (the same
        // convention the projector and `save` use), so they need no separate container.
        for (const mixin of Object.values(this.table.mixins))
            for (const ef of Object.values(mixin.fields)) {
                const setter = this.setterFor(ef, "");
                if (setter != null)
                    this.setters.push(setter);
            }
    }

    // ---- Completer construction (Signum's CachedTableConstructor.MaterializeField) ------------------

    private indexOf(column: IColumn): number {
        const index = this.columnIndex.get(column);
        if (index == null)
            throw new Error(`Column '${column.name}' of ${this.table.name.name} is not cached`);
        return index;
    }

    private valueSetter(ef: EntityField, column: IColumn): FieldSetter {
        const index = this.indexOf(column);
        this.converters[index] = converterFor(ef.fieldInfo);
        const name = ef.fieldInfo.name;
        const conv = this.converters[index];
        return (row, _r, target) => { target[name] = conv(row[index]); };
    }

    // A single-target reference (Signum's GetEntity): a full entity becomes a Retriever STUB — drained
    // afterwards from the target's own cache when it is cached, from the database when it isn't, exactly
    // like a query's non-expanded reference. A `Lite<T>` needs a display string, which only the target
    // type can produce: from its own cache when cached, else from a trimmed CachedTableLite (the semi case).
    private referenceSetter(ef: EntityField, column: IColumn, isLite: boolean, targetTable: Table): FieldSetter {
        const index = this.indexOf(column);
        const name = ef.fieldInfo.name;
        const targetType = targetTable.type as Type<Entity>;

        if (!isLite)
            return (row, retriever, target) => { target[name] = retriever.stub(targetType, row[index] as PrimaryKey | null); };

        const liteSource = this.liteSourceFor(targetType, column, ef.fieldInfo);
        return (row, retriever, target) => {
            const id = row[index] as PrimaryKey | null;
            target[name] = id == null ? null : liteSource(id, retriever);
        };
    }

    // Where a `Lite<Target>` on a cached row gets its display string from. Set up at completer-build time
    // (so the sub-table is registered before anything loads) and resolved per row.
    private liteSourceFor(targetType: Type<Entity>, column: IColumn, fi: FieldInfo): (id: PrimaryKey, retriever: CacheRetriever) => Lite<Entity> | null {
        // Resolved through CacheLogic so this module doesn't import it (CacheLogic owns the controllers and
        // imports THIS file). The FIELD's own `@customLite` (Signum's column.CustomLiteModelType) decides
        // WHICH lite shape is built, and therefore which columns the semi-cached table has to hold.
        return cachedLiteResolver!(targetType, column, this, customLiteOf(fi, targetType));
    }

    private setterFor(ef: EntityField, routePrefix: string): FieldSetter | undefined {
        const f = ef.field;
        const name = ef.fieldInfo.name;

        // FieldEnum / FieldTicks extend FieldReference / FieldValue — test the specific ones first.
        // An enum column holds the enum's underlying NUMBER, which is also what the field holds in
        // memory on the server (see the EnumSerializer: the wire carries the member name, the instance
        // the value), so it needs no conversion — exactly what the projector does.
        if (f instanceof FieldEnum)
            return this.valueSetter(ef, f.column);

        if (f instanceof FieldValue)
            return this.valueSetter(ef, f.column);

        if (f instanceof FieldReference)
            return this.referenceSetter(ef, f.column, f.column.isLite, f.column.referenceTable!);

        if (f instanceof FieldImplementedBy) {
            // One nullable FK column per implementation; at most one is non-null. Dispatched per row (the
            // projector does the same rather than emitting a SQL CASE).
            const cases = f.implementationColumns.map(col => ({
                index: this.indexOf(col),
                targetType: col.referenceTable!.type as Type<Entity>,
                lite: f.isLite,
                liteSource: f.isLite ? this.liteSourceFor(col.referenceTable!.type as Type<Entity>, col, ef.fieldInfo) : undefined,
            }));
            return (row, retriever, target) => {
                for (const c of cases) {
                    const id = row[c.index] as PrimaryKey | null;
                    if (id == null)
                        continue;
                    target[name] = c.lite ? c.liteSource!(id, retriever) : retriever.stub(c.targetType, id);
                    return;
                }
                target[name] = null;
            };
        }

        if (f instanceof FieldImplementedByAll) {
            // Id + TypeEntity discriminator. As in Signum, an @implementedByAll LITE gets NO display
            // string: its target can be any type, so there is nothing cached to read it from (the lite is
            // still navigable — it carries type + id).
            const idIndexes = f.idColumns.map(c => this.indexOf(c));
            const typeIndex = this.indexOf(f.typeColumn);
            const isLite = f.isLite;
            return (row, retriever, target) => {
                let id: PrimaryKey | null = null;
                for (const i of idIndexes)
                    if (row[i] != null) { id = row[i] as PrimaryKey; break; }
                const typeId = row[typeIndex] as PrimaryKey | null;
                target[name] = isLite
                    ? retriever.liteImplementedByAll(id, typeId, null)
                    : retriever.implementedByAll(id, typeId);
            };
        }

        if (f instanceof FieldEmbedded) {
            const ctor = ef.fieldInfo.getFunction() as Type<any> | undefined;
            if (ctor == null)
                throw new Error(`Cannot cache ${this.table.name.name}.${name}: the embedded type is not resolvable`);
            const hasValueIndex = f.hasValue == null ? undefined : this.indexOf(f.hasValue);
            const route = routePrefix === "" ? name : `${routePrefix}.${name}`;
            const inner: FieldSetter[] = [];
            for (const inf of Object.values(f.embeddedFields)) {
                const s = this.setterFor(inf, route);
                if (s != null)
                    inner.push(s);
            }
            // Signum's RegisterBinding at a route INSIDE the entity (altea's `embeddedRoutePositions` —
            // altea-files stamps each FilePathEmbedded with the owner + member it hangs off, so its
            // download can be addressed and gated). The query path folds this into the projection; the
            // cached path has to do it too, or a cached owner's file embedded loses its route.
            const routeCallback = this.schema.embeddedRoutePositions.get(ctor);
            const rootType = this.schema.typeToName.get(this.type as unknown as Type<Entity>)!;
            return (row, retriever, target, ownerId) => {
                if (hasValueIndex != null && row[hasValueIndex] !== true && row[hasValueIndex] !== 1) {
                    target[name] = null;
                    return;
                }
                const value = retriever.embedded(ctor, e => {
                    for (const s of inner)
                        s(row, retriever, e, ownerId);
                });
                if (routeCallback != null)
                    routeCallback(value, { rootType, entityId: ownerId, propertyRoute: route });
                target[name] = value;
            };
        }

        if (f instanceof FieldEntityArray) {
            // A `@part` collection: the child rows live in the child's own table, so they come from the
            // CHILD type's cached table through its back-reference index (Signum's VirtualMList handling —
            // `RequestByBackReference`). CacheLogic guarantees the child type is cached (it caches the
            // whole dependency closure), so this is always available.
            const childType = f.childType;
            const fkProperty = f.childFkProperty;
            return (_row, retriever, target, ownerId) => {
                target[name] = backReferenceResolver!(childType, fkProperty, ownerId, retriever);
            };
        }

        // FieldPrimaryKey is filtered by the caller; nothing else emits columns.
        return undefined;
    }

    // ---- Loading -----------------------------------------------------------------------------------

    private async executeLoad(): Promise<Map<PrimaryKey, CachedRow>> {
        // Global execution mode (the cache reads the WHOLE table, ungated) in an INDEPENDENT transaction,
        // so what lands in memory is committed state — the same contract as GlobalLazy.
        return await ExecutionMode.global(() => Transaction.forceNew(async () => {
            const raw = await Connector.current().executeQuery(this.sql) as Record<string, unknown>[];
            const result = new Map<PrimaryKey, CachedRow>();
            for (const r of raw) {
                const row = new Array<unknown>(this.columns.length);
                for (let i = 0; i < this.columns.length; i++)
                    row[i] = this.converters[i](r["c" + i]);
                result.set(row[this.pkIndex] as PrimaryKey, row);
            }
            return result;
        }));
    }

    protected loadCore(): Promise<void> {
        return this.rows.load();
    }

    protected reset(): void {
        this.rows.reset();
        this.backReferences = new Map();
    }

    protected resetStats(): void { this.rows.resetStats(); }

    get isLoaded(): boolean { return this.rows.isValueCreated; }
    get typeName(): string { return this.type.name; }
    get count(): number | null { return this.rows.valueOrUndefined?.size ?? null; }
    get loads(): number { return this.rows.loads; }
    get sumLoadTime(): number { return this.rows.sumLoadTime; }

    private loadedRows(): Map<PrimaryKey, CachedRow> {
        const rows = this.rows.valueOrUndefined;
        if (rows == null)
            throw new Error(`The cache of ${this.type.name} is not loaded: await controller.load() before reading it.`);
        return rows;
    }

    // ---- Reads (Signum's CachedTable members) ------------------------------------------------------

    exists(id: PrimaryKey): boolean {
        this.hits++;
        return this.loadedRows().has(id);
    }

    getAllIds(): PrimaryKey[] {
        this.hits++;
        return [...this.loadedRows().keys()];
    }

    complete(entity: T, retriever: CacheRetriever): void {
        this.hits++;
        const row = this.loadedRows().get(entity.id);
        if (row == null)
            throw new Error(`${this.type.name} ${entity.id} is not in the cache`);
        for (const s of this.setters)
            s(row, retriever, entity, entity.id);
    }

    // The DISTINCT non-null values of one FK column across the loaded rows — the exact id set a
    // semi-cached lite table has to fetch (altea's stand-in for Signum's INNER JOIN back to this table).
    referencedIds(column: IColumn): PrimaryKey[] {
        const index = this.indexOf(column);
        const set = new Set<PrimaryKey>();
        for (const row of this.loadedRows().values()) {
            const id = row[index] as PrimaryKey | null;
            if (id != null)
                set.add(id);
        }
        return [...set];
    }

    // Signum's GetBackReferenceDictionary: ownerId → child ids, in `@rowOrder` order (the order a
    // `@part` collection is retrieved in — see QueryBinder.fieldEntityArrayProjection). Keyed by
    // `String(ownerId)` so a numeric and a uuid PK behave the same.
    // NOTE it must be built SYNCHRONOUSLY, not through a ResetLazy: the caller is inside `complete()`,
    // filling an entity, and cannot await. A ResetLazy would only publish its value on a microtask — so the
    // FIRST entity materialised would silently get an EMPTY collection while every later one got the right
    // rows. The index needs no I/O anyway (the rows are already in memory), so it is a plain memoised field
    // dropped by `reset()`.
    backReferenceIds(fkProperty: string, ownerId: PrimaryKey): PrimaryKey[] {
        this.hits++;
        let index = this.backReferences.get(fkProperty);
        if (index == null)
            this.backReferences.set(fkProperty, index = this.buildBackReferenceIndex(fkProperty));
        return index.get(String(ownerId)) ?? [];
    }

    private buildBackReferenceIndex(fkProperty: string): Map<string, PrimaryKey[]> {
        const fkField = this.table.fields[fkProperty];
        if (fkField == null || !(fkField.field instanceof FieldReference))
            throw new Error(`${this.type.name} has no back-reference field '${fkProperty}'`);
        const fkIndex = this.indexOf(fkField.field.column);
        const orderField = Object.values(this.table.fields).find(ef => ef.fieldInfo.isRowOrder);
        const orderIndex = orderField?.field instanceof FieldValue ? this.indexOf(orderField.field.column) : undefined;

        const groups = new Map<string, CachedRow[]>();
        for (const row of this.loadedRows().values()) {
            const owner = row[fkIndex];
            if (owner == null)
                continue;
            const key = String(owner);
            const list = groups.get(key);
            if (list != null) list.push(row); else groups.set(key, [row]);
        }

        const result = new Map<string, PrimaryKey[]>();
        for (const [key, list] of groups) {
            if (orderIndex != null)
                list.sort((a, b) => Number(a[orderIndex] ?? 0) - Number(b[orderIndex] ?? 0));
            result.set(key, list.map(r => r[this.pkIndex] as PrimaryKey));
        }
        return result;
    }
}


// ---- Semi-cached lites (Signum's CachedTableLite) ----------------------------------------------------

// The `Lite<T>` of a NON-cached (Transactional) type referenced by a cached one — Signum's
// `CachedTableLite<T>`, and the reason it exists: a cached `Country` referencing `Lite<Person>` must NOT
// pull Person's rows into memory. Person is volatile and large, and caching its rows would drag in whatever
// Person itself references, transitively, until most of the database is in memory. So this table holds:
//
//   • only the ROWS actually referenced — an INNER JOIN back to the owner table does the restricting in
//     SQL (Signum's `lastPartialJoin`), so no id list is shipped and the owner need not be loaded first;
//   • only the COLUMNS the lite needs — the primary key plus whatever the display expression reads, found
//     by walking it (see LiteColumnsFinder, the ToStringColumnsFinderVisitor analogue).
//
// A lite is then built by filling a PARTIAL entity with exactly those columns and applying the type's own
// lite builder to it (`toLite()`, or a registered custom lite's `fromEntity`) — so the result is what a
// query would have produced, without a rewritten expression. When the display string comes from the ToStr
// column (a hand-written `toString()`), that instance's `toString` is overridden with the cached value,
// which is what Signum's LiteModelExpressionVisitor does by substituting the column into the expression.
export class CachedTableLite extends CachedTableBase {
    readonly table: Table;
    private readonly columns: IColumn[];
    private readonly converters: ((value: unknown) => unknown)[];
    private readonly fieldOfColumn: (string | undefined)[];
    private readonly pkIndex: number;
    private readonly sql: string;
    private readonly plan: LiteColumnsPlan;
    private readonly rows: ResetLazy<Map<string, CachedRow>>;

    constructor(
        readonly type: Type<Entity>,
        // The cached table this reference was found on, and the FK column inside its rows: together they
        // are the JOIN that restricts this table to the referenced rows.
        private readonly owner: CachedTable<any>,
        readonly column: IColumn,
        fieldCustomLite: CustomLiteClass | undefined,
        schema: Schema,
    ) {
        super();
        this.table = schema.table(type);
        this.plan = planLiteColumns(type, this.table, fieldCustomLite);

        const pk = this.table.primaryKey.column;
        this.columns = [pk, ...this.plan.columns.filter(c => c !== pk)];
        this.pkIndex = 0;
        // Each column's read conversion + the field it fills, resolved once. The ToStr column fills no
        // field (it becomes the toString override), hence the undefined slot.
        const fieldByColumn = new Map<IColumn, EntityField>();
        for (const ef of Object.values(this.table.fields))
            for (const c of ef.field.columns())
                fieldByColumn.set(c, ef);
        for (const mixin of Object.values(this.table.mixins))
            for (const ef of Object.values(mixin.fields))
                for (const c of ef.field.columns())
                    fieldByColumn.set(c, ef);

        this.converters = this.columns.map(c => converterFor(fieldByColumn.get(c)?.fieldInfo));
        this.fieldOfColumn = this.columns.map(c => fieldByColumn.get(c)?.fieldInfo.name);

        const isPostgres = this.table.isPostgres;
        const select = this.columns.map((c, i) => `lt.${sqlEscape(c.name, isPostgres)} AS c${i}`).join(", ");
        // INNER JOIN the OWNER on its FK: only rows some cached row points at (Signum's partial join).
        // Duplicates from the join collapse in the by-id map, exactly as Signum's `result[id] = obj` does.
        this.sql = `SELECT ${select} FROM ${this.table.name.toString()} lt` +
            ` INNER JOIN ${owner.table.name.toString()} ow ON ow.${sqlEscape(column.name, isPostgres)} = lt.${sqlEscape(pk.name, isPostgres)}`;

        this.rows = new ResetLazy<Map<string, CachedRow>>(() => this.executeLoad());
        this.rows.name = `Lite<${type.name}>`;
    }

    private async executeLoad(): Promise<Map<string, CachedRow>> {
        return await ExecutionMode.global(() => Transaction.forceNew(async () => {
            const raw = await Connector.current().executeQuery(this.sql) as Record<string, unknown>[];
            const result = new Map<string, CachedRow>();
            for (const r of raw) {
                const row = new Array<unknown>(this.columns.length);
                for (let i = 0; i < this.columns.length; i++)
                    row[i] = this.converters[i](r["c" + i]);
                result.set(String(row[this.pkIndex]), row);
            }
            return result;
        }));
    }

    getLite(id: PrimaryKey): Lite<Entity> | null {
        this.hits++;
        const rows = this.rows.valueOrUndefined;
        if (rows == null)
            throw new Error(`The lite cache of ${this.type.name} is not loaded: await controller.load() before reading it.`);
        const row = rows.get(String(id));
        if (row == null)
            return null;

        // A partial instance carrying ONLY the cached columns — enough for the lite builder, and never
        // handed out itself.
        const entity = new (this.type as unknown as new () => Entity)();
        (entity as { id: PrimaryKey }).id = id;
        entity.isNew = false;
        for (let i = 0; i < this.columns.length; i++) {
            const field = this.fieldOfColumn[i];
            if (field != null && this.columns[i] !== this.table.toStrColumn)
                (entity as unknown as Record<string, unknown>)[field] = row[i];
        }
        if (this.plan.usesToStrColumn) {
            const toStr = String(row[this.columns.indexOf(this.table.toStrColumn!)] ?? "");
            (entity as unknown as { toString: () => string }).toString = () => toStr;
        }
        return this.plan.build(entity);
    }

    protected loadCore(): Promise<void> { return this.rows.load(); }
    protected reset(): void { this.rows.reset(); }
    protected resetStats(): void { this.rows.resetStats(); }
    get isLoaded(): boolean { return this.rows.isValueCreated; }
    get typeName(): string { return `Lite<${this.type.name}>`; }
    get count(): number | null { return this.rows.valueOrUndefined?.size ?? null; }
    get loads(): number { return this.rows.loads; }
    get sumLoadTime(): number { return this.rows.sumLoadTime; }
    /** The columns actually held — shown by the statistics panel, since "which columns" is the point. */
    get cachedColumnNames(): string[] { return this.columns.map(c => c.name); }
}

// `CachedTable` needs two things only CacheLogic can answer (which type is cached, and which sub-table
// serves a semi-cached lite). They are installed as hooks rather than imported, so this module stays a
// leaf: CacheLogic imports it, never the other way round.
let cachedLiteResolver: ((targetType: Type<Entity>, column: IColumn, owner: CachedTable<any>, fieldCustomLite: CustomLiteClass | undefined) => (id: PrimaryKey, retriever: CacheRetriever) => Lite<Entity> | null) | undefined;
let backReferenceResolver: ((childType: Type<Entity>, fkProperty: string, ownerId: PrimaryKey, retriever: CacheRetriever) => Entity[]) | undefined;

export function installCachedTableHooks(hooks: {
    cachedLite: (targetType: Type<Entity>, column: IColumn, owner: CachedTable<any>, fieldCustomLite: CustomLiteClass | undefined) => (id: PrimaryKey, retriever: CacheRetriever) => Lite<Entity> | null,
    backReference: (childType: Type<Entity>, fkProperty: string, ownerId: PrimaryKey, retriever: CacheRetriever) => Entity[],
}): void {
    cachedLiteResolver = hooks.cachedLite;
    backReferenceResolver = hooks.backReference;
}
