import { Entity, EmbeddedEntity } from '../../data/entity';
import type { Type, View, ViewType } from '../../data/entity';
import type { Quoted } from 'quote-transformer/quoted';
import { MixinDeclarations } from '../../data/mixinDeclarations';
import type { EntityData } from '../../data/decorators';
import { getTypeInfo, enumNameOf, FieldInfo, TypeInfo, schemaForName, type PrimaryKeyType } from '../../data/reflection';
import { AbstractDbType, IsNullable, defaultDbType, primaryKeyDbType } from './dbType';
import {
    type IColumn,
    PrimaryKeyColumn,
    ValueColumn,
    ReferenceColumn,
    ImplementationColumn,
    ImplementedByAllIdColumn,
    ImplementedByAllTypeColumn,
    EmbeddedHasValueColumn,
} from './column';
import {
    Field,
    FieldPrimaryKey,
    FieldTicks,
    FieldValue,
    FieldEnum,
    FieldReference,
    FieldImplementedBy,
    FieldImplementedByAll,
    FieldEmbedded,
    FieldMixin,
    FieldEntityArray,
    EntityField,
} from './field';
import { NameSequence } from './nameSequence';
import { ObjectName, SchemaName, defaultSchemaName } from './objectName';
import { Schema } from './schema';
import { Table } from './table';
import { FluentInclude } from './fluentInclude';
import { SystemVersionedInfo } from './systemVersioned';
import { TableIndex, FullTextTableIndex, VectorTableIndex } from './tableIndex';
import { accessedFields } from '../../data/accessedFields';
import { getIndexWhere } from './indexWhere';
import { EnumEntity, isEnumEntityType, getBoundEnum } from '../../data/enumEntity';
import { TypeEntity } from '../../data/typeEntity';
import { ResetLazy } from '../../data/resetLazy';
import { ExecutionMode } from '../executionMode';
import { Transaction } from '../connection/transaction';
import { TypeLogic } from '../typeLogic';
import type { WebBuilder } from '../webApi';

// Entity base fields handled specially (id, ticks) or excluded from the schema.
const RESERVED_FIELDS = new Set(['id', 'ticks', 'isNew', '_snapshot']);

function isEntityCtor(t: unknown): t is Type<Entity> {
    return typeof t === 'function' && (t === Entity || (t as { prototype?: unknown }).prototype instanceof Entity);
}

function isEmbeddedCtor(t: unknown): boolean {
    return typeof t === 'function' && (t as { prototype?: unknown }).prototype instanceof EmbeddedEntity;
}

// The raw type name of a type reference. For a closed generic, EnumEntity<Sex> →
// "Sex" (mirrors Signum's EnumEntity.Extract — the table is named after the enum);
// other generics fall back to the open class name.
function rawTypeName(type: Type<Entity> | ViewType<View>): string {
    const enumObject = getBoundEnum(type);
    if (enumObject != null)
        return enumNameOf(enumObject) ?? 'UnknownEnum';
    return (type as { name: string }).name;
}

// Logical, dialect-independent type name: strips the "Entity" suffix from each
// underscore-separated segment, so part entities named `<Owner>Entity_<Field>`
// (altea's MList replacement) become `<Owner>_<Field>` (e.g.
// AwardNominationEntity_Points -> "AwardNomination_Points"). Used for the type
// registry / serialization names and @implementedBy column names.
function cleanTypeName(type: Type<Entity> | ViewType<View>): string {
    return rawTypeName(type).split('_').map(s => s.replace(/Entity$/, '')).join('_');
}

// PascalCase -> snake_case (ported from Signum's NaturalLanguageTools.PascalToSnake).
function pascalToSnake(value: string): string {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase();
}

