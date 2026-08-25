import type { Entity, Type, View, ViewType } from '../../data/entity';
import { getTypeInfo, FieldInfo, type TypeInfo } from '../../data/reflection';
import { AbstractDbType, IsNullable, defaultDbType } from './dbType';
import { PrimaryKeyColumn, ValueColumn, ReferenceColumn } from './column';
import { FieldValue, FieldReference, FieldPrimaryKey, EntityField, Field } from './field';
import { ObjectName, SchemaName, DatabaseName } from './objectName';
import { Table } from './table';
import type { Schema } from './schema';

// Port of Signum's ViewBuilder (Engine/Schema/SchemaBuilder/SchemaBuilder.cs). Builds the
// in-memory Table for a raw database view. A view class is declared with `@reflect` (the
// reflection/@field trigger, standing in for Signum's `: IView`), `@tableName("schema.name")`
// (Signum's [TableName]), and `@viewPrimaryKey` fields (Signum's [ViewPrimaryKey]).
//
// Unlike SchemaBuilder.include: NO naming convention (column name = field name verbatim),
// NO id/ticks/toStr conventions, and the primary key comes from @viewPrimaryKey rather than
// a synthetic `id`. Views are queried, never generated, so DDL/enum steps skip them.
//
// Scope: catalog views map only scalar columns and navigate via @quoted sub-queries
// (view(X).filter(...)), never FK columns — so view fields are FieldValue. Array columns
// (pg int[]/short[]/byte[]) are a later milestone; entity/embedded view fields are rejected
// until a reader needs them.
export class ViewBuilder {
    // The schema is needed to resolve FK view columns (a temp-table view's Lite<T>
    // reference) to the target entity's already-built Table. Catalog views (scalar
    // columns only) never touch it, so it stays optional for those.
    constructor(protected readonly schema?: Schema) { }

    /**
     * The object name a view class maps to — its `@tableName`, parsed. Takes the whole TypeInfo (not just
     * the declared string) so an override can key on the view CLASS and its fields, not only on the name it
     * happens to declare. Signum's counterpart is SchemaBuilder.GenerateTableName.
     *
     * OVERRIDE POINT: a schema bound to a FOREIGN database (one altea neither generates nor synchronizes)
     * may spell the same tables differently, and a subclass installed on that schema's `viewBuilder` remaps
     * them without a second set of view classes. See eastwind's NorthwindPostgresViewBuilder, which reads a
     * PascalCase `dbo.X` declaration off a snake_case `public.x` pg_dump. `newView` has already checked that
     * `typeInfo.tableName` is set.
     */
    protected tableName(typeInfo: TypeInfo): ObjectName {
        return parseViewName(typeInfo.tableName!);
    }

    /**
     * The column a scalar view field reads — the FIELD NAME verbatim (no naming convention, unlike an
     * entity's SchemaBuilder). OVERRIDE POINT, paired with {@link tableName}; Signum's counterpart is
     * SchemaBuilder.GenerateFieldName. The owning view is reachable as `fi.declaringType`, so this needs no
     * second parameter.
     *
     * NOT applied to a temp-table view's FK column, which follows altea's own `<Field>ID` convention: a temp
     * table is CREATED by altea, so its names are altea's and there is nothing foreign to remap.
     */
    protected columnName(fi: FieldInfo): string {
        return fi.name;
    }

    newView<V extends View>(type: ViewType<V>): Table {
        const ctor = type;
        const typeInfo = getTypeInfo(ctor);
        if (typeInfo == null)
            throw new Error(`View '${ctor.name}' has no reflection metadata. Decorate it with @reflect.`);
        if (typeInfo.tableName == null)
            throw new Error(`View '${ctor.name}' has no mapped name. Add @tableName("pg_catalog.pg_namespace") (the raw view name).`);

        // A SQL Server temp-table view (Signum's Administrator.CreateTemporaryTable target):
        // its [TableName] starts with '#'. Unlike a catalog view it maps FK columns and needs
        // no @viewPrimaryKey (its rows are projected/inserted directly, never dedup'd).
        const isTempTable = typeInfo.tableName.startsWith('#');

        const table = new Table(type, this.tableName(typeInfo));
        table.isView = true;

        let pkFieldInfo: FieldInfo | undefined;
        let pkColumn: ValueColumn | ReferenceColumn | undefined;

        for (const [name, fi] of Object.entries(typeInfo.fields)) {
            if (fi.notMapped)
                continue;
            const field = this.generateViewField(ctor, fi, isTempTable);
            table.fields[name] = new EntityField(fi, field, (e: any) => e[name]);

            const firstCol = field.columns()[0];
            // Signum's [ViewPrimaryKey]. The first such column is the representative PK
            // (the EntityExpression's externalId). It stays a regular binding so `view.oid`
            // resolves as an ordinary column; table.primaryKey references the same column but
            // is NOT added to `fields` (so generateColumns doesn't duplicate it). A temp-table
            // view has no @viewPrimaryKey, so its first column stands in as the representative.
            if ((fi.viewPrimaryKey || (isTempTable && pkFieldInfo == null)) && pkFieldInfo == null && firstCol != null) {
                pkFieldInfo = fi;
                pkColumn = firstCol as ValueColumn | ReferenceColumn;
            }
        }

        if (pkColumn == null)
            throw new Error(`View '${ctor.name}' has no @viewPrimaryKey field. Mark the primary-key column(s) with @viewPrimaryKey.`);

        // Representative primary key: a PrimaryKeyColumn mirroring the @viewPrimaryKey column
        // (same name + db type, never identity). Divergence from Signum, which supports a
        // genuinely composite view PK — altea's Table.primaryKey is single-column, so a
        // composite view uses its first @viewPrimaryKey column as the representative id. That id
        // can repeat across rows (a junction like EmployeeTerritories), so view rows are NEVER
        // routed through the retriever's identity map — each projected row is its own instance
        // (see Retriever.viewRow / translatorBuilder.visitEntity). Deduping by the representative
        // id would otherwise return the first row's object for every sibling and drop columns.
        // The representative PK is NOT a physical column of the table (it aliases an existing
        // one), so the readers that project it drop it as unused; the CREATE TABLE for a temp
        // view therefore omits the synthetic PK constraint (see sqlBuilder.createTableSql).
        table.primaryKey = new FieldPrimaryKey(new PrimaryKeyColumn(pkColumn.name, pkColumn.dbType, /* identity */ false));

        table.generateColumns();
        return table;
    }

