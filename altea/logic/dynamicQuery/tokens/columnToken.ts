import { PropertyRoute } from "../../../entities/propertyRoute";
import type { Implementations } from "../../../entities/implementations";
import type { RuntimeType } from "../../../entities/runtimeTypes";
import type { Expression } from "../../linq/expressions";
import type { ColumnDescription } from "../queryDescription";
import type { QueryName } from "../queryUtils";
import {
    QueryToken, BuildExpressionContext, SubTokensOptions, cleanType, entityCtorOf,
} from "./queryToken";

// Port of Signum's `ColumnToken` (DynamicQuery/Tokens/ColumnToken.cs): a root token backed by one
// of a query's declared columns (a `ColumnDescription`). It has no parent; its expression is always
// seeded in the BuildExpressionContext replacements (from the query's projection), so
// `buildExpressionInternal` throws — reaching it means the column wasn't seeded.
export class ColumnToken extends QueryToken {
    constructor(
        public readonly column: ColumnDescription,
        private readonly _queryName: QueryName,
    ) {
        super();
    }

    get parent(): QueryToken | undefined { return undefined; }
    override get queryName(): QueryName { return this._queryName; }

    override isEntity(): boolean { return this.column.isEntity; }

    get key(): string { return this.column.name; }
    override toString(): string { return this.column.displayName; }
    niceName(): string { return this.column.displayName; }

    get type(): RuntimeType { return this.column.type; }
    get format(): string | undefined { return this.column.format; }
    get unit(): string | undefined { return this.column.unit; }

    getImplementations(): Implementations | undefined { return this.column.implementations; }

    getPropertyRoute(): PropertyRoute | undefined {
        if (this.column.propertyRoutes != undefined)
            return this.column.propertyRoutes[0];
        const ctor = entityCtorOf(cleanType(this.column.type));
        return ctor != undefined ? PropertyRoute.root(ctor) : undefined;
    }

    isAllowed(): string | null { return null; } // filtered upstream if not

    protected buildExpressionInternal(_context: BuildExpressionContext): Expression {
        throw new Error(`ColumnToken '${this.fullKey()}' was not found in the BuildExpressionContext replacements`);
    }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.column.type, options, this.column.implementations);
    }
}
