import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { table } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { DQueryable } from "@altea/altea/server/dynamicQuery/dQueryable";
import { FilterCondition, FilterOperation } from "@altea/altea/server/dynamicQuery/requests";
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { MusicLogic } from "../MusicLogic";
import { NoteWithDateEntity } from "../../data/music";

// Full-text dynamic-query FilterOperations (Signum's FilterFullText): the client SearchControl adds
// a FreeText / TsQuery filter on a full-text token, and the server lowers it to the dialect's
// predicate. Verified by formatting the generated SQL (no DB needed — a FakeConnector per dialect).

const O = SubTokensOptionsAll;

function fakeConnectorFor(isPostgres: boolean): Connector {
    const sb = new SchemaBuilder();
    sb.settings.isPostgres = isPostgres;
    MusicLogic.start(sb);
    sb.complete();
    class FakeConnector extends Connector {
        constructor() { super(sb.schema, isPostgres, 128); }
        override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
        openConnection(): Promise<any> { throw new Error("not used"); }
        closeConnection(): Promise<void> { return Promise.resolve(); }
        cleanDatabase(): Promise<void> { return Promise.resolve(); }
    }
    return new FakeConnector();
}

const titleToken = () => new RootToken(NoteWithDateEntity).subToken("title", O)!;
const sqlFor = (connector: Connector, op: FilterOperation, value: string): string =>
    Connector.withConnector(connector, () => {
        const dq = table(NoteWithDateEntity).toDQueryable()
            .where([new FilterCondition(titleToken(), op, value)])
            .select([titleToken()]);
        return QueryFormatter.format(dq.bindProjection().select, connector.isPostgres).sql.toLowerCase();
    });

describe("FullText dynamic-query filters", () => {
    test("SQL Server FreeText → FREETEXT predicate", () => {
        const sql = sqlFor(fakeConnectorFor(false), FilterOperation.FreeText, "American band");
        assert.match(sql, /freetext\(/);
    });

    test("SQL Server ComplexCondition → CONTAINS predicate", () => {
        const sql = sqlFor(fakeConnectorFor(false), FilterOperation.ComplexCondition, "american AND band");
        assert.match(sql, /contains\(/);
    });

    test("Postgres TsQuery → tsvector @@ to_tsquery", () => {
        const sql = sqlFor(fakeConnectorFor(true), FilterOperation.TsQuery, "american & band");
        assert.match(sql, /@@ to_tsquery\(/);
    });

    test("Postgres TsQuery_Plain → @@ plainto_tsquery", () => {
        const sql = sqlFor(fakeConnectorFor(true), FilterOperation.TsQuery_Plain, "american band");
        assert.match(sql, /@@ plainto_tsquery\(/);
    });

    test("Postgres TsQuery_WebSearch → @@ websearch_to_tsquery", () => {
        const sql = sqlFor(fakeConnectorFor(true), FilterOperation.TsQuery_WebSearch, "american band");
        assert.match(sql, /@@ websearch_to_tsquery\(/);
    });
});
