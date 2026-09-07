import type { Quoted } from 'quote-transformer/quoted';
import type { Type, Entity, View, ViewType } from '../../data/entity';
import { ObjectName } from './objectName';
import { EntityField, FieldPrimaryKey, FieldTicks, FieldMixin, FieldEmbedded } from './field';
import type { IColumn } from './column';
import type { IndexBlock } from './tableIndex';
import { TableIndex, multiUniqueIndexes } from './tableIndex';
import { accessedFields } from '../../data/accessedFields';
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
    // Signum-compatible naming, carried beside `isPostgres` and set by SchemaBuilder from
    // settings.legacyMode for the same reason: a filtered index's WHERE predicate is rendered at
    // REGISTRATION time, and that text is also what the index NAME's hash suffix is computed over —
    // so the renderer has to know which spelling of a boolean literal to use. See indexWhere's
    // `literal`.
    legacyMode = false;
    // This table is altea's stand-in for a Signum MLIST TABLE: a `@part` row reached through an
    // owner's ARRAY (SchemaBuilder's `mlistRowOwner`). STRUCTURAL — true whatever the mode — but
    // only legacyMode acts on it, because in Signum such a table is not an entity at all: it has no
    // Ticks, no ToStr, and no row in the TypeEntity table. Kept here so a consumer outside the
    // builder (TypeLogic) can ask without re-deriving it.
    isMListRow = false;
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
        // An entity ctor (the common case) or a View ctor (a raw database view / temp table, built by
        // ViewBuilder). Entity and View share no base class, hence the union rather than a cast.
        public readonly type: Type<Entity> | ViewType<View>,
        name: ObjectName,
    ) {
        this.name = name;
    }

    // Fluent index declaration (Signum's FluentInclude.WithIndex / WithUniqueIndex, whose
    // signature is `(fields, where?, includeFields?)`). `fields` reads the covered columns
    // (`e => e.code`, `e => [e.a, e.b]`); `where` is a filtered-index predicate captured by the
    // transformer (`e => e.active`); `includeFields` selects INCLUDE columns. Returns the table
    // for chaining.
    addIndex(fields: Quoted<(element: any) => unknown>, where?: Quoted<(element: any) => boolean>, includeFields?: Quoted<(element: any) => unknown>): Table {
        this.addFluentIndex(fields, false, where, includeFields);
        return this;
    }

    addUniqueIndex(fields: Quoted<(element: any) => unknown>, where?: Quoted<(element: any) => boolean>, includeFields?: Quoted<(element: any) => unknown>): Table {
        this.addFluentIndex(fields, true, where, includeFields);
        return this;
    }

    private addFluentIndex(fields: Quoted<(element: any) => unknown>, unique: boolean, where?: Quoted<(element: any) => boolean>, includeFields?: Quoted<(element: any) => unknown>): void {
        const blocks = this.fieldBlocksFromFields(accessedFields(fields));
        const includeColumns = includeFields == null ? undefined : this.columnsFromFields(accessedFields(includeFields));
        // Render the predicate to SQL now (registration time), like Signum's AddIndex.
        const whereSql = where == null ? undefined : getIndexWhere(where, this, this.isPostgres);
        // A UNIQUE index is EXPANDED per polymorphic alternative and filtered (Signum's
        // AddMultiUniqueIndex); a plain one stays flat, exactly as Signum's AddIndex does.
        if (unique)
            this.indexes.push(...multiUniqueIndexes(this, blocks, this.isPostgres, { includeColumns, where: whereSql }));
        else
            this.indexes.push(new TableIndex(this, blocks.flatMap(b => b.columns), { unique, includeColumns, where: whereSql }));
    }

    // Resolves entity field names (own or mixin) to their physical columns. A DOTTED name walks
    // EMBEDDED steps ("scriptExecution.nextExecution"), which live in this same row and so are
    // indexable exactly like a flat field — Signum indexes them by the same expression.
    columnsFromFields(fieldNames: string[]): IColumn[] {
        return this.fieldBlocksFromFields(fieldNames).flatMap(b => b.columns);
    }

    // The same resolution, keeping each name's FIELD beside its columns — Signum's
    // IndexKeyColumns.Split. A UNIQUE index needs the field, because a polymorphic one owns
    // several columns of which exactly one is filled per row (see multiUniqueIndexes).
    fieldBlocksFromFields(fieldNames: string[]): IndexBlock[] {
        return fieldNames.map(name => {
            const [first, ...rest] = name.split(".");
            let ef = this.fields[first] ?? this.findMixinField(first);
            if (ef == null)
                throw new Error(`Index on '${this.name.name}': no field '${first}' to index.`);

            for (const step of rest) {
                if (!(ef.field instanceof FieldEmbedded))
                    throw new Error(`Index on '${this.name.name}': '${name}' walks '${step}' through a field that is not embedded — only embedded steps stay in this row.`);
                const next = ef.field.embeddedFields[step];
                if (next == null)
                    throw new Error(`Index on '${this.name.name}': no field '${step}' inside '${name}' to index.`);
                ef = next;
            }

            return { field: ef.field, columns: ef.field.columns() };
        });
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
