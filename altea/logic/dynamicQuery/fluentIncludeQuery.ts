import type { Quoted } from "quote-transformer/quoted";
import type { Entity } from "../../entities/entity";
import { typeConstructor } from "../../entities/entity";
import { FluentInclude } from "../schema/fluentInclude";
import { QueryLogic } from "./queryLogic";
import { AutoDynamicQueryCore } from "./dynamicQueryCore";
import type { Implementations } from "../../entities/implementations";

// Port of Signum's `DynamicQueryFluentInclude` (extension methods on FluentInclude, kept in the
// DynamicQuery layer so the schema layer stays independent). altea adds them by declaration merging
// + prototype augmentation.
declare module "../schema/fluentInclude" {
    interface FluentInclude<T extends Entity> {
        // Signum's WithQuery, but PARAMETERLESS (altea's redesign): the query IS `table(T)`, so its
        // shape is just the entity — no column selector. Columns are navigated as rootless tokens off
        // the entity ("Name", "Customer.Name", …); computed columns are registered expressions; default
        // display columns are a client concern. Registers an AutoDynamicQueryCore in QueryLogic.queries.
        withQuery(): this;
        // Signum's WithExpressionTo (hung off FluentInclude<T> for the SOURCE entity T): register an
        // expression FROM this entity to ANOTHER entity S (a reference or an IQuery<S>), so it shows
        // up as a sub-token on this entity's tokens (e.g. `Customer.orders`). The niceName defaults to
        // S's NicePluralName / NiceName — which is why these helpers are for ENTITY-valued expressions;
        // register a scalar directly via `QueryLogic.expressions.register` with an explicit niceName.
        withExpressionTo<S>(lambda: Quoted<(source: T) => S>, opts?: { key?: string; niceName?: () => string; implementations?: Implementations }): this;
        // Signum's WithExpressionFrom (hung off FluentInclude<T> for the TARGET entity T): register an
        // expression on a DIFFERENT entity F that navigates to this T (a reference or IQuery<T>), so it
        // shows up as a sub-token on F's tokens (e.g. `Include(OrderEntity).withExpressionFrom(
        // CustomerEntity, c => c.orders())` adds `Customer.orders`). niceName defaults to this T's
        // NicePluralName / NiceName. Signum infers F from the lambda's parameter type; altea can't read
        // that off a quoted lambda, so the source ctor F is passed explicitly.
        withExpressionFrom<F extends Entity>(sourceType: new () => F, lambda: Quoted<(source: F) => unknown>, opts?: { key?: string; niceName?: () => string; implementations?: Implementations }): this;
    }
}

FluentInclude.prototype.withQuery = function <T extends Entity>(this: FluentInclude<T>): FluentInclude<T> {
    const rootType = typeConstructor(this.table.type);
    // Register an executable auto-query (Signum's WithQuery). Its shape is the entity itself; its
    // source is `table(T)` (no projection) — see AutoDynamicQueryCore.
    QueryLogic.queries.register(rootType, () => new AutoDynamicQueryCore(rootType));
    return this;
};

FluentInclude.prototype.withExpressionTo = function <T extends Entity, S>(this: FluentInclude<T>, lambda: Quoted<(source: T) => S>, opts?: { key?: string; niceName?: () => string; implementations?: Implementations }): FluentInclude<T> {
    // Source = this entity T (the lambda's parameter).
    QueryLogic.expressions.register(typeConstructor(this.table.type), lambda, opts);
    return this;
};

FluentInclude.prototype.withExpressionFrom = function <T extends Entity, F extends Entity>(this: FluentInclude<T>, sourceType: new () => F, lambda: Quoted<(source: F) => unknown>, opts?: { key?: string; niceName?: () => string; implementations?: Implementations }): FluentInclude<T> {
    // Source = the OTHER entity F (the lambda's parameter); the expression navigates from F to this T.
    QueryLogic.expressions.register(sourceType, lambda, opts);
    return this;
};
