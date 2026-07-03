import type { Type, Entity } from '../../entities/entity';
import { ObjectName } from './objectName';
import { EntityField, FieldPrimaryKey, FieldTicks, FieldMixin } from './field';
import type { IColumn } from './column';

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
    // Physical display-string column (Signum's `ToStr`), present only when the
    // entity's `toString()` is a hand-written method (not a `@quoted` expression the
    // query provider can translate). Written at save time = `entity.toString()`.
    toStrColumn?: IColumn;

    constructor(
        public readonly type: Type<Entity>,
        name: ObjectName,
    ) {
        this.name = name;
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
