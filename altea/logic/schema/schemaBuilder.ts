import { Entity, EmbeddedEntity } from '../../entities/entity';
import type { EntityType } from '../../entities/entity';
import { MixinDeclarations } from '../../entities/mixinDeclarations';
import { getTypeInfo, resolveType, FieldInfo } from '../../entities/reflection';
import { AbstractDbType, IsNullable, defaultDbType } from './dbType';
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

// Entity base fields handled specially (id, ticks) or excluded from the schema.
const RESERVED_FIELDS = new Set(['id', 'ticks', 'isNew', '_snapshot']);

function isEntityCtor(t: unknown): t is EntityType {
    return typeof t === 'function' && (t === Entity || (t as { prototype?: unknown }).prototype instanceof Entity);
}

function isEmbeddedCtor(t: unknown): boolean {
    return typeof t === 'function' && (t as { prototype?: unknown }).prototype instanceof EmbeddedEntity;
}

function cleanTypeName(type: { name: string }): string {
    return type.name.replace(/Entity$/, '');
}

function makeGetter(name: string): (entity: any) => unknown {
    return (entity: any) => entity[name];
}

// Tunables for table/column generation. Sensible defaults; override per app.
export class SchemaSettings {
    schemaName: SchemaName = defaultSchemaName;
    primaryKeyDbType: AbstractDbType = new AbstractDbType('int', 'int4');
    ticksDbType: AbstractDbType = new AbstractDbType('bigint', 'int8');

    tableName(type: EntityType): string {
        return cleanTypeName(type);
    }
}

// Walks reflected entity metadata to build an in-memory Schema (Tables →
// Columns). Mirrors Signum's SchemaBuilder, minus MList: collections are either
// entity back-references (FieldEntityArray, zero columns) or rejected.
export class SchemaBuilder {
    readonly schema = new Schema();

    constructor(public readonly settings: SchemaSettings = new SchemaSettings()) { }

    include<T extends Entity>(type: new () => T): Table {
        const entityType = type as unknown as EntityType;
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
        for (const table of this.schema.tables.values())
            for (const ef of Object.values(table.fields))
                if (ef.field instanceof FieldEntityArray)
                    this.validateEntityArray(table, ef.field, ef.fieldInfo);
    }

    private completeTable(table: Table, type: new () => Entity): void {
        const typeInfo = getTypeInfo(type);
        if (typeInfo == null)
            throw new Error(`Type '${type.name}' has no reflection metadata. Is it decorated with @entity?`);

        // Primary key + ticks first, so FK columns can read the PK db type.
        const idInfo = typeInfo.fields['id'] ?? new FieldInfo('id');
        const pk = new FieldPrimaryKey(new PrimaryKeyColumn('id', this.settings.primaryKeyDbType, true));
        table.primaryKey = pk;
        table.fields['id'] = new EntityField(idInfo, pk, makeGetter('id'));

        const ticksInfo = typeInfo.fields['ticks'] ?? new FieldInfo('ticks');
        const ticks = new FieldTicks(new ValueColumn('ticks', this.settings.ticksDbType, IsNullable.No));
        table.ticks = ticks;
        table.fields['ticks'] = new EntityField(ticksInfo, ticks, makeGetter('ticks'));

        const preName = NameSequence.void();
        for (const [name, fi] of Object.entries(typeInfo.fields)) {
            if (fi.ignore || RESERVED_FIELDS.has(name))
                continue;
            const field = this.generateField(table, fi, preName);
            table.fields[name] = new EntityField(fi, field, makeGetter(name));
        }

        for (const mixinCtor of MixinDeclarations.getMixins(type)) {
            const mixinInfo = getTypeInfo(mixinCtor as new () => unknown);
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

        // Arrays — only `ChildEntity[]` with @backReference is supported.
        if (isArray) {
            if (!isEntityCtor(elementType))
                throw new Error(`Field '${fi.name}' on ${table.type.name}: collections of non-entity types are not supported (no MList). Model the collection as a child entity referenced with @backReference.`);
            if (fi.backReference == null)
                throw new Error(`Entity array '${fi.name}' on ${table.type.name} requires @backReference((c) => c.<fk>) naming the child's back-pointing FK property.`);
            this.include(elementType);
            return new FieldEntityArray(elementType, fi.backReference.childFkProperty, fi.backReference.cascade);
        }

        // Polymorphic references.
        if (fi.implementations != null) {
            if (fi.implementations.kind === 'implementedByAll') {
                const idColumn = new ImplementedByAllIdColumn(preName.add(`${fi.name}Id`).toString(), this.settings.primaryKeyDbType);
                const typeColumn = new ImplementedByAllTypeColumn(preName.add(`${fi.name}Type`).toString(), this.settings.primaryKeyDbType);
                return new FieldImplementedByAll(idColumn, typeColumn, isLite);
            }
            const columns = fi.implementations.types.map(implType => {
                const refTable = this.include(implType as EntityType);
                const colName = preName.add(`${fi.name}_${cleanTypeName(implType as { name: string })}Id`).toString();
                return new ImplementationColumn(colName, refTable, isLite);
            });
            return new FieldImplementedBy(columns, isLite);
        }

        // Single reference: Lite<T> or a bare entity type.
        if (isLite || isEntityCtor(elementType)) {
            if (!isEntityCtor(elementType))
                throw new Error(`Field '${fi.name}' on ${table.type.name}: Lite container without an entity element type.`);
            const refTable = this.include(elementType);
            const baseName = fi.fkPropertyName ?? `${fi.name}Id`;
            return new FieldReference(new ReferenceColumn(preName.add(baseName).toString(), refTable, nullable, isLite));
        }

        // Single embedded value object.
        if (isEmbeddedCtor(elementType))
            return this.generateEmbedded(table, fi, preName);

        // Enum stored inline (no enum side table yet).
        if (fi.isEnum) {
            const dbType = this.resolveValueDbType(fi) ?? new AbstractDbType('nvarchar', 'varchar');
            const column = new ValueColumn(preName.add(this.columnName(fi)).toString(), dbType, nullable, fi.columnOptions?.size, fi.columnOptions?.precision);
            return new FieldEnum(column);
        }

        // Scalar value.
        const dbType = this.resolveValueDbType(fi);
        if (dbType == null)
            throw new Error(`Field '${fi.name}' on ${table.type.name}: cannot determine a DB type for '${fi.typeName}'. If it is an entity/embedded, ensure its module is imported so it is registered.`);
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
            embeddedFields[name] = new EntityField(efi, field, makeGetter(name));
        }
        return new FieldEmbedded(hasValue, embeddedFields);
    }

    private validateEntityArray(parentTable: Table, field: FieldEntityArray, fi: FieldInfo): void {
        const childTable = this.schema.tables.get(field.childType);
        if (childTable == null)
            throw new Error(`Entity array '${fi.name}' on ${parentTable.type.name}: child type ${field.childType.name} is not included in the schema.`);

        const childFk = childTable.fields[field.childFkProperty];
        if (childFk == null)
            throw new Error(`@backReference '${fi.name}' on ${parentTable.type.name}: child ${field.childType.name} has no property '${field.childFkProperty}'.`);

        const cf = childFk.field;
        if (!(cf instanceof FieldReference) || cf.column.referenceTable !== parentTable)
            throw new Error(`@backReference '${fi.name}' on ${parentTable.type.name}: child property '${field.childFkProperty}' must be a reference back to ${parentTable.type.name}.`);
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
