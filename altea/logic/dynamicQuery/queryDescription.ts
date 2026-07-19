import type { RuntimeType } from "../../entities/runtimeTypes";
import type { Implementations } from "../../entities/implementations";
import type { PropertyRoute } from "../../entities/propertyRoute";
import type { QueryName } from "./queryUtils";

// Port of Signum's `ColumnDescription` (DynamicQuery/QueryDescription.cs): one column of a
// query's result shape. `ColumnToken` (Phase 2) is rooted at these. `type` is an altea
// `RuntimeType` (Signum's .NET `Type`).
export class ColumnDescription {
    // The reserved name of the row's own entity column (Signum's `ColumnDescription.Entity`).
    static readonly entityColumnName = "Entity";

    unit?: string;
    format?: string;
    implementations?: Implementations;
    propertyRoutes?: PropertyRoute[];

    constructor(
        public name: string,
        public type: RuntimeType,
        public displayName: string,
    ) { }

    // True for the special "Entity" column carrying the row's own entity/lite.
    get isEntity(): boolean {
        return this.name === ColumnDescription.entityColumnName;
    }

    toString(): string {
        return this.displayName;
    }
}

// Port of Signum's `QueryDescription`: a query's name plus the description of each column.
export class QueryDescription {
    constructor(
        public queryName: QueryName,
        public columns: ColumnDescription[],
    ) { }
}
