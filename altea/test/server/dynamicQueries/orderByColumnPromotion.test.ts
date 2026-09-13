import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { table } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { Column, Order, OrderTypeKeys, Pagination, QueryRequest } from "@altea/altea/server/dynamicQuery/requests";
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { MusicLogic } from "../MusicLogic";
import { ArtistEntity } from "../../data/artist";

// Port of the three OrderByColumnPromoter cases Signum added to Signum.Test/DynamicQueries/
// DynamicQueryTest.cs (OrderAndColumnOnTheSameTokenShareTheSubQuery,
// OrderOnATokenThatIsNotAColumnIsTranslatedOnce, PaginateOrderingByASubQueryTranslatesItOnce).
//
// Signum has to EXECUTE each request and count the repetitions in what its Connector.CurrentLogger
// saw. altea can ask for the SQL directly — `allQueryOperations(request).bindProjection()` is the
// whole request pipeline (selectMany / where / orderBy / select / paginate) as a translated
// expression — so these run DB-free.
//
// `Entity.Albums.Count` is Signum's spelling; altea's tokens are ROOTLESS, so the same token is
// `Albums.Count` — a registered expression (MusicLogic's `withExpressionFrom(ArtistEntity,
// a => a.albums())`) followed by the collection's Count, i.e. a correlated COUNT(*) sub-query.

const O = SubTokensOptionsAll;
const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb);
sb.complete();

class FakeConnector extends Connector {
    constructor() { super(sb.schema, false, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}
const fake = new FakeConnector();

const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, O), new RootToken(ArtistEntity));

function sqlOf(request: QueryRequest): string {
    return Connector.withConnector(fake, () => {
        const dq = table(ArtistEntity).toDQueryable().allQueryOperations(request);
        return QueryFormatter.format(dq.bindProjection().select, false).sql;
    });
}

const countRepetitions = (text: string, search: string) => text.split(search).length - 1;

describe("OrderByColumnPromoter over a QueryRequest", () => {

    // Ordering and showing the same token (Albums.Count → a correlated sub-query) used to translate
    // it twice: the paginated select needs it for its own ORDER BY and the outer select needs it
    // again for the ordering the OrderByRewriter floated up.
    test("OrderAndColumnOnTheSameTokenShareTheSubQuery", () => {
        const count = tok("Albums.Count");

        const sql = sqlOf(new QueryRequest(ArtistEntity, [],
            [new Order(count, OrderTypeKeys.Descending)],
            [new Column(tok("Name")), new Column(count)],
            new Pagination.Firsts(20)));

        assert.equal(countRepetitions(sql, "COUNT(*)"), 1, sql);
        assert.equal(countRepetitions(sql, "ORDER BY"), 1, sql);
    });

    // Ordering by (but not showing) Albums.Count: the sub-query is not among the columns, so it has
    // to be ADDED to the inner select and read back from there rather than repeated per level.
    test("OrderOnATokenThatIsNotAColumnIsTranslatedOnce", () => {
        const sql = sqlOf(new QueryRequest(ArtistEntity, [],
            [new Order(tok("Albums.Count"), OrderTypeKeys.Ascending)],
            [new Column(tok("Id")), new Column(tok("Name"))],
            new Pagination.Firsts(20)));

        assert.equal(countRepetitions(sql, "COUNT(*)"), 1, sql);
        assert.equal(countRepetitions(sql, "ORDER BY"), 1, sql);
    });

    // Paginating adds the OFFSET (Signum: a ROW_NUMBER window) on top of the same orderings.
    test("PaginateOrderingByASubQueryTranslatesItOnce", () => {
        const count = tok("Albums.Count");

        const sql = sqlOf(new QueryRequest(ArtistEntity, [],
            [new Order(count, OrderTypeKeys.Descending)],
            [new Column(tok("Name")), new Column(count)],
            new Pagination.Paginate(20, 2)));

        assert.equal(countRepetitions(sql, "COUNT(*)"), 1, sql);
        assert.match(sql, /OFFSET/i);
    });
});
