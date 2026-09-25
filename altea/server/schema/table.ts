import type { Quoted } from 'quote-transformer/quoted';
import type { Type, Entity, View, ViewType } from '../../data/entity';
import { ObjectName } from './objectName';
import { EntityField, FieldPrimaryKey, FieldTicks, FieldMixin, FieldEmbedded } from './field';
import type { IColumn } from './column';
import type { IndexBlock } from './tableIndex';
import { TableIndex, multiUniqueIndexes } from './tableIndex';
import { FieldRoute, accessedRoutes } from '../../data/fieldRoute';
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

    // `type` for a table of ENTITY rows — every table but a view's (a referenced table, a part's, any
    // table in Schema.tables). Throws for a view rather than handing a View ctor to entity-only code.
    get entityType(): Type<Entity> {
        if (this.isView)
            throw new Error(`Table ${this.name} is a view (${this.type.name}), not an entity table`);
        return this.type as Type<Entity>;
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
        const blocks = this.fieldBlocks(accessedRoutes(this.type, fields));
        const includeColumns = includeFields == null ? undefined : this.columnsOf(accessedRoutes(this.type, includeFields));
        // Render the predicate to SQL now (registration time), like Signum's AddIndex.
        const whereSql = where == null ? undefined : getIndexWhere(where, this, this.isPostgres);
        // A UNIQUE index is EXPANDED per polymorphic alternative and filtered (Signum's
        // AddMultiUniqueIndex); a plain one stays flat, exactly as Signum's AddIndex does.
        if (unique)
            this.indexes.push(...multiUniqueIndexes(this, blocks, this.isPostgres, { includeColumns, where: whereSql }));
        else
            this.indexes.push(new TableIndex(this, blocks.flatMap(b => b.columns), { unique, includeColumns, where: whereSql }));
    }

    // The field a FieldRoute names in THIS row (Signum's Schema.FindField): an own field, a mixin's through its
    // mixin step, then EMBEDDED steps, which live in this same row and so are indexable exactly like a flat
    // field — Signum indexes them by the same expression. The route itself already refused a step that leaves
    // the row; what is left to check is that it is rooted here and that the field has a column (an ignored or
    // not-mapped one has none).
    field(route: FieldRoute): EntityField {
        if (route.rootType !== this.type)
            throw new Error(`Table '${this.name.name}': the route ${route} is rooted at another type.`);
        if (route.isRoot)
            throw new Error(`Table '${this.name.name}': a root route names no field.`);

        let fields: { [name: string]: EntityField } = this.fields;
        let ef: EntityField | undefined;
        for (const step of route.steps) {
            if (step.type == "Mixin") {
                if (ef == undefined) {
                    const mixin = this.mixins[step.name];
                    if (mixin == null)
                        throw new Error(`Table '${this.name.name}': ${route} names mixin '${step.name}', which the table does not have.`);
                    fields = mixin.fields;
                }
                // An embedded's mixin fields are FLATTENED into its embeddedFields (see generateEmbedded), so the
                // step selects nothing there — the fields map is already the embedded's.
                continue;
            }
            if (ef != undefined) {
                if (!(ef.field instanceof FieldEmbedded))
                    throw new Error(`Table '${this.name.name}': ${route} walks through a field that is not embedded.`);
                fields = ef.field.embeddedFields;
            }
            ef = fields[step.name];
            if (ef == null)
                throw new Error(`Table '${this.name.name}': ${route} has no column — the field is ignored or not mapped.`);
        }
        if (ef == null)
            throw new Error(`Table '${this.name.name}': ${route} names a mixin, not a field.`);
        return ef;
    }

    columnsOf(routes: readonly FieldRoute[]): IColumn[] {
        return this.fieldBlocks(routes).flatMap(b => b.columns);
    }

    // The same resolution, keeping each route's FIELD beside its columns — Signum's
    // IndexKeyColumns.Split. A UNIQUE index needs the field, because a polymorphic one owns
    // several columns of which exactly one is filled per row (see multiUniqueIndexes).
    fieldBlocks(routes: readonly FieldRoute[]): IndexBlock[] {
        return routes.map(route => {
            const ef = this.field(route);
            return { field: ef.field, columns: ef.field.columns() };
        });
    }

    // Field NAMES, for the callers that name a field rather than hold a selector: a dotted name walks
    // embedded steps; a root name that is no field of the entity is looked up in its mixins, and must
    // name exactly one of their fields.
    columnsFromFields(fieldNames: string[]): IColumn[] {
        return this.columnsOf(fieldNames.map(name => this.routeOfFieldName(name)));
    }

    private routeOfFieldName(name: string): FieldRoute {
        const [first, ...rest] = name.split(".");
        let route = FieldRoute.root(this.type);
        if (this.fields[first] == null) {
            const owners = Object.entries(this.mixins).filter(([, m]) => m.fields[first] != null).map(([k]) => k);
            if (owners.length > 1)
                throw new Error(`Table '${this.name.name}': '${first}' is a field of several mixins (${owners.join(", ")}); name the mixin (e => e.mixin(M).${first}).`);
            if (owners.length == 1)
                route = route.addMixin(owners[0]);
        }
        for (const step of [first, ...rest])
            route = route.add(step);
        return route;
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
