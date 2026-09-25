import type { Quoted } from 'quote-transformer/quoted';
import type { Type, Entity, View, ViewType } from '../../data/entity';
import { ObjectName } from './objectName';
import { EntityField, FieldPrimaryKey, FieldTicks, FieldMixin, FieldEmbedded } from './field';
import type { IColumn } from './column';
import type { IndexBlock } from './tableIndex';
import { TableIndex, multiUniqueIndexes } from './tableIndex';
import { accessedMembers } from '../../data/accessedFields';
import type { LambdaMember } from '../../data/lambdaMembers';
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
        const blocks = this.fieldBlocksFromMembers(accessedMembers(fields));
        const includeColumns = includeFields == null ? undefined : this.columnsFromMembers(accessedMembers(includeFields));
        // Render the predicate to SQL now (registration time), like Signum's AddIndex.
        const whereSql = where == null ? undefined : getIndexWhere(where, this, this.isPostgres);
        // A UNIQUE index is EXPANDED per polymorphic alternative and filtered (Signum's
        // AddMultiUniqueIndex); a plain one stays flat, exactly as Signum's AddIndex does.
        if (unique)
            this.indexes.push(...multiUniqueIndexes(this, blocks, this.isPostgres, { includeColumns, where: whereSql }));
        else
            this.indexes.push(new TableIndex(this, blocks.flatMap(b => b.columns), { unique, includeColumns, where: whereSql }));
    }

    // Resolves a member path (Signum's Schema.FindField over a member list) to the field it names in THIS
    // row: an own field, or a mixin's through an explicit `mixin(M)` step, then EMBEDDED steps
    // ("scriptExecution.nextExecution"), which live in this same row and so are indexable exactly like a
    // flat field — Signum indexes them by the same expression. A reference or collection step leaves the
    // row, so it is refused, as is any step after a leaf.
    fieldFromMembers(members: readonly LambdaMember[]): EntityField {
        const path = () => members.map(m => m.type == "Mixin" ? `mixin(${m.name})` : m.type == "Indexer" ? "[i]" : m.name).join(".");
        if (members.length === 0)
            throw new Error(`Index on '${this.name.name}': an empty member path names no field.`);

        let i = 0;
        let fields: { [name: string]: EntityField } = this.fields;
        if (members[0].type == "Mixin") {
            const mixin = this.mixins[members[0].name];
            if (mixin == null)
                throw new Error(`Index on '${this.name.name}': '${path()}' names mixin '${members[0].name}', which the table does not have.`);
            fields = mixin.fields;
            i = 1;
        }

        let ef: EntityField | undefined;
        for (; i < members.length; i++) {
            const m = members[i];
            if (m.type != "Member")
                throw new Error(`Index on '${this.name.name}': '${path()}' — only field steps can follow a mixin, not ${m.type == "Mixin" ? "another mixin" : "an indexer"}.`);
            if (ef != null) {
                if (!(ef.field instanceof FieldEmbedded))
                    throw new Error(`Index on '${this.name.name}': '${path()}' walks '${m.name}' through a field that is not embedded — only embedded steps stay in this row.`);
                fields = ef.field.embeddedFields;
            }
            ef = fields[m.name];
            if (ef == null)
                throw new Error(`Index on '${this.name.name}': no field '${m.name}' in '${path()}' to index.`);
        }
        if (ef == null)
            throw new Error(`Index on '${this.name.name}': '${path()}' names a mixin, not a field.`);
        return ef;
    }

    columnsFromMembers(memberLists: readonly (readonly LambdaMember[])[]): IColumn[] {
        return this.fieldBlocksFromMembers(memberLists).flatMap(b => b.columns);
    }

    // The same resolution, keeping each path's FIELD beside its columns — Signum's
    // IndexKeyColumns.Split. A UNIQUE index needs the field, because a polymorphic one owns
    // several columns of which exactly one is filled per row (see multiUniqueIndexes).
    fieldBlocksFromMembers(memberLists: readonly (readonly LambdaMember[])[]): IndexBlock[] {
        return memberLists.map(members => {
            const ef = this.fieldFromMembers(members);
            return { field: ef.field, columns: ef.field.columns() };
        });
    }

    // Field NAMES, for the callers that name a field rather than hold a selector: a dotted name walks
    // embedded steps; a root name that is no field of the entity is looked up in its mixins, and must
    // name exactly one of their fields.
    columnsFromFields(fieldNames: string[]): IColumn[] {
        return this.columnsFromMembers(fieldNames.map(name => this.membersOfFieldName(name)));
    }

    private membersOfFieldName(name: string): LambdaMember[] {
        const steps: LambdaMember[] = name.split(".").map(n => ({ name: n, type: "Member" }));
        if (this.fields[steps[0].name] != null)
            return steps;
        const owners = Object.entries(this.mixins).filter(([, m]) => m.fields[steps[0].name] != null).map(([k]) => k);
        if (owners.length > 1)
            throw new Error(`Index on '${this.name.name}': '${steps[0].name}' is a field of several mixins (${owners.join(", ")}); name the mixin (e => e.mixin(M).${steps[0].name}).`);
        return owners.length == 1 ? [{ name: owners[0], type: "Mixin" }, ...steps] : steps;
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
