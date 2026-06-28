
import { Entity } from "../entities/entity";
import { CallExpression, ConstantExpression, Expression } from "./expressions";
import { asStaticFunction, IQueryTranslator, Query } from "./query";
import { ArrayType, FunctionType, ClassType, Type } from "../entities/types";
import { expressionSimplifier } from "./visitors/expressionSimplifier";
import { Connector } from "./connection/connector";
import { QueryBinder } from "./linq/queryBinder";
import { ProjectionExpression } from "./expressions.sql";
import { buildTranslateResult } from "./linq/translatorBuilder";
import { QueryFormatter } from "./linq/queryFormatter";



export function table<T extends Entity>(entityType: { new(): T }): Query<T> {
    var arrayType = new ArrayType(new ClassType(entityType));
    var callExpression = new CallExpression(
        new ConstantExpression(table, new FunctionType(table, arrayType)),
        [new ConstantExpression(entityType, new FunctionType(entityType, new ClassType(entityType)))],
        arrayType
    );
    return new Query<T>(callExpression, MyQueryTranslator.instance);
}

asStaticFunction(table).__resultType = (_, entityTypeType) => new ArrayType(new ClassType((entityTypeType as FunctionType).func!));

// Marks `table` as a query source so the QueryBinder recognises the
// `ConstantExpression(table)` at the root of a query CallExpression chain.
(table as unknown as { __isQuerySource?: boolean }).__isQuerySource = true;

class MyQueryTranslator implements IQueryTranslator {

    static instance: IQueryTranslator = new MyQueryTranslator();

    // Pipeline so far: simplify (partial eval) → QueryBinder (source AST →
    // DbExpression tree). Next steps add optimisers → QueryFormatter → reader.
    bind(expression: Expression): ProjectionExpression {
        const simplified = expressionSimplifier()(expression);
        const connector = Connector.current();
        const binder = new QueryBinder(connector.schema, connector.isPostgres);
        return binder.bindQuery(simplified);
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
