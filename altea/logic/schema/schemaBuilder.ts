import { Entity, EmbeddedEntity, isGenericType, typeConstructor } from '../../entities/entity';
import type { Type } from '../../entities/entity';
import { MixinDeclarations } from '../../entities/mixinDeclarations';
import { getTypeInfo, resolveType, resolveEnum, enumNameOf, FieldInfo } from '../../entities/reflection';
import { AbstractDbType, IsNullable, defaultDbType, primaryKeyDbType } from './dbType';
import {
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
import { EnumEntity, isEnumEntityType, getBoundEnum } from '../../entities/enumEntity';
import { TypeEntity } from '../../entities/typeEntity';
import { TypeLogic } from '../typeLogic';

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
function rawTypeName(type: Type<Entity>): string {
    if (isGenericType(type)) {
        const enumObject = getBoundEnum(type);
        if (enumObject != null)
            return enumNameOf(enumObject) ?? 'UnknownEnum';
        return (type.genericType as { name: string }).name;
    }
    return (type as { name: string }).name;
}

// Logical, dialect-independent type name: strips the "Entity" suffix from each
// underscore-separated segment, so part entities named `<Owner>Entity_<Field>`
// (altea's MList replacement) become `<Owner>_<Field>` (e.g.
// AwardNominationEntity_Points -> "AwardNomination_Points"). Used for the type
// registry / serialization names and @implementedBy column names.
function cleanTypeName(type: Type<Entity>): string {
    return rawTypeName(type).split('_').map(s => s.replace(/Entity$/, '')).join('_');
}

// PascalCase -> snake_case (ported from Signum's NaturalLanguageTools.PascalToSnake).
function pascalToSnake(value: string): string {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase();
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

    tableName(type: Type<Entity>): string {
        return physicalTableName(type, this.isPostgres);
    }
}

// Walks reflected entity metadata to build an in-memory Schema (Tables →
// Columns). Mirrors Signum's SchemaBuilder, minus MList: collections are either
// entity back-references (FieldEntityArray, zero columns) or rejected.
export class SchemaBuilder {
    readonly schema = new Schema();

    constructor(public readonly settings: SchemaSettings = new SchemaSettings()) { }

    include<T extends Entity>(type: Type<T>): Table {
        const entityType = type as unknown as Type<Entity>;
        const existing = this.schema.tables.get(entityType);
        if (existing != null)
            return existing;

        const name = new ObjectName(this.settings.tableName(entityType), this.settings.schemaName);
        const table = new Table(entityType, name);

        // Register before completing so recursive / cyclic includes (self-FKs,
        // mutual references) resolve to this in-progress table.
        this.schema.tables.set(entityType, table);
        const clean = cleanTypeName(type);
        this.schema.typeToName.set(entityType, clean);
        this.schema.nameToType.set(clean, entityType);

        this.completeTable(table, type);
        return table;
    }

    // Validates cross-table back-references once every table is present. Call
    // after the final include().
    complete(): void {
        // The TypeEntity system table is always part of the schema (it backs the
        // type↔id mapping), even when no @implementedByAll field referenced it.
        this.include(TypeEntity as unknown as Type<Entity>);

        for (const table of this.schema.tables.values()) {
            for (const ef of Object.values(table.fields))
                if (ef.field instanceof FieldEntityArray)
                    this.validateEntityArray(table, ef.field, ef.fieldInfo);
            for (const mixin of Object.values(table.mixins))
                for (const ef of Object.values(mixin.fields))
                    if (ef.field instanceof FieldEntityArray)
                        this.validateEntityArray(table, ef.field, ef.fieldInfo);
        }

        // Assign each entity type its TypeEntity id, build the type↔id caches, and
        // register the row-seeding generation step (Signum's TypeLogic.Start).
        TypeLogic.start(this.schema);
    }

    private completeTable(table: Table, type: Type<Entity>): void {
        const typeInfo = getTypeInfo(typeConstructor(type));
        if (typeInfo == null)
            throw new Error(`Type '${rawTypeName(type)}' has no reflection metadata. Is it decorated with @entity?`);

        // EnumEntity<T> tables mirror Signum: a non-identity int PK (the row id is
        // the enum's underlying value, supplied at seed time) and no ticks column.
        // The TypeEntity system table is seeded the same way (deterministic ids
        // assigned by TypeLogic, [TicksColumn(false)] in Signum), so it shares the
        // non-identity-PK / no-ticks treatment.
        const isEnumEntity = isEnumEntityType(type);
        const isSeeded = isEnumEntity || typeConstructor(type) === TypeEntity;

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
        const pkColumn = new PrimaryKeyColumn('id', pkDbType, /* identity */ !isGuid && !isSeeded);
        if (isGuid)
            pkColumn.default = this.settings.isPostgres
                ? 'gen_random_uuid()'
                : (pkType === 'uuid7' ? 'NEWSEQUENTIALID()' : 'NEWID()');
        const pk = new FieldPrimaryKey(pkColumn);
        table.primaryKey = pk;
        table.fields['id'] = new EntityField(idInfo, pk, makeGetter('id'));

        if (!isSeeded) {
            const ticksInfo = typeInfo.fields['ticks'] ?? new FieldInfo('ticks');
            const ticks = new FieldTicks(new ValueColumn('ticks', this.settings.ticksDbType, IsNullable.No));
            table.ticks = ticks;
            table.fields['ticks'] = new EntityField(ticksInfo, ticks, makeGetter('ticks'));
        }

        const preName = NameSequence.void();
        for (const [name, fi] of Object.entries(typeInfo.fields)) {
            if (fi.ignore || RESERVED_FIELDS.has(name))
                continue;
            const field = this.generateField(table, fi, preName);
            table.fields[name] = new EntityField(fi, field, makeGetter(name));
        }

        for (const mixinCtor of MixinDeclarations.getMixins(type)) {
            const mixinInfo = getTypeInfo(mixinCtor);
            if (mixinInfo == null)
                continue;
            const mixinFields: { [name: string]: EntityField } = {};
            for (const [name, mfi] of Object.entries(mixinInfo.fields)) {
                if (mfi.ignore || RESERVED_FIELDS.has(name))
                    continue;
                const field = this.generateField(table, mfi, preName);
                mixinFields[name] = new EntityField(mfi, field, makeGetter(name));
            }
            table.mixins[(mixinCtor as { name: string }).name] = new FieldMixin(mixinFields);
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
            const proto = (typeConstructor(type) as { prototype?: any }).prototype;
            const toStr = proto?.toString;
            if (typeof toStr === "function" && toStr !== Object.prototype.toString && (toStr as { __quoted?: unknown }).__quoted == null)
                table.toStrColumn = new ValueColumn("toStr", defaultDbType("String", undefined)!, IsNullable.Yes);
        }

        table.generateColumns();
    }

    private generateField(table: Table, fi: FieldInfo, preName: NameSequence): Field {
        const isArray = fi.array === true;
        const isLite = fi.lite === true;
        // Prefer the @include thunk's constructor (captured by reference, so it's
        // import-safe and rename-proof); fall back to resolving the typeName via
        // the registry. undefined for value types and enums, which are classified
        // by name / the isEnum flag below.
        const elementType = this.resolveFieldType(fi);
        const nullable = fi.isNullable === true ? IsNullable.Yes : IsNullable.No;

        // Arrays — only `PartEntity[]` referenced with @include(() => Part) is
        // supported (Altea's MList replacement). The part entity marks its
        // back-pointing FK with a bare @backReference; we locate that field here.
        if (isArray) {
            if (!isEntityCtor(elementType))
                throw new Error(`Field '${fi.name}' on ${rawTypeName(table.type)}: collections of non-entity types are not supported (no MList). Model the collection as a part entity referenced with @include(() => Child).`);
            this.include(elementType);
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
                const idColumn = new ImplementedByAllIdColumn(preName.add(`${fi.name}Id`).toString(), this.settings.primaryKeyDbType);
                // The type discriminator is the target's TypeEntity int id, so the
                // column references the (auto-included) TypeEntity table.
                const typeTable = this.include(TypeEntity as unknown as Type<Entity>);
                const typeColumn = new ImplementedByAllTypeColumn(preName.add(`${fi.name}Type`).toString(), typeTable);
                return new FieldImplementedByAll(idColumn, typeColumn, isLite);
            }
            const columns = fi.implementations.types().map(implType => {
                const refTable = this.include(implType);
                const colName = preName.add(`${fi.name}_${cleanTypeName(implType)}Id`).toString();
                return new ImplementationColumn(colName, refTable, isLite);
            });
            return new FieldImplementedBy(columns, isLite);
        }

        // Single reference: Lite<T> or a bare entity type.
        if (isLite || isEntityCtor(elementType)) {
            if (!isEntityCtor(elementType))
                throw new Error(`Field '${fi.name}' on ${rawTypeName(table.type)}: Lite container without an entity element type.`);
            const refTable = this.include(elementType);
            const baseName = fi.fkPropertyName ?? `${fi.name}Id`;
            return new FieldReference(new ReferenceColumn(preName.add(baseName).toString(), refTable, nullable, isLite));
        }

        // Single embedded value object.
        if (isEmbeddedCtor(elementType))
            return this.generateEmbedded(table, fi, preName);

        // Enum: FK to the enum's EnumEntity<T> table (Signum's FieldEnum). The
        // enum becomes a real included entity (so it supports mixins / polymorphic
        // references); the column stores its underlying int value, referencing <Enum>(id).
        if (fi.isEnum) {
            const enumObject = resolveEnum(fi.typeName);
            if (enumObject == null)
                throw new Error(`Field '${fi.name}' on ${rawTypeName(table.type)}: enum '${fi.typeName}' is not registered. Enums declared in the same file as the entity are auto-registered; call registerEnum(${fi.typeName}) by hand for cross-file enums.`);
            const refTable = this.include(EnumEntity.typeFor(enumObject));
            const colName = fi.fkPropertyName ?? `${fi.name}Id`;
            return new FieldEnum(new ReferenceColumn(preName.add(colName).toString(), refTable, nullable, /* isLite */ false));
        }

        // JS Date is intentionally unsupported — use Temporal types instead.
        if (fi.typeName === 'Date')
            throw new Error(`Field '${fi.name}' on ${rawTypeName(table.type)}: JS Date is not supported. Use Temporal.PlainDateTime / PlainDate / Instant instead.`);

        // Scalar value.
        const dbType = this.resolveValueDbType(fi);
        if (dbType == null)
            throw new Error(`Field '${fi.name}' on ${rawTypeName(table.type)}: cannot determine a DB type for '${fi.typeName}'. If it is an entity/embedded, ensure its module is imported so it is registered.`);
        const column = new ValueColumn(preName.add(this.columnName(fi)).toString(), dbType, nullable, fi.columnOptions?.size, fi.columnOptions?.precision);
        return new FieldValue(column);
    }

    private generateEmbedded(table: Table, fi: FieldInfo, preName: NameSequence): FieldEmbedded {
        const embeddedType = this.resolveFieldType(fi);
        const typeInfo = embeddedType != null ? getTypeInfo(embeddedType) : undefined;
        if (typeInfo == null)
            throw new Error(`Embedded type '${fi.typeName}' (field '${fi.name}') has no reflection metadata.`);

        const embeddedPre = preName.add(this.columnName(fi));
        const hasValue = fi.isNullable === true
            ? new EmbeddedHasValueColumn(embeddedPre.add('hasValue').toString())
            : undefined;

        const embeddedFields: { [name: string]: EntityField } = {};
        for (const [name, efi] of Object.entries(typeInfo.fields)) {
            if (efi.ignore || RESERVED_FIELDS.has(name))
                continue;
            const field = this.generateField(table, efi, embeddedPre);
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

    // Resolves a field's referenced constructor: the @include thunk if present
    // (by reference — import-safe, rename-proof, no registration order), else the
    // typeName via the registry. A bare @include (`true`) carries no constructor
    // of its own — its types come from @implementedBy — so it falls through.
    private resolveFieldType(fi: FieldInfo): unknown {
        if (typeof fi.include === 'function') {
            const resolved = fi.include();
            return Array.isArray(resolved) ? resolved[0] : resolved;
        }
        return resolveType(fi.typeName);
    }

    private resolveValueDbType(fi: FieldInfo): AbstractDbType | undefined {
        const co = fi.columnOptions;
        if (co?.sqlDbType != null || co?.pgDbType != null)
            return new AbstractDbType(co.sqlDbType ?? co.pgDbType!, co.pgDbType ?? co.sqlDbType!);
        return defaultDbType(fi.typeName, fi.kind);
    }

    private columnName(fi: FieldInfo): string {
        return fi.columnOptions?.columnName ?? fi.name;
    }
}
