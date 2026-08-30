import { Entity, type BaseEntity, type Type } from "../../data/entity";
import { ClassType, type RuntimeType } from "../runtimeTypes";
import { table } from "../table";
import type { Query } from "../query";
import "./dQueryable"; // augments Query with .toDQueryable()
import type { ResultTable } from "./resultTable";
import { Column, type QueryRequest } from "./requests";
import { RootToken, rowEntityToken } from "../../data/dynamicQuery/tokens";

// Port of Signum's `IDynamicQueryCore` (DynamicQuery/DynamicQueryCore.cs): an executable query. Its
// SHAPE is a reflected entity/model type (Signum's QueryDescription is gone — column metadata comes
// from reflection + the MetadataVisitor); the container mints the entity-root token from that type.
export interface DynamicQueryCore {
    // The reflected shape type (the query's row): a full entity for auto queries, a ModelEntity for
    // custom projections. The token tree roots on it (key "").
    getRootType(): Type<BaseEntity>;
    executeQueryAsync(request: QueryRequest): Promise<ResultTable>;
}

// The concrete entity/model ctor behind a query's element type.
function shapeCtorOf(elementType: RuntimeType): Type<BaseEntity> {
    if (elementType instanceof ClassType)
        return elementType.constructorFunction as Type<BaseEntity>;
    throw new Error(`A query's element type must be a reflected entity/model class, got ${elementType}`);
}

// Port of Signum's `AutoDynamicQueryCore<T>` — a query backed by an IQueryable (altea: a `Query<T>`
// factory). Covers BOTH `WithQuery` (Type 1, `table(T)`) and a manually-registered query that
// filters/joins/projects (Type 2, e.g. `() => table(User).filter(u => u.isActive)` or
// `() => table(User).flatMap(…).map(u => SomeModel.create({ entity: u, … }))`). The shape is the
// query's element type — a full entity or a projected ModelEntity — and the request's tokens navigate
// that row directly. No selector/projection metadata: it all comes from reflection on the shape type.
export class AutoDynamicQueryCore implements DynamicQueryCore {
    private _rootType: Type<BaseEntity> | undefined;

    constructor(private readonly getQuery: () => Query<any>, rootType?: Type<BaseEntity>) {
        this._rootType = rootType;
    }

    // WithQuery convenience (Type 1): the query is just `table(T)`, root type known up front.
    static fromEntity(rootType: Type<Entity>): AutoDynamicQueryCore {
        return new AutoDynamicQueryCore(() => table(rootType), rootType);
    }

    getRootType(): Type<BaseEntity> {
        // For a manual Type-2 query the shape is inferred from the factory's element type (building the
        // query AST is cheap — it does not execute). Cached after first use.
        return this._rootType ??= shapeCtorOf(this.getQuery().elementType);
    }

    // Signum's ExecuteQueryAsync: seed the context off the query (the row root "") → AllQuery
    // Operations → ToResultTable.
    async executeQueryAsync(request: QueryRequest): Promise<ResultTable> {
        this.addEntityColumn(request);
        // Row-level security (EntityEvents.queryFilter) is applied by the LINQ binder for EVERY query — a
        // dynamic query's `table(T)` source is filtered there too — so nothing extra is needed here.
        const result = await this.getQuery().toDQueryable().allQueryOperationsAsync(request);
        return result.toResultTable(request.columns, request.pagination);
    }

    private addEntityColumn(request: QueryRequest): void {
        addRowEntityColumn(request, this.getRootType());
    }
}

/**
 * Signum's AutoDynamicQuery.ExecuteQuery: a search result carries an implicit "Entity" column, so the
 * SearchControl can render the row's navigate link, run its double-click and know what is selected. For
 * a full-entity shape that is the ToLite of the root (built as a lite by DQueryable.select); for a row
 * MODEL it is the model's own `entity` member — see {@link rowEntityToken}. The ResultTable splits the
 * column out as `entityColumn`, so it is fetched on every row and never displayed.
 *
 * Skipped when the query GROUPS (a group row has no single entity) or when the request already asks for
 * an entity column. A model with no `entity` member (a pure aggregate row) simply gets none, and its
 * rows are not navigable — which is correct, not a failure.
 */
export function addRowEntityColumn(request: QueryRequest, rootType: Type<BaseEntity>): void {
    if (request.groupResults || request.columns.some(c => c.token.isEntity()))
        return;
    const token = rowEntityToken(new RootToken(rootType, request.queryName));
    if (token != undefined)
        request.columns = [new Column(token), ...request.columns];
}

// Port of Signum's `DynamicQueryCore.Manual` (Type 3): an arbitrary imperative `request → ResultTable`
// executor. Its shape is still a declared reflected model type (so the token tree / column metadata
// come from reflection, exactly like every other query) — only the EXECUTION is hand-written.
export class ManualDynamicQueryCore implements DynamicQueryCore {
    constructor(
        private readonly rootType: Type<BaseEntity>,
        private readonly executor: (request: QueryRequest) => Promise<ResultTable>,
    ) { }

    getRootType(): Type<BaseEntity> {
        return this.rootType;
    }

    executeQueryAsync(request: QueryRequest): Promise<ResultTable> {
        // The same implicit "Entity" column an auto query gets: a manual executor projects whatever
        // `request.columns` names, so a hand-written union (eastwind's CustomerModel over Person +
        // Company) becomes navigable without knowing anything about it.
        addRowEntityColumn(request, this.rootType);
        return this.executor(request);
    }
}
