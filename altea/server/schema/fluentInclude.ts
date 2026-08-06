import type { Quoted } from "quote-transformer/quoted";
import type { Entity, Type } from "../../data/entity";
import type { Table } from "./table";
import type { SchemaBuilder } from "./schemaBuilder";

// Port of Signum's `FluentInclude<T>` (Engine/Maps/SchemaBuilder.cs): the fluent handle returned by
// `sb.include<T>()`, wrapping the built Table plus the SchemaBuilder. Configuration methods hang off
// it — `withIndex`/`withUniqueIndex` here, and cross-layer ones added by declaration merging (e.g.
// `withQuery` from logic/dynamicQuery, mirroring Signum's DynamicQueryFluentInclude extension).
export class FluentInclude<T extends Entity> {
    constructor(
        public readonly table: Table,
        // The entity ctor this handle was included for (Signum's FluentInclude.Type). Held as
        // `Type<T>` — `table.type` widens to `Type<Entity> | ViewType<View>` because Table is shared
        // with views, but `FluentInclude<T extends Entity>` is always an entity, so this keeps the
        // precise type without a cast at each use (e.g. DynamicQueryFluentInclude.withExpressionTo).
        public readonly type: Type<T>,
        public readonly schemaBuilder: SchemaBuilder,
    ) { }

    withIndex(fields: Quoted<(element: T) => unknown>, where?: Quoted<(element: T) => boolean>, includeFields?: Quoted<(element: T) => unknown>): this {
        this.table.addIndex(fields, where, includeFields);
        return this;
    }

    withUniqueIndex(fields: Quoted<(element: T) => unknown>, where?: Quoted<(element: T) => boolean>, includeFields?: Quoted<(element: T) => unknown>): this {
        this.table.addUniqueIndex(fields, where, includeFields);
        return this;
    }
}
