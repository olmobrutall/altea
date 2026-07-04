import type { IColumn } from './column';
import type { Table } from './table';

// Port of Signum's Engine/Schema/TableIndexes.cs TableIndex, scoped to what altea models: a
// (possibly unique) index over one or more columns, with optional INCLUDE columns. The index
// NAME is computed by the SqlBuilder (IX_/UIX_ prefix + table + column signature + hash), not
// stored here, so a single place owns naming for both generation and synchronization. The
// WHERE/filtered-index, clustered, partitioned and indexed-view cases Signum also handles are
// deferred (no altea model yet).
export class TableIndex {
    includeColumns?: IColumn[];
    unique: boolean;
    // A filtered (partial) index's WHERE clause, already rendered to SQL (Signum's
    // TableIndex.Where). Undefined for a full index.
    where?: string;

    constructor(
        public readonly table: Table,
        public readonly columns: IColumn[],
        options?: { unique?: boolean; includeColumns?: IColumn[]; where?: string },
    ) {
        this.unique = options?.unique ?? false;
        this.includeColumns = options?.includeColumns;
        this.where = options?.where;
    }
}

// Options for the fluent withIndex / withUniqueIndex and the @index / @uniqueIndex lambda
// decorators. `includeFields` selects INCLUDE (covering) columns; `where` is the filtered
// (partial) index predicate as an SQL string (a lambda→SQL form would need transformer
// capture like a query `filter`, deferred).
export interface IndexOptions<T> {
    includeFields?: (element: T) => unknown;
    where?: string;
}

// Records the entity fields a selector lambda touches by running it against a proxy that
// notes each property read — the altea analogue of Signum's IndexKeyColumns.Split over an
// expression tree. Supports flat field access (`e => e.name`, `e => [e.a, e.b]`); nested
// paths (`e => e.address.city`) are not modelled.
export function recordAccessedFields(selector: (element: any) => unknown): string[] {
    const fields: string[] = [];
    const proxy = new Proxy({}, {
        get(_target, prop): unknown {
            if (typeof prop === 'string')
                fields.push(prop);
            return undefined;
        },
    });
    selector(proxy);
    if (fields.length === 0)
        throw new Error('An index selector must read at least one field, e.g. e => [e.name] or e => e.code');
    return fields;
}