// Capitalise the first letter — turns altea's camelCase field name into the PascalCase
// segment Signum builds column names from (`sex` → `Sex`, `bonusTrack` → `BonusTrack`).
function cap(value: string): string {
    return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

// Physical table name (mirrors Signum's GenerateTableName, adapted). SQL Server
// keeps the PascalCase clean name (segments joined by "_"): AwardNomination_Points.
// Postgres snake-cases each segment and joins them with a DOUBLE underscore, so
// the owner/part boundary stays legible against the single underscores inside a
// snaked segment: award_nomination__points.
function physicalTableName(type: Type<Entity>, isPostgres: boolean): string {
    const clean = cleanTypeName(type);
    return isPostgres ? clean.split('_').map(pascalToSnake).join('__') : clean;
}

function makeGetter(name: string): (entity: any) => unknown {
    return (entity: any) => entity[name];
}

// Width of the enum table's `name` column.
const ENUM_NAME_SIZE = 100;

// Tunables for table/column generation. Sensible defaults; override per app.
export class SchemaSettings {
    schemaName: SchemaName = defaultSchemaName;
    primaryKeyDbType: AbstractDbType = new AbstractDbType('int', 'int4');
    ticksDbType: AbstractDbType = new AbstractDbType('bigint', 'int8');
    // Drives dialect-specific physical naming (snake_case for Postgres). Set from
    // the bound connector before the schema is built.
    isPostgres = false;

    // Signum's ImplementedByAllPrimaryKeyTypes: an @implementedByAll reference gets one id
    // column per entry (named `<Field>ID_<name>`), since its target can be any entity and
    // entities may have different PK types. `pkType` links each column to the entity PK
    // type it serves. (Signum defaults to {int}; the test schema uses all three.)
    implementedByAllPrimaryKeyTypes: { pkType: PrimaryKeyType, name: string, dbType: AbstractDbType }[] = [
        { pkType: 'int', name: 'Int32', dbType: new AbstractDbType('int', 'int4') },
        { pkType: 'long', name: 'Int64', dbType: new AbstractDbType('bigint', 'int8') },
        { pkType: 'uuid', name: 'Guid', dbType: new AbstractDbType('uniqueidentifier', 'uuid') },
    ];

    tableName(type: Type<Entity>): string {
        return physicalTableName(type, this.isPostgres);
    }

    // The schema a type's table lands in. Defaults to `schemaName` (the connection's current schema),
    // but a type covered by a `setDefaultDatabaseSchema(...)` declaration uses that — folder-scoped, so a
    // whole package (or a sub-folder within it) groups into one schema without annotating each entity.
    // `@tableName` still overrides the full object name for individual types (views, temp tables).
    //
    // Enum tables: `EnumEntity.typeFor(x)` is an ANONYMOUS class (`type.name === ""`), so resolving by
    // `type.name` would never match a scope — and must NOT fall back to EnumEntity's own file (which lives
    // in @altea/altea/data). Instead resolve by the ENUM's registered name (e.g. "OrderState"), so the enum
    // lands in the schema of the package it is DEFINED in, exactly like the table name is derived.
    schemaForType(type: Type<Entity>): SchemaName {
        const enumObject = getBoundEnum(type);
        const name = enumObject != null ? (enumNameOf(enumObject) ?? type.name) : type.name;
        const schema = schemaForName(name);
        return schema ? new SchemaName(schema, this.schemaName.database) : this.schemaName;
    }
}

// Walks reflected entity metadata to build an in-memory Schema (Tables →
// Columns). Mirrors Signum's SchemaBuilder, minus MList: collections are either
// entity back-references (FieldEntityArray, zero columns) or rejected.
export class SchemaBuilder {
    readonly schema = new Schema();

    // Signum's SchemaBuilder.NotDefined guard (Include.cs), inverted to read naturally as an early-return:
    // a logic's `start(sb)` opens with `if (sb.alreadyDefined(start)) return;` so re-including the module is
    // idempotent (its generate/sync/initialize hooks are pushed exactly once). The key is any stable token —
    // the start function itself is the obvious choice. Returns false + registers the key on first call.
    private readonly definedKeys = new Set<unknown>();
    alreadyDefined(key: unknown): boolean {
        if (this.definedKeys.has(key))
            return true;
        this.definedKeys.add(key);
        return false;
    }

    // Signum's `sb.GlobalLazy(factory, new InvalidateWith(typeof(X), …))`: a process-wide cache reset
    // whenever any `invalidateWith` type CHANGES (saved, deleted, or mutated by set-based DML). altea's
    // ResetLazy is ASYNC (no sync DB), so this returns a `ResetLazy<T>` holding the RESOLVED value —
    // concurrent readers share one in-flight load and `reset()` drops it (the next read re-invokes the
    // factory). Read it via `await lazy.value()`.
    globalLazy<T>(factory: () => Promise<T>, options: { invalidateWith: Type<Entity>[] }): ResetLazy<T> {
        // Signum's GlobalLazy runs the factory inside `ExecutionMode.Global()` (reads the whole database
        // ungated — authorization suppressed) AND its own INDEPENDENT transaction (`Transaction.forceNew` —
        // a fresh committed transaction regardless of the caller's context, never a no-op nesting). This
        // closes the "Transaction not started" window where a load fires from a just-committed ambient txn,
        // and means the cache always reflects COMMITTED state (Signum's model: caches reload post-commit,
        // never mid-write). The `globalLazyReadUncommitted` test toggle swaps in `Transaction.create` so a
        // reload NESTS in the ambient (rolled-back) txn and sees a test's uncommitted writes — read at
        // factory-run time so a suite can flip it after the schema is built.
        const schema = this.schema;
        const lazy = new ResetLazy<T>(() => ExecutionMode.global(() =>
            (schema.globalLazyReadUncommitted ? Transaction.create : Transaction.forceNew)(factory)));
        // Mirror Signum's SchemaBuilder.AttachInvalidations<T>: reset on save AND on every set-based DML
        // path — DELETE (Query.executeDelete → onPreUnsafeDelete), UPDATE, INSERT, and bulk-insert. Without
        // the delete hook, deleting a row via the operation/`Database.deleteList` path (which routes through
        // `executeDelete`, firing `preUnsafeDelete` only — never `saved`) would leave the cache stale until
        // the process restarts. altea divergences from Signum: (1) we hook `saved` (post-write, in-txn)
        // rather than Signum's graph-modified `Saving`; (2) the reset is EAGER (Signum defers it to
        // `Transaction.PostRealCommit`) — safe here because the factory reloads from committed state via
        // `Transaction.forceNew`, so a rolled-back change just triggers a harmless extra reload; (3) the
        // dependent-table fan-out (Signum's AttachInvalidationsDependant over `DependentTables()`) is not
        // ported — a cache that navigates to related types must list those types in `invalidateWith`.
        const reset = (): void => lazy.reset();
        for (const t of options.invalidateWith) {
            const ee = this.schema.entityEvents(t);
            ee.saved.push(reset);
            ee.preUnsafeDelete.push(reset);
            ee.preUnsafeUpdate.push(reset);
            ee.preUnsafeInsert.push(reset);
            ee.preBulkInsert.push(reset);
        }
        return lazy;
    }

    // The typed Express wrapper that *Server modules register their HTTP API on (Signum's
    // SchemaBuilder.WebServerBuilder). NULLABLE + initialized FROM THE OUTSIDE: a web host
    // (Southwind.Server-style) assigns it (`sb.webBuilder = new WebBuilder(express())`); a terminal /
    // CLI / test build (Southwind.Terminal-style) leaves it undefined. So each logic guards:
    //   if (sb.webBuilder) OrderServer.start(sb.webBuilder);
    webBuilder?: WebBuilder;

    constructor(public readonly settings: SchemaSettings = new SchemaSettings()) {
        // Signum calls TypeLogic.Start first thing in the Starter — the type↔id caches are foundational and
        // every other module's Schema.Initializing handler depends on them. altea does it here, at schema
        // construction, so TypeLogic.load is registered on `schema.initializing` BEFORE any module's start()
        // pushes its own hook (TypeLogic.start asserts the list is empty). The caches are lazy, so this needs
        // no included tables yet.
        TypeLogic.start(this.schema);
    }

    // `inheritedData` is set only on the recursive includes SchemaBuilder issues while completing a
    // table (see generateField): a "Part" whose @entity omitted EntityData inherits it from the FIRST
    // entity that includes it. The public/root include leaves it undefined. Because an already-included
    // table short-circuits at the top, "first includer wins" falls out naturally.
    include<T extends Entity>(type: Type<T>, inheritedData?: EntityData): FluentInclude<T> {
        const entityType = type as unknown as Type<Entity>;
        const existing = this.schema.tables.get(entityType);
        if (existing != null)
            return new FluentInclude<T>(existing, type, this);

        const name = new ObjectName(this.settings.tableName(entityType), this.settings.schemaForType(entityType));
        const table = new Table(entityType, name);
        // Carry the dialect so withIndex can render a filtered predicate to SQL at registration.
        table.isPostgres = this.settings.isPostgres;

        // Register before completing so recursive / cyclic includes (self-FKs,
        // mutual references) resolve to this in-progress table.
        this.schema.tables.set(entityType, table);
        const clean = cleanTypeName(type);
        this.schema.typeToName.set(entityType, clean);
        this.schema.nameToType.set(clean, entityType);

        // Part EntityData inheritance — set BEFORE completeTable so this Part's own sub-parts inherit it
        // transitively when generateField recurses into them below.
        const ti = getTypeInfo(type);
        if (ti != null && ti.entityData == null && ti.entityKind === "Part" && inheritedData != null)
            ti.entityData = inheritedData;

        this.completeTable(table, type);
        return new FluentInclude<T>(table, type, this);
    }

    // Validates cross-table back-references once every table is present. Call
    // after the final include().
    complete(): void {
        // The TypeEntity system table is always part of the schema (it backs the
        // type↔id mapping), even when no @implementedByAll field referenced it.
        this.include(TypeEntity as unknown as Type<Entity>);

        // Collected so one build reports EVERY unclassified entity at once, not just the first.
        const missingKind: string[] = [];
        const missingData: string[] = [];
        for (const table of this.schema.tables.values()) {
            for (const ef of Object.values(table.fields))
                if (ef.field instanceof FieldEntityArray)
                    this.validateEntityArray(table, ef.field, ef.fieldInfo);
            for (const mixin of Object.values(table.mixins))
                for (const ef of Object.values(mixin.fields))
                    if (ef.field instanceof FieldEntityArray)
                        this.validateEntityArray(table, ef.field, ef.fieldInfo);

            // Every schema entity must be classified via @entity(kind, data): @reflect is only for
            // ModelEntity / View / mixins / embeddeds, never a real table. Framework-seeded tables (the
            // enum tables + every @entity("SystemString") — TypeEntity and the symbol tables) are managed
            // internally and exempt.
            const ti = getTypeInfo(table.type);
            const isSeeded = isEnumEntityType(table.type) || ti?.entityKind === "SystemString";
            if (!isSeeded) {
                if (ti?.entityKind == null)
                    missingKind.push(cleanTypeName(table.type));
                // EntityData: explicit for most kinds; a "Part" may instead inherit it from the first
                // entity that includes it (done in include()). Undetermined means neither happened.
                else if (ti.entityData == null)
                    missingData.push(cleanTypeName(table.type));
            }
        }
        if (missingKind.length > 0)
            throw new Error(`Schema entities without an EntityKind: ${missingKind.join(', ')}. A schema entity must be decorated @entity(kind, data); @reflect is only for ModelEntity / View / mixins / embeddeds.`);
        if (missingData.length > 0)
            throw new Error(`Schema entities without an EntityData: ${missingData.join(', ')}. Pass it to @entity(kind, data); a "Part" may inherit it from the first entity that includes it, but none did here.`);

        // TypeLogic.start (type↔id caches + row-seeding generate/sync steps + the Schema.Initializing load
        // hook) already ran in the constructor — foundational, so it precedes every module's initializing
        // hook (Signum calls TypeLogic.Start first). Nothing type-id-related is deferred to complete().
    }

    private completeTable(table: Table, type: Type<Entity>): void {
        const typeInfo = getTypeInfo(type);
        if (typeInfo == null)
            throw new Error(`Type '${rawTypeName(type)}' has no reflection metadata. Is it decorated with @entity?`);

        // EnumEntity<T> tables mirror Signum: a non-identity int PK (the row id is
        // the enum's underlying value, supplied at seed time) and no ticks column.
        // The TypeEntity system table shares the seeded treatment for ticks/ToStr
        // (Signum's [TicksColumn(false)]) but NOT for the PK — see isIdentity below.
        const isEnumEntity = isEnumEntityType(type);
        // Seeded tables (framework-managed, not user CRUD): every @entity("SystemString") — the symbol
        // tables (OperationSymbol, …) + TypeEntity — plus the enum tables (an intrinsic base with no
        // per-type decorator). They get no ticks / ToStr column.
        const isSeeded = isEnumEntity || typeInfo.entityKind === "SystemString";
        // Externally-supplied (non-identity) ids: the enum tables (id = the enum value) and any @entity
        // declared `{ identity: false }` (Signum's [PrimaryKey(IdentityBehaviour=false)] — the Symbols,
        // whose ids SymbolLogic assigns/seeds). TypeEntity keeps a real identity PK (generation inserts
        // without ids; TypeLogic.load reads them back), so it does NOT set identity:false.
        const isExternalId = isEnumEntity || typeInfo.identity === false;

        // Primary key + ticks first, so FK columns can read the PK db type.
        const idInfo = typeInfo.fields['id'] ?? new FieldInfo('id');
        const pkType = idInfo.columnOptions?.primaryKey;
        const pkDbType = pkType != null ? primaryKeyDbType(pkType) : this.settings.primaryKeyDbType;
        // Mirrors PrimaryKeyAttribute: Identity (DB auto-increment) applies to
        // integer keys only — GUID keys are never IDENTITY (it is invalid DDL),
        // and enum tables carry externally-supplied ids (also non-identity).
        // IdentityBehaviour (the DB generates the key) is on by default; for a
        // GUID key that means a DB-side default generator rather than IDENTITY:
        // gen_random_uuid() on Postgres, NEWID()/NEWSEQUENTIALID() (uuid7) on SQL
        // Server. The default key type is int.
        const isGuid = pkType === 'uuid' || pkType === 'uuid7';
        const pkColumn = new PrimaryKeyColumn(this.colName('ID'), pkDbType, /* identity */ !isGuid && !isExternalId);
        if (isGuid)
            pkColumn.default = this.settings.isPostgres
                ? 'gen_random_uuid()'
                : (pkType === 'uuid7' ? 'NEWSEQUENTIALID()' : 'NEWID()');
        const pk = new FieldPrimaryKey(pkColumn);
        table.primaryKey = pk;
        table.fields['id'] = new EntityField(idInfo, pk, makeGetter('id'));

        if (!isSeeded) {
            const ticksInfo = typeInfo.fields['ticks'] ?? new FieldInfo('ticks');
            const ticks = new FieldTicks(new ValueColumn(this.colName('Ticks'), this.settings.ticksDbType, IsNullable.No));
            table.ticks = ticks;
            table.fields['ticks'] = new EntityField(ticksInfo, ticks, makeGetter('ticks'));
        }

        const preName = NameSequence.void();
        for (const [name, fi] of Object.entries(typeInfo.fields)) {
            if (fi.notMapped || RESERVED_FIELDS.has(name))
                continue;
            const field = this.generateField(table, fi, preName);
            field.avoidExpandOnRetrieving = fi.avoidExpandOnRetrieving === true;
            table.fields[name] = new EntityField(fi, field, makeGetter(name));
        }

        for (const mixinCtor of MixinDeclarations.getMixins(type)) {
            const mixinInfo = getTypeInfo(mixinCtor);
            if (mixinInfo == null)
                continue;
            const mixinFields: { [name: string]: EntityField } = {};
            for (const [name, mfi] of Object.entries(mixinInfo.fields)) {
                if (mfi.notMapped || RESERVED_FIELDS.has(name))
                    continue;
                const field = this.generateField(table, mfi, preName);
                field.avoidExpandOnRetrieving = mfi.avoidExpandOnRetrieving === true;
                mixinFields[name] = new EntityField(mfi, field, makeGetter(name));
            }
            table.mixins[(mixinCtor as { name: string }).name] = new FieldMixin(mixinFields, mixinCtor as Type<Entity>);
        }

        // EnumEntity's `name` column carries an explicit width (Signum's
        // ToStringColumn); the reflected field alone has no size.
        if (isEnumEntity) {
            const nameField = table.fields['name'];
            if (nameField?.field instanceof FieldValue)
                nameField.field.column.size = ENUM_NAME_SIZE;
        }

        // ToStr column (Signum's `ToStr`): a physical display-string column when the
        // entity has a hand-written `toString()` (own prototype) that is NOT a
        // `@quoted` expression — i.e. one the query provider can't translate to SQL,
        // so it is materialised at save time. A `@quoted` toString is expanded inline
        // in queries instead and needs no column. Enum tables use their `name` column;
        // the TypeEntity system table keeps the inherited default (no ToStr column).
        if (!isSeeded) {
            // Resolve toString up the prototype chain (finds an override, or Entity's
            // inherited `@quoted` default). A hand-written, non-`@quoted` toString needs
            // a stored ToStr column; a `@quoted` one (incl. the inherited default) is
            // expanded inline by the query provider, so no column.
            const proto = (type as { prototype?: any }).prototype;
            const toStr = proto?.toString;
            if (typeof toStr === "function" && toStr !== Object.prototype.toString && (toStr as Quoted<Function>).__quoted == null)
                table.toStrColumn = new ValueColumn(this.colName("ToStr"), defaultDbType("String", undefined)!, IsNullable.Yes);
        }

        table.generateColumns();
        this.applySystemVersioning(table, typeInfo);
        this.generateIndexes(table, typeInfo);
    }

    // @systemVersioned (Signum's [SystemVersioned]): attach the dialect-specific
    // SystemVersionedInfo and add the period columns to the physical layout. SQL Server keeps
    // a start/end datetime2 pair (GENERATED ALWAYS AS ROW START/END HIDDEN); Postgres a single
    // sys_period tstzrange. The history table (default `<Table>History`) is auto-created by SQL
    // Server via SYSTEM_VERSIONING, or by `CREATE TABLE … (LIKE …)` + a versioning trigger on PG.
    private applySystemVersioning(table: Table, typeInfo: TypeInfo): void {
        const cfg = typeInfo.systemVersioned;
        if (cfg == null)
            return;
        // Default history table name: snake `<table>_history` on Postgres, `<Table>History` on
        // SQL Server — each unquoted-clean in its dialect (overridable via the decorator).
        const defaultHistory = table.name.name + (this.settings.isPostgres ? '_history' : 'History');
        const historyName = new ObjectName(cfg.historyTableName ?? defaultHistory, table.name.schema);
        const sv = this.settings.isPostgres
            ? SystemVersionedInfo.postgres(historyName, cfg.sysPeriodColumnName ?? this.colName('SysPeriod'))
            : SystemVersionedInfo.sqlServer(historyName,
                cfg.startColumnName ?? this.colName('SysStartDate'),
                cfg.endColumnName ?? this.colName('SysEndDate'));
        table.systemVersioned = sv;
        for (const col of sv.columns())
            table.columns[col.name] = col;
    }

    // Builds the table's indexes (Signum's Table.GenerateAllIndexes): an automatic non-unique
    // index on every foreign-key column, the field-level @index / @uniqueIndex, and the
    // class-level composite @index / @uniqueIndex(e => …) lambdas. Enum/system tables have no
    // FK columns, so they pick up nothing unless explicitly indexed.
    private generateIndexes(table: Table, typeInfo: TypeInfo): void {
        const addFieldIndexes = (fi: FieldInfo, columns: IColumn[]): void => {
            if (fi.uniqueIndex)
                table.indexes.push(new TableIndex(table, columns, { unique: true }));
            else if (fi.index)
                table.indexes.push(new TableIndex(table, columns));
            else
                // Default: a non-unique index per foreign-key column (Signum's
                // FieldReference.GenerateIndexes) — one index each, so an @implementedBy's
                // implementation columns are indexed individually.
                for (const col of columns)
                    if (col.referenceTable != null && !col.avoidForeignKey)
                        table.indexes.push(new TableIndex(table, [col]));
        };

        for (const ef of Object.values(table.fields))
            if (!(ef.field instanceof FieldPrimaryKey))
                addFieldIndexes(ef.fieldInfo, ef.field.columns());
        for (const mixin of Object.values(table.mixins))
            for (const ef of Object.values(mixin.fields))
                addFieldIndexes(ef.fieldInfo, ef.field.columns());

        // Class-level composite indexes: read the covered fields off each stored @quoted selector's
        // AST (accessedFields), then resolve to columns.
        for (const desc of typeInfo.indexes ?? []) {
            const columns = table.columnsFromFields(accessedFields(desc.fields));
            const includeColumns = desc.includeFields == null ? undefined : table.columnsFromFields(accessedFields(desc.includeFields));
            // Render the class-level filtered predicate to SQL now (Quoted → Expression → string).
            const whereSql = desc.where == null ? undefined : getIndexWhere(desc.where, table, this.settings.isPostgres);
            table.indexes.push(new TableIndex(table, columns, { unique: desc.unique, includeColumns, where: whereSql }));
        }

        // Class-level full-text indexes (Signum's SchemaBuilder.AddFullTextIndex): resolve the
        // selector to its string columns, build the FullTextTableIndex, and — on Postgres — append
        // its generated tsvector column to the table's physical layout so the DDL emits it. Mark the
        // covered fields with hasFullTextIndex (Signum's Schema.HasFullTextIndex → MemberInfo flag).
        for (const desc of typeInfo.fullTextIndexes ?? []) {
            const fieldNames = accessedFields(desc.fields);
            const columns = table.columnsFromFields(fieldNames);
            const index = new FullTextTableIndex(table, columns, { sqlServer: desc.sqlServer, postgres: desc.postgres });
            table.indexes.push(index);
            for (const col of index.generateColumns(this.settings.isPostgres))
                table.columns[col.name] = col;
            // (FieldInfo.hasFullTextIndex is set by the @fullTextIndex decorator, isomorphically.)
        }

        // Class-level vector indexes (Signum's SchemaBuilder.AddVectorIndex): one vector column per
        // index, resolved from the single-field selector.
        for (const desc of typeInfo.vectorIndexes ?? []) {
            const [column] = table.columnsFromFields(accessedFields(desc.field));
            table.indexes.push(new VectorTableIndex(table, column, { sqlServer: desc.sqlServer, postgres: desc.postgres }));
        }
    }

    private generateField(table: Table, fi: FieldInfo, preName: NameSequence): Field {
        const isArray = fi.array === true;
        const isLite = fi.lite === true;
        // The field's referenced entity/embedded constructor, resolved by reference via
        // the transformer's `type` thunk (import-safe, rename-proof). undefined for value
        // types and enums, which are classified by name / the isEnum flag below.
        const elementType = this.resolveFieldType(fi);
        // @forceNullable → a nullable COLUMN for a non-null field (Signum's IsNullable.Forced).
        const nullable = fi.forceNullable ? IsNullable.Forced : fi.isNullable === true ? IsNullable.Yes : IsNullable.No;

        // The owner's (already-resolved) EntityData, propagated to any referenced Part below so a Part
        // with no explicit EntityData inherits it from the first entity that includes it (owned arrays,
        // polymorphic @implementedBy part references, and single 1-1 part references alike).
        const ownerData = getTypeInfo(table.type)?.entityData;

        // Arrays — only `PartEntity[]` is supported (Altea's MList replacement). The part
        // entity marks its back-pointing FK with a bare @backReference; we locate it here.
        if (isArray) {
            if (!isEntityCtor(elementType))
                throw new Error(`Field '${fi.name}' on ${rawTypeName(table.type)}: collections of non-entity types are not supported (no MList). Model the collection as a part entity (a PartEntity[] field).`);
            this.include(elementType, ownerData);
            const childInfo = getTypeInfo(elementType as object);
            const fkEntry = childInfo == null
                ? undefined
                : Object.entries(childInfo.fields).find(([, f]) => f.isBackReference);
            if (fkEntry == null)
                throw new Error(`Part entity ${(elementType as Function).name} (array '${fi.name}' on ${rawTypeName(table.type)}) must mark its owner FK with @backReference.`);
            return new FieldEntityArray(elementType, fkEntry[0], true);
        }

        // Polymorphic references.
        if (fi.implementations != null) {
            if (fi.implementations.kind === 'implementedByAll') {
                // One id column per configured PK type: `<Field>ID_<Int32|Int64|Guid>`.
                const idColumns = this.settings.implementedByAllPrimaryKeyTypes.map(t =>
                    new ImplementedByAllIdColumn(this.colName(preName.add(`${cap(fi.name)}ID_${t.name}`).toString()), t.dbType, t.pkType));
                // The type discriminator is the target's TypeEntity int id, so the
                // column references the (auto-included) TypeEntity table.
                const typeTable = this.include(TypeEntity as unknown as Type<Entity>).table;
                const typeColumn = new ImplementedByAllTypeColumn(this.colName(preName.add(`${cap(fi.name)}ID_Type`).toString()), typeTable);
                return new FieldImplementedByAll(idColumns, typeColumn, isLite);
            }
            const columns = fi.implementations.types().map(implType => {
                const refTable = this.include(implType, ownerData).table;
                const colName = this.colName(preName.add(`${cap(fi.name)}ID_${cleanTypeName(implType)}`).toString());
                return new ImplementationColumn(colName, refTable, isLite);
            });
            return new FieldImplementedBy(columns, isLite);
        }

        // Single reference: Lite<T> or a bare entity type.
        if (isLite || isEntityCtor(elementType)) {
            if (!isEntityCtor(elementType))
                throw new Error(`Field '${fi.name}' on ${rawTypeName(table.type)}: Lite container without an entity element type.`);
            const refTable = this.include(elementType, ownerData).table;
            const baseName = fi.fkPropertyName ?? this.colName(preName.add(`${cap(fi.name)}ID`).toString());
            return new FieldReference(new ReferenceColumn(baseName, refTable, nullable, isLite));
        }

        // Single embedded value object.
        if (isEmbeddedCtor(elementType))
            return this.generateEmbedded(table, fi, preName);

        // Enum: FK to the enum's EnumEntity<T> table (Signum's FieldEnum). The
        // enum becomes a real included entity (so it supports mixins / polymorphic
        // references); the column stores its underlying int value, referencing <Enum>(id).
        if (fi.isEnum) {
            const enumObject = fi.getEnum();
            if (enumObject == null)
                throw new Error(`Field '${fi.name}' on ${rawTypeName(table.type)}: enum '${fi.getTypeName() ?? fi.name}' is not registered. Enums declared in the same file as the entity are auto-registered; call registerEnum(...) by hand for cross-file enums.`);
            const refTable = this.include(EnumEntity.typeFor(enumObject)).table;
            const colName = fi.fkPropertyName ?? this.colName(preName.add(`${cap(fi.name)}ID`).toString());
            return new FieldEnum(new ReferenceColumn(colName, refTable, nullable, /* isLite */ false));
        }

        // JS Date is intentionally unsupported — use Temporal types instead.
        if (fi.typeName === 'Date')
            throw new Error(`Field '${fi.name}' on ${rawTypeName(table.type)}: JS Date is not supported. Use Temporal.PlainDateTime / PlainDate / Instant instead.`);

        // Scalar value.
        const dbType = this.resolveValueDbType(fi);
        if (dbType == null)
            throw new Error(`Field '${fi.name}' on ${rawTypeName(table.type)}: cannot determine a DB type for '${fi.typeName}'. If it is an entity/embedded, ensure its module is imported so it is registered.`);
        // A decimal/numeric column defaults to Signum's money shape numeric(18,2) when @column
        // gives no explicit precision/scale — otherwise a bare `numeric` would store 0 decimals.
        const isDecimal = dbType.isDecimal();
        const precision = fi.columnOptions?.precision ?? (isDecimal ? 18 : undefined);
        const scale = fi.columnOptions?.scale ?? (isDecimal ? 2 : undefined);
        const column = new ValueColumn(this.colName(preName.add(this.columnName(fi)).toString()), dbType, nullable, fi.columnOptions?.size, precision, scale);
        return new FieldValue(column);
    }

    private generateEmbedded(table: Table, fi: FieldInfo, preName: NameSequence): FieldEmbedded {
        const embeddedType = this.resolveFieldType(fi);
        const typeInfo = embeddedType != null ? getTypeInfo(embeddedType) : undefined;
        if (typeInfo == null)
            throw new Error(`Embedded type '${fi.getTypeName() ?? fi.name}' (field '${fi.name}') has no reflection metadata.`);

        const embeddedPre = preName.add(this.columnName(fi));
        const hasValue = fi.isNullable === true
            ? new EmbeddedHasValueColumn(this.colName(embeddedPre.add('HasValue').toString()))
            : undefined;

        const embeddedFields: { [name: string]: EntityField } = {};
        for (const [name, efi] of Object.entries(typeInfo.fields)) {
            if (efi.notMapped || RESERVED_FIELDS.has(name))
                continue;
            const field = this.generateField(table, efi, embeddedPre);
            field.avoidExpandOnRetrieving = efi.avoidExpandOnRetrieving === true;
            // A nullable embedded can be entirely absent, so every flattened
            // sub-column must be nullable regardless of the sub-field's own
            // nullability — presence is tracked by the hasValue column.
            if (hasValue != null)
                for (const col of field.columns())
                    (col as { nullable: IsNullable }).nullable = IsNullable.Yes;
            embeddedFields[name] = new EntityField(efi, field, makeGetter(name));
        }
        return new FieldEmbedded(hasValue, embeddedFields);
    }

    private validateEntityArray(parentTable: Table, field: FieldEntityArray, fi: FieldInfo): void {
        const childTable = this.schema.tables.get(field.childType);
        if (childTable == null)
            throw new Error(`Entity array '${fi.name}' on ${rawTypeName(parentTable.type)}: child type ${rawTypeName(field.childType)} is not included in the schema.`);

        const childFk = childTable.fields[field.childFkProperty];
        if (childFk == null)
            throw new Error(`@backReference '${fi.name}' on ${rawTypeName(parentTable.type)}: child ${rawTypeName(field.childType)} has no property '${field.childFkProperty}'.`);

        const cf = childFk.field;
        if (!(cf instanceof FieldReference) || cf.column.referenceTable !== parentTable)
            throw new Error(`@backReference '${fi.name}' on ${rawTypeName(parentTable.type)}: child property '${field.childFkProperty}' must be a reference back to ${rawTypeName(parentTable.type)}.`);
    }

    // Resolves a field's referenced entity/embedded constructor via the transformer-emitted
    // `type` thunk (captured by reference — import-safe, rename-proof, no registration
    // order), falling back to the name registry for hand-written metadata. undefined for
    // value/enum fields and @implementedBy interface references (handled by their branches).
    private resolveFieldType(fi: FieldInfo): unknown {
        return fi.getFunction();
    }

    private resolveValueDbType(fi: FieldInfo): AbstractDbType | undefined {
        const co = fi.columnOptions;
        if (co?.sqlDbType != null || co?.pgDbType != null)
            return new AbstractDbType(co.sqlDbType ?? co.pgDbType!, co.pgDbType ?? co.sqlDbType!);
        return defaultDbType(fi.typeName, fi.subTypeName);
    }

    private columnName(fi: FieldInfo): string {
        return fi.columnOptions?.columnName ?? cap(fi.name);
    }

    // Final physical column name for the given logical (PascalCase) name: Signum uses the
    // PascalCase form verbatim on SQL Server and snake_cases it on Postgres, so both
    // dialects match Signum (`SexID` / `sex_id`, `AuthorID_Artist` / `author_id_artist`).
    private colName(logical: string): string {
        return this.settings.isPostgres ? pascalToSnake(logical) : logical;
    }
}
