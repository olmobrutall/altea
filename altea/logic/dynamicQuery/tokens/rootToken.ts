import { PropertyRoute } from "../../../entities/propertyRoute";
import { Implementations } from "../../../entities/implementations";
import { ClassType, type RuntimeType } from "../../../entities/runtimeTypes";
import { niceName } from "../../../entities/utils/localization";
import type { Expression } from "../../linq/expressions";
import type { QueryName } from "../queryUtils";
import { QueryToken, BuildExpressionContext, SubTokensOptions } from "./queryToken";

// The root token of a query (Signum's "Entity" ColumnToken, renamed since altea has no other column
// tokens). altea's redesign: a query's shape is a reflected entity/model type, so this token IS that
// type — it's the entry point for all navigation. Its key is "" — the rootless
// convention, so navigations read "Name", "Customer.Name" (not "Entity.Name"); its expression is the
// row parameter itself; its sub-tokens are the shape type's properties. There are no other "column"
// tokens (computed columns are registered expressions; the client picks display columns as token
// paths), so RootToken is now purely the query root.
export class RootToken extends QueryToken {
    constructor(
        private readonly shapeType: Function,
        private readonly _queryName: QueryName = shapeType,
    ) {
        super();
    }

    get parent(): QueryToken | undefined { return undefined; }
    override get queryName(): QueryName { return this._queryName; }
    override isEntity(): boolean { return true; }

    get key(): string { return ""; }
    override toString(): string { return niceName(this.shapeType); }
    niceName(): string { return niceName(this.shapeType); }

    get type(): RuntimeType { return new ClassType(this.shapeType); }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }

    getImplementations(): Implementations | undefined { return Implementations.by(this.shapeType); }
    getPropertyRoute(): PropertyRoute | undefined { return PropertyRoute.root(this.shapeType); }
    isAllowed(): string | null { return null; }

    protected buildExpressionInternal(context: BuildExpressionContext): Expression {
        return context.parameter; // the row itself (also seeded as replacements[""] by the pipeline)
    }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations());
    }
}
