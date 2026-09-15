import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { table, bindAndOptimize, loadedTypeCaches } from "@altea/altea/server/table";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { Connector } from "@altea/altea/server/connection/connector";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import type { ProjectionExpression } from "@altea/altea/server/linq/expressions.sql";
import { seedTypeCachesForTest } from "../seedTypeCaches";
import {
    ProbeOrderEntity, ProbeSingleOrderEntity, ProbeCompanyEntity, ProbePersonEntity,
} from "../../data/ibEmbeddedProbe";

// Regression: navigating THROUGH an `@implementedBy` reference INTO an embedded and out to one of its
// members — `order.customer.address.country`, the shape behind a Southwind chart grouped by
// "Customer.Address.Country" — threw
//
//     Cannot bind member 'country' on CASE WHEN … THEN new { … country = p.address_country } …
//
// Dispatching `.address` over the IB produced a CASE whose branches were whole EMBEDDED objects, and
// the next member access had nothing to bind on. The combination has to be pushed INSIDE the embedded
// instead (Signum's CombineImplementations does this): one combined binding per field, so the result
// is a single embedded expression whose `country` is a CASE over the two columns.
//
// Binds offline with a fake connector — no database, no table of its own in any suite's DB.

class FakeConnector extends Connector {
    constructor(schema: any, isPostgres = false) { super(schema, isPostgres, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}

const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
sb.include(ProbeCompanyEntity);
sb.include(ProbePersonEntity);
sb.include(ProbeOrderEntity);
sb.include(ProbeSingleOrderEntity);
sb.complete();
seedTypeCachesForTest(sb.schema);

const fake = new FakeConnector(sb.schema);

function bind(query: { expression: any }): ProjectionExpression {
    return Connector.withConnector(fake, () => bindAndOptimize(query.expression, sb.schema, false, false, loadedTypeCaches(sb.schema)));
}

function sqlOf(query: { expression: any }): string {
    return QueryFormatter.format(bind(query).select, false).sql;
}

describe("member of an embedded reached through an @implementedBy reference", () => {

    test("selects a scalar member of the embedded (customer.address.country)", () => {
        const sql = sqlOf(table(ProbeOrderEntity).map(o => o.customer.address.country));

        // One CASE picking the country column of whichever implementation the row points at.
        assert.match(sql, /CASE/i, "the two implementations are combined with a CASE");
        assert.match(sql, /address_country/i, "the embedded's country column is read");
        assert.equal((sql.match(/address_country/gi) ?? []).length, 2, "one country column per implementation");
        assert.doesNotMatch(sql, /address_street/i, "unrelated members of the embedded are not read");
    });

    test("selects two members of the same embedded", () => {
        const sql = sqlOf(table(ProbeOrderEntity).map(o => ({
            city: o.customer.address.city,
            country: o.customer.address.country,
        })));

        assert.match(sql, /address_city/i);
        assert.match(sql, /address_country/i);
    });

    test("filters on a member of the embedded", () => {
        const sql = sqlOf(table(ProbeOrderEntity)
            .filter(o => o.customer.address.country == "UK")
            .map(o => o.id));

        assert.match(sql, /WHERE/i);
        assert.match(sql, /address_country/i);
    });

    test("groups by a member of the embedded", () => {
        const sql = sqlOf(table(ProbeOrderEntity)
            .groupBy(o => o.customer.address.country)
            .map(g => ({ country: g.key, count: g.elements.length })));

        assert.match(sql, /GROUP BY/i);
        assert.match(sql, /address_country/i);
    });

    test("a single-implementation @implementedBy takes the short-circuit and still binds", () => {
        const sql = sqlOf(table(ProbeSingleOrderEntity).map(o => o.customer.address.country));

        assert.match(sql, /address_country/i);
        assert.doesNotMatch(sql, /CASE/i, "one implementation needs no CASE");
    });
});
