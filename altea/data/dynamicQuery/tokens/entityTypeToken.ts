import { PropertyRoute } from "../../propertyRoute";
import { Implementations } from "../../implementations";
import { TypeReference } from "../../reflection";
import { TypeEntity } from "../../typeEntity";
import { QueryTokenMessage } from "../../dynamicQueries";
import { QueryToken, SubTokensOptions } from "./queryToken";

// Port of Signum's `EntityTypeToken`: on a POLYMORPHIC reference, "which type is this row actually
// pointing at?" — the `[EntityType]` sub-token, a `Lite<TypeEntity>`.
//
// It is offered on both polymorphic branches (`@implementedByAll` and `@implementedBy` with several
// implementations) and FIRST in each — Signum's `PreAnd` — because it is the one thing a caller can
// ask of such a reference without committing to a cast. A cast answers a different question
// (`(Artist).Name` reads a member IF the target is an Artist, and is NULL for every other row);
// this one is a value every row has, so it filters, groups and sorts.
//
// The discriminator is already a column: `@implementedByAll` stores the TypeEntity id, and an
// `@implementedBy` derives one from whichever implementation column is filled — so this token needs
// no new SQL machinery, only the navigation. See tokenExpressions.ts for the expression half.
export class EntityTypeToken extends QueryToken {
    constructor(private readonly _parent: QueryToken) {
        super();
        this.priority = 10;
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return "[EntityType]"; }
    override toString(): string { return `[${QueryTokenMessage.EntityType.niceToString()}]`; }
    niceName(): string {
        return QueryTokenMessage._0Of1.niceToString(QueryTokenMessage.EntityType.niceToString(), this._parent.toString());
    }
    get type(): TypeReference { return new TypeReference({ type: () => TypeEntity, lite: true }); }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    getImplementations(): Implementations | undefined { return Implementations.by(TypeEntity); }
    getPropertyRoute(): PropertyRoute | undefined { return PropertyRoute.root(TypeEntity); }

    // The parent's answer, else the route's — which is what Signum's body actually does: the `And`
    // combination above the return is a DISCARDED expression there (no assignment, no return), so
    // both frameworks report the first restriction rather than both. altea's AsTypeToken, whose
    // Signum original carries the same dead line, is written the same way.
    isAllowed(): string | null { return this._parent.isAllowed() ?? this.getPropertyRoute()!.isAllowed(); }

    protected subTokensOverride(options: SubTokensOptions): QueryToken[] {
        return this.subTokensBase(this.type, options, this.getImplementations());
    }
}
