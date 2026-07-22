import type { Entity } from "../../entities/entity";
import { table } from "../table";
import { DQueryable } from "./dQueryable";
import type { ResultTable } from "./resultTable";
import type { QueryRequest } from "./requests";

// Port of Signum's `IDynamicQueryCore` (DynamicQuery/DynamicQueryCore.cs): an executable query. Its
// SHAPE is a reflected entity/model type (Signum's QueryDescription is gone — column metadata comes
// from reflection + the MetadataVisitor); the container mints the entity-root token from that type.
export interface DynamicQueryCore {
    // The reflected shape type (the query's row): a full entity for auto queries, a ModelEntity for
    // custom projections. The token tree roots on it (key "").
    getRootType(): Function;
    executeQueryAsync(request: QueryRequest): Promise<ResultTable>;
}

// Port of Signum's `AutoDynamicQueryCore<T>` for a plain entity query (`WithQuery`). altea's WithQuery
// takes NO selector: the query IS `table(T)`, so its shape is just the reflected entity. Columns are
// navigated as rootless tokens off it ("Name", "Customer.Name", …); computed columns are registered
// expressions. Custom projections / joins are a separate manually-registered core, not this.
export class AutoDynamicQueryCore implements DynamicQueryCore {
    constructor(private readonly rootType: Function) { }

    getRootType(): Function {
        return this.rootType;
    }

    // Signum's ExecuteQueryAsync: seed the context off `table(T)` (the entity root "") → AllQuery
    // Operations → ToResultTable. The request's tokens navigate the entity directly.
    async executeQueryAsync(request: QueryRequest): Promise<ResultTable> {
        const dq = DQueryable.forEntityQuery(table(this.rootType as new () => Entity));
        const result = await dq.allQueryOperationsAsync(request);
        return result.toResultTable(request.columns, request.pagination);
    }
}
