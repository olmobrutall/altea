
import { Entity } from "../entities/entity";
import { CallExpression, ConstantExpression, Expression } from "./linq/expressions";
import { asStaticFunction, IQueryTranslator, Query } from "./query";
import { ArrayType, FunctionType, ClassType, Type } from "../entities/types";
import { expressionSimplifier } from "./linq/visitors/ExpressionSimplifier";
import { Connector } from "./connection/connector";
import { QueryBinder } from "./linq/visitors/QueryBinder";
import { AggregateRewriter } from "./linq/visitors/AggregateRewriter";
import { OrderByRewriter } from "./linq/visitors/OrderByRewriter";
import { QueryRebinder } from "./linq/visitors/QueryRebinder";
import { RedundantSubqueryRemover } from "./linq/visitors/RedundantSubqueryRemover";
import { ConditionsRewriter } from "./linq/visitors/ConditionsRewriter";
import { ScalarSubqueryRewriter } from "./linq/visitors/ScalarSubqueryRewriter";
import { ChildProjectionFlattener } from "./linq/visitors/ChildProjectionFlattener";
import { ProjectionExpression } from "./linq/expressions.sql";
import { buildTranslateResult } from "./linq/translatorBuilder";
import { QueryFormatter } from "./linq/queryFormatter";



declare global {
    interface Promise<T> {
        get $v(): T;
    }
}

if (!Object.prototype.hasOwnProperty.call(Promise.prototype, "$v")) {
    Object.defineProperty(Promise.prototype, "$v", {
        configurable: true,
        enumerable: false,
        get(this: Promise<unknown>): unknown {
            throw new Error("Promise.$v is a query-compiler marker and should not be evaluated at runtime.");
        }
    });
}

export function table<T extends Entity>(entityType: { new(): T }): Query<T> {
    var arrayType = new ArrayType(new ClassType(entityType));
    var callExpression = new CallExpression(
        new ConstantExpression(table, new FunctionType(table, arrayType)),
        [new ConstantExpression(entityType, new FunctionType(entityType, new ClassType(entityType)))],
        arrayType
    );
    return new Query<T>(callExpression, MyQueryTranslator.instance);
}

// `view(MyView)` — a query over a Database.View / temporary table (Signum's view()).
// Temporary views aren't modelled in altea yet, so this is a throwing stub that locks
// the call shape (used by the GroupJoin LeftOuterMyView test, which runs red).
export function view<T>(viewType: { new(): T }): Query<T> {
    throw new Error("view (Database.View / temporary table) is not implemented yet");
}

asStaticFunction(table).__resultType = (_, entityTypeType) => new ArrayType(new ClassType((entityTypeType as FunctionType).func!));

// Marks `table` as a query source so the QueryBinder recognises the
// `ConstantExpression(table)` at the root of a query CallExpression chain.
(table as unknown as { __isQuerySource?: boolean }).__isQuerySource = true;

class MyQueryTranslator implements IQueryTranslator {

    static instance: IQueryTranslator = new MyQueryTranslator();

    // Pipeline: simplify (partial eval) → QueryBinder (source AST → DbExpression
    // tree, incl. navigation JOIN expansion) → OrderByRewriter (float ORDER BY up
    // to the outermost/TOP select, resolve Reverse) → QueryRebinder (rebind the
    // floated column refs through each select's exposed columns) →
    // RedundantSubqueryRemover (collapse/merge the pass-through selects) →
    // ConditionsRewriter (boolean condition/value normalisation; SQL Server only —
    // Postgres has a native boolean type so its variant is a near no-op). Mirrors
    // the relevant slice of Signum's DbQueryProvider.Optimize. (UnusedColumnRemover
    // still pending.)
    bind(expression: Expression): ProjectionExpression {
        const simplified = expressionSimplifier()(expression);
        const connector = Connector.current();
        const binder = new QueryBinder(connector.schema, connector.isPostgres);
        let projection: Expression = binder.bindQuery(simplified);
        // Hoist deferred group aggregates (g.elements.sum()…) into their GROUP BY
        // select as columns — Signum runs AggregateRewriter first in Optimize.
        projection = AggregateRewriter.rewrite(projection);
        projection = OrderByRewriter.rewrite(projection);
        projection = QueryRebinder.rebind(projection);
        projection = RedundantSubqueryRemover.remove(projection, connector.isPostgres);
        if (!connector.isPostgres)
            projection = ConditionsRewriter.rewrite(projection);
        // SQL Server can't aggregate over a scalar subquery — lift those to OUTER
        // APPLYs (no-op on Postgres, which allows scalar subqueries in aggregates).
        projection = ScalarSubqueryRewriter.rewrite(projection, connector.isPostgres);
        if (!(projection instanceof ProjectionExpression))
            throw new Error("Optimiser pipeline did not preserve the ProjectionExpression");
        // Eager-load nested projections (e.g. map(l => …toArray())) as separate
        // child queries, then re-clean the selects the flattener introduced.
        const flattened = ChildProjectionFlattener.flatten(projection, binder.aliases);
        return RedundantSubqueryRemover.remove(flattened, connector.isPostgres) as ProjectionExpression;
    }

    execute(expression: Expression): Promise<unknown> {
        const projection = this.bind(expression);
        const tr = buildTranslateResult(projection, Connector.current().isPostgres);
        return tr.execute();
    }

    getQueryTextForDebug(query: Query<any>): string {
        const connector = Connector.current();
        const projection = this.bind(query.expression);
        const { sql, parameters } = QueryFormatter.format(projection.select, connector.isPostgres);
        return parameters.length ? `${sql}\n-- parameters: ${JSON.stringify(parameters)}` : sql;
    }
}

class TranslateResult {

    constructor(
        public query: string,
        public parameters: unknown[],
        public projector: (row: unknown) => unknown
    ) {

    }

    execute() {
        return Connector.current().executeQuery(this.query, this.parameters);
    }
}