    private generateViewField(ctor: Function, fi: FieldInfo, isTempTable: boolean): Field {
        // A temp-table view maps a real FK column (Signum's temp views hold Lite<T>
        // references, e.g. MyTempView.Artist). Reuse the entity reference-field shape so
        // binding `b.artist` yields a lite reference, exactly like an entity FK.
        if (isTempTable && (fi.lite === true || (fi.implementations == null && this.resolveEntityRef(fi) != null))) {
            if (fi.implementations != null || fi.isEnum || fi.array)
                throw new Error(`Temp-table view field '${fi.name}' on ${ctor.name}: only scalar and single Lite<T>/entity FK columns are supported.`);
            const refTable = this.resolveEntityRef(fi);
            if (refTable == null)
                throw new Error(`Temp-table view field '${fi.name}' on ${ctor.name}: cannot resolve referenced entity '${fi.getTypeName() ?? fi.name}'. Ensure its module is imported and the schema is complete.`);
            const nullable = fi.isNullable === true ? IsNullable.Yes : IsNullable.No;
            // Column name follows the entity FK convention: `<Field>ID` (PascalCase field + "ID"), or the
            // verbatim `@column({columnName})` if the field declares one.
            const colName = fi.columnOptions?.columnName ?? `${cap(fi.name)}ID`;
            return new FieldReference(new ReferenceColumn(colName, refTable, nullable, /* isLite */ fi.lite === true));
        }

        if (fi.implementations != null || fi.getFunction() != null || fi.isEnum)
            throw new Error(`View field '${fi.name}' on ${ctor.name}: entity/enum view columns are not supported (views navigate via @quoted sub-queries, not FK columns).`);

        let dbType = this.resolveViewDbType(fi);
        if (dbType == null)
            throw new Error(`View field '${fi.name}' on ${ctor.name}: cannot determine a DB type for '${fi.typeName}'.`);

        const nullable = fi.isNullable === true ? IsNullable.Yes : IsNullable.No;
        // A primitive array view column (e.g. a catalog `int2[]` like pg_constraint.conkey).
        // The db type becomes the array form and the column is flagged `collection`; the pg
        // driver parses the array value into a JS array on read. (Views are read-only, so no
        // DDL/diff needs the exact array element type.)
        if (fi.array)
            dbType = new AbstractDbType(dbType.sqlServer + "[]", dbType.postgres + "[]");

        // Column name = field name verbatim (raw catalog column, no PascalCase/snake_case), unless a
        // subclass remaps it — see `columnName`.
        const column = new ValueColumn(this.columnName(fi), dbType, nullable, fi.columnOptions?.size, fi.columnOptions?.precision);
        if (fi.array)
            column.collection = true;
        return new FieldValue(column);
    }

    private resolveViewDbType(fi: FieldInfo): AbstractDbType | undefined {
        const co = fi.columnOptions;
        if (co?.sqlDbType != null || co?.pgDbType != null)
            return new AbstractDbType(co.sqlDbType ?? co.pgDbType!, co.pgDbType ?? co.sqlDbType!);
        return defaultDbType(fi.typeName, fi.subTypeName);
    }

    // Resolves a temp-view FK field's referenced entity Table from the (completed) schema,
    // or undefined when the field isn't an entity reference / can't be resolved.
    private resolveEntityRef(fi: FieldInfo): Table | undefined {
        if (this.schema == null)
            return undefined;
        const refCtor = fi.getFunction();
        if (refCtor == null)
            return undefined;
        return this.schema.tryTable(refCtor as Type<Entity>);
    }
}

// PascalCase first letter, matching the entity SchemaBuilder's FK column naming (`<Field>ID`).
function cap(s: string): string {
    return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// Parse a raw view name ("pg_catalog.pg_namespace" / "sys.tables" / "MyView") into an
// ObjectName. Faithful to Signum's ObjectName.Parse, scoped to schema.name (no database
// qualifier — altea is single-database).
function parseViewName(name: string): ObjectName {
    const parts = name.split('.');
    if (parts.length === 1)
        return new ObjectName(parts[0], new SchemaName('', new DatabaseName('')));
    const table = parts[parts.length - 1];
    const schema = parts[parts.length - 2];
    return new ObjectName(table, new SchemaName(schema, new DatabaseName('')));
}
