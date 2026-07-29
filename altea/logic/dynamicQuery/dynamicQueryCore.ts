import type { Entity } from "../../entities/entity";
import { ClassType, type RuntimeType } from "../runtimeTypes";
import { table } from "../table";
import type { Query } from "../query";
import "./dQueryable"; // augments Query with .toDQueryable()
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

// The concrete entity/model ctor behind a query's element type.
function shapeCtorOf(elementType: RuntimeType): Function {
    if (elementType instanceof ClassType)
        return elementType.constructorFunction;
    throw new Error(`A query's element type must be a reflected entity/model class, got ${elementType}`);
}

// Port of Signum's `AutoDynamicQueryCore<T>` — a query backed by an IQueryable (altea: a `Query<T>`
// factory). Covers BOTH `WithQuery` (Type 1, `table(T)`) and a manually-registered query that
// filters/joins/projects (Type 2, e.g. `() => table(User).filter(u => u.isActive)` or
// `() => table(User).flatMap(…).map(u => SomeModel.create({ entity: u, … }))`). The shape is the
// query's element type — a full entity or a projected ModelEntity — and the request's tokens navigate
// that row directly. No selector/projection metadata: it all comes from reflection on the shape type.
export class AutoDynamicQueryCore implements DynamicQueryCore {
    private _rootType: Function | undefined;

    constructor(private readonly getQuery: () => Query<any>, rootType?: Function) {
        this._rootType = rootType;
    }

    // WithQuery convenience (Type 1): the query is just `table(T)`, root type known up front.
    static fromEntity(rootType: Function): AutoDynamicQueryCore {
        return new AutoDynamicQueryCore(() => table(rootType as new () => Entity), rootType);
    }

    getRootType(): Function {
        // For a manual Type-2 query the shape is inferred from the factory's element type (building the
        // query AST is cheap — it does not execute). Cached after first use.
        return this._rootType ??= shapeCtorOf(this.getQuery().elementType);
    }

    // Signum's ExecuteQueryAsync: seed the context off the query (the row root "") → AllQuery
    // Operations → ToResultTable.
    async executeQueryAsync(request: QueryRequest): Promise<ResultTable> {
        const result = await this.getQuery().toDQueryable().allQueryOperationsAsync(request);
        return result.toResultTable(request.columns, request.pagination);
    }
}

// Port of Signum's `DynamicQueryCore.Manual` (Type 3): an arbitrary imperative `request → ResultTable`
// executor. Its shape is still a declared reflected model type (so the token tree / column metadata
// come from reflection, exactly like every other query) — only the EXECUTION is hand-written.
export class ManualDynamicQueryCore implements DynamicQueryCore {
    constructor(
        private readonly rootType: Function,
        private readonly executor: (request: QueryRequest) => Promise<ResultTable>,
    ) { }

    getRootType(): Function {
        return this.rootType;
    }

    executeQueryAsync(request: QueryRequest): Promise<ResultTable> {
        return this.executor(request);
    }
}
