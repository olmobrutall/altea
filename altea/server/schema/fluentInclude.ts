import type { Quoted } from "quote-transformer/quoted";
import type { Entity } from "../../entities/entity";
import type { Table } from "./table";
import type { SchemaBuilder } from "./schemaBuilder";

// Port of Signum's `FluentInclude<T>` (Engine/Maps/SchemaBuilder.cs): the fluent handle returned by
// `sb.include<T>()`, wrapping the built Table plus the SchemaBuilder. Configuration methods hang off
// it — `withIndex`/`withUniqueIndex` here, and cross-layer ones added by declaration merging (e.g.
// `withQuery` from logic/dynamicQuery, mirroring Signum's DynamicQueryFluentInclude extension).
export class FluentInclude<T extends Entity> {
    constructor(
        public readonly table: Table,
        public readonly schemaBuilder: SchemaBuilder,
    ) { }

    withIndex(fields: (element: T) => unknown, where?: Quoted<(element: T) => boolean>, includeFields?: (element: T) => unknown): this {
        this.table.addIndex(fields, where, includeFields);
        return this;
    }

    withUniqueIndex(fields: (element: T) => unknown, where?: Quoted<(element: T) => boolean>, includeFields?: (element: T) => unknown): this {
        this.table.addUniqueIndex(fields, where, includeFields);
        return this;
    }
}
