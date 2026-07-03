import type { Entity, Type } from '../../entities/entity';
import { typeConstructor } from '../../entities/entity';
import { getTypeInfo, FieldInfo } from '../../entities/reflection';
import { AbstractDbType, IsNullable, defaultDbType } from './dbType';
import { PrimaryKeyColumn, ValueColumn } from './column';
import { FieldValue, FieldPrimaryKey, EntityField } from './field';
import { ObjectName, SchemaName, DatabaseName } from './objectName';
import { Table } from './table';

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
    newView(type: Type<Entity>): Table {
        const ctor = typeConstructor(type);
        const typeInfo = getTypeInfo(ctor);
        if (typeInfo == null)
            throw new Error(`View '${ctor.name}' has no reflection metadata. Decorate it with @reflect.`);
        if (typeInfo.tableName == null)
            throw new Error(`View '${ctor.name}' has no mapped name. Add @tableName("pg_catalog.pg_namespace") (the raw view name).`);

        const table = new Table(type, parseViewName(typeInfo.tableName));
        table.isView = true;

        let pkFieldInfo: FieldInfo | undefined;
        let pkColumn: ValueColumn | undefined;

        for (const [name, fi] of Object.entries(typeInfo.fields)) {
            if (fi.ignore)
                continue;
            const field = this.generateViewField(ctor, fi);
            table.fields[name] = new EntityField(fi, field, (e: any) => e[name]);

            // Signum's [ViewPrimaryKey]. The first such column is the representative PK
            // (the EntityExpression's externalId). It stays a regular FieldValue binding so
            // `view.oid` resolves as an ordinary column; table.primaryKey references the same
            // column but is NOT added to `fields` (so generateColumns doesn't duplicate it).
            if (fi.viewPrimaryKey && pkFieldInfo == null) {
                pkFieldInfo = fi;
                pkColumn = field.column;
            }
        }

        if (pkColumn == null)
            throw new Error(`View '${ctor.name}' has no @viewPrimaryKey field. Mark the primary-key column(s) with @viewPrimaryKey.`);

        // Representative primary key: a PrimaryKeyColumn mirroring the @viewPrimaryKey column
        // (same name + db type, never identity). Divergence from Signum, which supports a
        // genuinely composite view PK — altea's Table.primaryKey is single-column, so a
        // composite view uses its first @viewPrimaryKey column as the representative id (the
        // readers project columns directly and never dedup view rows, so this is sufficient).
        table.primaryKey = new FieldPrimaryKey(new PrimaryKeyColumn(pkColumn.name, pkColumn.dbType, /* identity */ false));

        table.generateColumns();
        return table;
    }

    private generateViewField(ctor: Function, fi: FieldInfo): FieldValue {
        if (fi.array)
            throw new Error(`View field '${fi.name}' on ${ctor.name}: array/collection view columns are not supported yet.`);
        if (fi.implementations != null || fi.include != null || fi.isEnum)
            throw new Error(`View field '${fi.name}' on ${ctor.name}: entity/enum view columns are not supported (views navigate via @quoted sub-queries, not FK columns).`);

        const dbType = this.resolveViewDbType(fi);
        if (dbType == null)
            throw new Error(`View field '${fi.name}' on ${ctor.name}: cannot determine a DB type for '${fi.typeName}'.`);

        const nullable = fi.isNullable === true ? IsNullable.Yes : IsNullable.No;
        // Column name = field name verbatim (raw catalog column, no PascalCase/snake_case).
        return new FieldValue(new ValueColumn(fi.name, dbType, nullable, fi.columnOptions?.size, fi.columnOptions?.precision));
    }

    private resolveViewDbType(fi: FieldInfo): AbstractDbType | undefined {
        const co = fi.columnOptions;
        if (co?.sqlDbType != null || co?.pgDbType != null)
            return new AbstractDbType(co.sqlDbType ?? co.pgDbType!, co.pgDbType ?? co.sqlDbType!);
        return defaultDbType(fi.typeName, fi.kind);
    }
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
