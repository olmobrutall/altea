import type { Type, Entity } from '../../entities/entity';
import type { FieldInfo } from '../../entities/reflection';
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

// A reflected entity property paired with the schema Field it maps to.
// `getter` reads the value off an instance (used by save/query later).
export class EntityField {
    constructor(
        public readonly fieldInfo: FieldInfo,
        public readonly field: Field,
        public readonly getter: (entity: any) => unknown,
    ) { }
}

// Base of the schema field hierarchy. Each Field emits the physical columns it
// owns; multi-column and zero-column fields override accordingly. (Index
// generation is deferred to a later milestone.)
export abstract class Field {
    abstract columns(): IColumn[];
    // Signum's AvoidExpandOnRetrieving (from @avoidExpandOnRetrieving on the property):
    // a reference field so marked is not eager-expanded when its owner is retrieved.
    avoidExpandOnRetrieving = false;
}

export class FieldPrimaryKey extends Field {
    constructor(public readonly column: PrimaryKeyColumn) {
        super();
    }

    columns(): IColumn[] {
        return [this.column];
    }
}

export class FieldValue extends Field {
    constructor(public readonly column: ValueColumn) {
        super();
    }

    columns(): IColumn[] {
        return [this.column];
    }
}

// Optimistic-concurrency token (maps Entity.ticks).
export class FieldTicks extends FieldValue { }

// FK to a single concrete entity table. The column carries the reference target
// and whether the property is a Lite<T> (vs a full entity reference).
export class FieldReference extends Field {
    constructor(public readonly column: ReferenceColumn) {
        super();
    }

    columns(): IColumn[] {
        return [this.column];
    }
}

// FK to an enum side-table (Signum's FieldEnum, which likewise extends
// FieldReference). The column stores the enum's underlying numeric value and
// points at the per-enum table (id + name).
export class FieldEnum extends FieldReference { }

// Polymorphic reference with one FK column per allowed implementation.
export class FieldImplementedBy extends Field {
    constructor(
        public readonly implementationColumns: ImplementationColumn[],
        public readonly isLite: boolean,
    ) {
        super();
    }

    columns(): IColumn[] {
        return [...this.implementationColumns];
    }
}

// Polymorphic reference to any entity: an id column + a type discriminator.
export class FieldImplementedByAll extends Field {
    constructor(
        // One id column per configured primary-key type (Signum's ImplementedByAllPrimaryKeyTypes);
        // only the column matching the target's PK type is populated per row.
        public readonly idColumns: readonly ImplementedByAllIdColumn[],
        public readonly typeColumn: ImplementedByAllTypeColumn,
        public readonly isLite: boolean,
    ) {
        super();
    }

    columns(): IColumn[] {
        return [...this.idColumns, this.typeColumn];
    }
}

// Embedded value object flattened into the parent's columns. A nullable embedded
// also carries a HasValue indicator column.
export class FieldEmbedded extends Field {
    constructor(
        public readonly hasValue: EmbeddedHasValueColumn | undefined,
        public readonly embeddedFields: { [name: string]: EntityField },
    ) {
        super();
    }

    columns(): IColumn[] {
        const cols: IColumn[] = [];
        if (this.hasValue != null)
            cols.push(this.hasValue);
        for (const ef of Object.values(this.embeddedFields))
            cols.push(...ef.field.columns());
        return cols;
    }
}

// Mixin fields stored in the same row as the host entity.
export class FieldMixin extends Field {
    constructor(
        public readonly fields: { [name: string]: EntityField },
        // The mixin class this field group belongs to (Signum's MixinEntity type), so a query's
        // `entity.mixin(X)` can be matched to the right mixin.
        public readonly mixinType?: Type<Entity>,
    ) {
        super();
    }

    columns(): IColumn[] {
        const cols: IColumn[] = [];
        for (const ef of Object.values(this.fields))
            cols.push(...ef.field.columns());
        return cols;
    }
}

// Altea's replacement for Signum's FieldMList: a `ChildEntity[]` whose elements
// live in the child's own table and point back via `childFkProperty`. Emits NO
// column on the parent — it's pure navigation. `cascade` marks the array as an
// owned aggregate part (save/delete with the parent); enforced in milestone C.
export class FieldEntityArray extends Field {
    constructor(
        public readonly childType: Type<Entity>,
        public readonly childFkProperty: string,
        public readonly cascade: boolean,
    ) {
        super();
    }

    columns(): IColumn[] {
        return [];
    }
}
