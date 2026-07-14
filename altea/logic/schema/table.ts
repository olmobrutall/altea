import type { Quoted } from 'quote-transformer/quoted';
import type { Type, Entity } from '../../entities/entity';
import { ObjectName } from './objectName';
import { EntityField, FieldPrimaryKey, FieldTicks, FieldMixin } from './field';
import type { IColumn } from './column';
import { TableIndex, recordAccessedFields } from './tableIndex';
import { getIndexWhere } from './indexWhere';
import type { SystemVersionedInfo } from './systemVersioned';

// In-memory description of one entity's table. `fields` holds the reflected
// entity fields (incl. id/ticks); `columns` is the flattened physical layout
// built by generateColumns().
export class Table {
    name: ObjectName;
    fields: { [name: string]: EntityField } = {};
    mixins: { [typeName: string]: FieldMixin } = {};
    columns: { [name: string]: IColumn } = {};
    primaryKey!: FieldPrimaryKey;
    ticks?: FieldTicks;
    // True for a raw database view (Signum's ITable.IsView) built by ViewBuilder —
    // no ticks/toStr, raw column names, an explicit @viewPrimaryKey. Generation
    // (CREATE TABLE / FK / enum seeding) skips views.
    isView = false;
    // The dialect of the schema this table belongs to (set by SchemaBuilder from
    // settings.isPostgres). Needed at registration time to render a filtered index's WHERE
    // predicate to dialect-correct SQL in withIndex — the analogue of Signum's
    // Schema.Current.Settings.IsPostgres inside AddIndex.
    isPostgres = false;
    // Physical display-string column (Signum's `ToStr`), present only when the
    // entity's `toString()` is a hand-written method (not a `@quoted` expression the
    // query provider can translate). Written at save time = `entity.toString()`.
    toStrColumn?: IColumn;
    // The table's indexes (Signum's ITable.MultiColumnIndexes / GenerateAllIndexes): the
    // automatic FK indexes, the @index/@uniqueIndex ones, and any added via withIndex.
    indexes: TableIndex[] = [];
    // Set when the entity is @systemVersioned (Signum's ITable.SystemVersioned): the period
    // columns + history table describing the temporal versioning. Undefined for ordinary tables.
    systemVersioned?: SystemVersionedInfo;

    constructor(
        public readonly type: Type<Entity>,
        name: ObjectName,
    ) {
        this.name = name;
    }

    // Fluent index declaration (Signum's FluentInclude.WithIndex / WithUniqueIndex, whose
    // signature is `(fields, where?, includeFields?)`). `fields` reads the covered columns
    // (`e => e.code`, `e => [e.a, e.b]`); `where` is a filtered-index predicate captured by the
    // transformer (`e => e.active`); `includeFields` selects INCLUDE columns. Returns the table
    // for chaining.
    withIndex(fields: (element: any) => unknown, where?: Quoted<(element: any) => boolean>, includeFields?: (element: any) => unknown): Table {
        this.addFluentIndex(fields, false, where, includeFields);
        return this;
    }

    withUniqueIndex(fields: (element: any) => unknown, where?: Quoted<(element: any) => boolean>, includeFields?: (element: any) => unknown): Table {
        this.addFluentIndex(fields, true, where, includeFields);
        return this;
    }

    private addFluentIndex(fields: (element: any) => unknown, unique: boolean, where?: Quoted<(element: any) => boolean>, includeFields?: (element: any) => unknown): void {
        const columns = this.columnsFromFields(recordAccessedFields(fields));
        const includeColumns = includeFields == null ? undefined : this.columnsFromFields(recordAccessedFields(includeFields));
        // Render the predicate to SQL now (registration time), like Signum's AddIndex.
        const whereSql = where == null ? undefined : getIndexWhere(where, this, this.isPostgres);
        this.indexes.push(new TableIndex(this, columns, { unique, includeColumns, where: whereSql }));
    }

    // Resolves entity field names (own or mixin) to their physical columns.
    columnsFromFields(fieldNames: string[]): IColumn[] {
        return fieldNames.map(name => {
            const ef = this.fields[name] ?? this.findMixinField(name);
            if (ef == null)
                throw new Error(`Index on '${this.name.name}': no field '${name}' to index.`);
            return ef.field.columns();
        }).flat();
    }

    private findMixinField(name: string): EntityField | undefined {
        for (const mixin of Object.values(this.mixins))
            if (mixin.fields[name] != null)
                return mixin.fields[name];
        return undefined;
    }

    // Flattens every field's columns (plus mixins') into `columns`, failing on
    // duplicate column names — which surface naming-convention collisions early.
    generateColumns(): void {
        const columns: { [name: string]: IColumn } = {};

        const add = (col: IColumn): void => {
            if (columns[col.name] != null)
                throw new Error(`Duplicate column '${col.name}' in table '${this.name.name}'`);
            columns[col.name] = col;
        };

        for (const ef of Object.values(this.fields))
            for (const col of ef.field.columns())
                add(col);

        for (const mixin of Object.values(this.mixins))
            for (const col of mixin.columns())
                add(col);

        if (this.toStrColumn != null)
            add(this.toStrColumn);

        this.columns = columns;
    }
}

// The Table returned by SchemaBuilder.include<T>(), typed so its withIndex/withUniqueIndex
// selectors are strongly typed to the entity (Signum's FluentInclude<T>). It IS the Table
// (extends it), so the internal builder uses that still work.
export interface FluentTable<T> extends Table {
    withIndex(fields: (element: T) => unknown, where?: Quoted<(element: T) => boolean>, includeFields?: (element: T) => unknown): FluentTable<T>;
    withUniqueIndex(fields: (element: T) => unknown, where?: Quoted<(element: T) => boolean>, includeFields?: (element: T) => unknown): FluentTable<T>;
}
