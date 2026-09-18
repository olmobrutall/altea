import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { reflect } from "@altea/altea/data/reflection";
import { Entity, type BaseEntity, type Type } from "@altea/altea/data/entity";
import { entity, fullTextIndex } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { table } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { DQueryable } from "@altea/altea/server/dynamicQuery/dQueryable";
import { FilterCondition, FilterGroup, FilterGroupOperationKeys, FilterOperationKeys } from "@altea/altea/server/dynamicQuery/requests";
import { SubTokensOptions, SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { FullTextRankToken, StringSnippetToken } from "@altea/altea/data/dynamicQuery/tokens/fullTextTokens";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { findSnippet } from "@altea/altea/server/dynamicQuery/snippet";
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { MusicLogic } from "../MusicLogic";
import { NoteWithDateEntity, AlbumEntity } from "../../data/music";

// Signum's FullTextRankToken / PgTsRankToken (Match Rank) and StringSnippetToken (Match Snippet).
// The rank is a real Postgres `ts_rank` over the query's own full-text filters and an explicit refusal
// on SQL Server; the snippet is provider-independent and computed over the fetched rows.

const O = SubTokensOptionsAll;

@reflect
@entity("Main", "Master")
@fullTextIndex<FtProbeEntity>(a => [a.shortTitle])
class FtProbeEntity extends Entity {
    // Indexed, but capped at 100 characters — Signum offers no Snippet for a column that short.
    @stringLengthValidator({ max: 100 })
    shortTitle: string;
}

function tokFrom(ctor: Type<BaseEntity>, path: string): any {
    let t: any = new RootToken(ctor);
    for (const step of path.split("."))
        t = t.subToken(step, O);
    return t;
}
const keysOf = (ctor: Type<BaseEntity>, path: string, options: SubTokensOptions = O): string[] =>
    (tokFrom(ctor, path) as any).subTokens(options).map((t: any) => t.key);

function fakeConnectorFor(isPostgres: boolean): Connector {
    const sb = new SchemaBuilder();
    sb.settings.isPostgres = isPostgres;
    MusicLogic.start(sb);
    sb.include(FtProbeEntity);
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

describe("full-text sub-token generation", () => {
    test("a full-text-indexed string offers Rank; an ordinary one does not", () => {
        assert.ok(keysOf(NoteWithDateEntity, "title").includes("Rank"));
        assert.ok(!keysOf(AlbumEntity, "name").includes("Rank"), "AlbumEntity.name carries no @fullTextIndex");
    });

    test("only a LONG text offers Snippet, and only when CanSnippet is on", () => {
        assert.ok(keysOf(NoteWithDateEntity, "text").includes("Snippet"), "unbounded @stringLengthValidator multiline");
        assert.ok(!keysOf(FtProbeEntity, "shortTitle").includes("Snippet"), "max 100 — Signum's Size > 200 rule");
        assert.ok(keysOf(FtProbeEntity, "shortTitle").includes("Rank"), "…but it IS indexed");
        assert.ok(!keysOf(NoteWithDateEntity, "text", O & ~SubTokensOptions.CanSnippet).includes("Snippet"));
    });

    test("a synthetic string token with no property route offers neither", () => {
        // ToString has no route (Signum's `route != null` guard), so no full-text tokens hang off it.
        const keys = keysOf(NoteWithDateEntity, "ToString");
        assert.ok(!keys.includes("Rank"));
        assert.ok(!keys.includes("Snippet"));
    });

    test("both captions are localizable messages", () => {
        const rank = tokFrom(NoteWithDateEntity, "title.Rank") as FullTextRankToken;
        assert.ok(rank instanceof FullTextRankToken);
        assert.equal(rank.toString(), "Match Rank");
        assert.equal(rank.niceName(), "Match Rank for Title");
        const snippet = tokFrom(NoteWithDateEntity, "text.Snippet") as StringSnippetToken;
        assert.ok(snippet instanceof StringSnippetToken);
        assert.equal(snippet.toString(), "Match Snippet");
        // Signum's own NiceName reads MatchSnippet (no placeholder) and drops the argument; altea uses
        // SnippetOf0, the message Signum declares for this and never calls.
        assert.equal(snippet.niceName(), "Snippet for Text");
    });
});

describe("MatchRank expression", () => {
    const titleToken = () => new RootToken(NoteWithDateEntity).subToken("title", O)!;
    const rankToken = () => titleToken().subToken("Rank", O)!;

    function sqlFor(connector: Connector, filters: any[]): string {
        return Connector.withConnector(connector, () => {
            const dq = (table(NoteWithDateEntity).toDQueryable() as DQueryable)
                .where(filters)
                .select([rankToken()]);
            return QueryFormatter.format(dq.bindProjection().select, connector.isPostgres).sql.toLowerCase();
        });
    }

    test("Postgres: ts_rank over the tsvector column and the filter's own tsquery", () => {
        const sql = sqlFor(fakeConnectorFor(true), [new FilterCondition(titleToken(), FilterOperationKeys.TsQuery, "american & band")]);
        assert.match(sql, /ts_rank\(/);
        assert.match(sql, /to_tsquery\(/);
    });

    test("Postgres: several full-text filters are ANDed into one tsquery", () => {
        const sql = sqlFor(fakeConnectorFor(true), [
            new FilterCondition(titleToken(), FilterOperationKeys.TsQuery_Plain, "american"),
            new FilterCondition(titleToken(), FilterOperationKeys.TsQuery_Plain, "band"),
        ]);
        assert.match(sql, /ts_rank\(/);
        assert.match(sql, /&&/, "tsquery && tsquery");
    });

    test("Postgres: an OR filter group combines the tsqueries with ||", () => {
        const sql = sqlFor(fakeConnectorFor(true), [new FilterGroup(FilterGroupOperationKeys.Or, undefined, [
            new FilterCondition(titleToken(), FilterOperationKeys.TsQuery_Plain, "american"),
            new FilterCondition(titleToken(), FilterOperationKeys.TsQuery_Plain, "band"),
        ])]);
        assert.match(sql, /ts_rank\(/);
        assert.match(sql, /\|\|/);
    });

    test("Postgres: no full-text filter ⇒ a constant 0, not a broken query (Signum's fallback)", () => {
        const sql = sqlFor(fakeConnectorFor(true), []);
        assert.doesNotMatch(sql, /ts_rank\(/);
    });

    test("SQL Server: refused with a message naming why, never a silently different number", () => {
        assert.throws(
            () => sqlFor(fakeConnectorFor(false), [new FilterCondition(titleToken(), FilterOperationKeys.FreeText, "american band")]),
            /only supported on PostgreSQL[\s\S]*CONTAINSTABLE/);
    });
});

describe("MatchSnippet", () => {
    test("the token SELECTS the text itself — the excerpt is computed after the query", () => {
        for (const isPostgres of [true, false]) {
            const connector = fakeConnectorFor(isPostgres);
            const sql = Connector.withConnector(connector, () => {
                const token = new RootToken(NoteWithDateEntity).subToken("text", O)!.subToken("Snippet", O)!;
                const dq = (table(NoteWithDateEntity).toDQueryable() as DQueryable).select([token]);
                return QueryFormatter.format(dq.bindProjection().select, isPostgres).sql.toLowerCase();
            });
            assert.match(sql, /text/);
        }
    });

    test("findSnippet picks the densest sentences and keeps document order", () => {
        const text = "Nothing here at all.\nThe american band played.\nAlso nothing.\nA band of note.";
        const out = findSnippet(text, new Set(["band"]), 300)!;
        assert.ok(out.includes("The american band played"));
        assert.ok(out.includes("A band of note"));
        assert.ok(out.indexOf("The american band played") < out.indexOf("A band of note"), "document order");
    });

    test("a gap between chosen sentences is marked, consecutive ones are joined", () => {
        const out = findSnippet("aa band\nbb band\ncc\ndd band", new Set(["band"]), 12)!;
        assert.ok(out.includes(". ") || out.includes(" (…) "), `no separator in ${JSON.stringify(out)}`);
    });

    test("applySnippets rewrites the column in place, using only the filters on its own token", async () => {
        const { DEnumerable } = await import("@altea/altea/server/dynamicQuery/dEnumerable");
        const { ParameterExpression } = await import("@altea/altea/server/linq/expressions");
        const { ClassType } = await import("@altea/altea/server/runtimeTypes");
        const { BuildExpressionContext, ExpressionBox } = await import("@altea/altea/server/dynamicQuery/tokenExpressions");
        const { applySnippets } = await import("@altea/altea/server/dynamicQuery/snippet");

        const param = new ParameterExpression("e", new ClassType(NoteWithDateEntity));
        const rows = [Object.assign(new NoteWithDateEntity(), { text: "Nothing here.\nThe american band played." })];
        const de = new DEnumerable(rows, new BuildExpressionContext(param.type, param, new Map([["", new ExpressionBox(param)]])));
        const textToken = new RootToken(NoteWithDateEntity).subToken("text", O)!;
        const snippetToken = textToken.subToken("Snippet", O)!;
        const rt = de.toResultTable([snippetToken]);
        assert.equal(rt.columns[0].values[0], "Nothing here.\nThe american band played.", "the raw text, before the pass");

        applySnippets(rt, [
            new FilterCondition(textToken, FilterOperationKeys.FreeText, "band"),
            // A filter on a DIFFERENT token must not contribute keywords.
            new FilterCondition(new RootToken(NoteWithDateEntity).subToken("title", O)!, FilterOperationKeys.Contains, "Nothing"),
        ]);
        // Sentence-split and rejoined by the snippet pass: the whole text fits in the 300-character
        // budget, so both sentences survive — in document order, consecutive ones joined by ". ".
        assert.equal(rt.columns[0].values[0], "Nothing here. The american band played");
    });

    test("with a budget too small for everything, the densest sentence is the one kept", () => {
        const out = findSnippet("Nothing here at all\nThe american band played", new Set(["band"]), 24)!;
        assert.ok(out.startsWith("The american band"), out);
    });

    test("null text stays null, and no keywords means no crash", () => {
        assert.equal(findSnippet(null, new Set(["x"]), 300), null);
        assert.equal(typeof findSnippet("one. two. three", new Set(), 300), "string");
    });
});

describe("Filter.getKeywords", () => {
    const titleToken = () => new RootToken(NoteWithDateEntity).subToken("title", O)!;
    const kw = (op: FilterOperationKeys, value: unknown): string[] => new FilterCondition(titleToken(), op, value).getKeywords();

    test("each full-text query language is split by its OWN operators", () => {
        assert.deepEqual(kw(FilterOperationKeys.TsQuery, "american & band | \"rock\""), ["american", "band", "rock"]);
        assert.deepEqual(kw(FilterOperationKeys.TsQuery_WebSearch, "american OR band -jazz"), ["american", "band", "jazz"]);
        assert.deepEqual(kw(FilterOperationKeys.FreeText, "american  band"), ["american", "band"]);
        assert.deepEqual(kw(FilterOperationKeys.ComplexCondition, "\"american\" AND band NOT jazz"), ["american", "band", "jazz"]);
        // Phrase / Plain are taken whole — they are not operator languages.
        assert.deepEqual(kw(FilterOperationKeys.TsQuery_Phrase, "american band"), ["american band"]);
    });

    test("an ordinary string filter contributes its value; a non-string one contributes nothing", () => {
        assert.deepEqual(kw(FilterOperationKeys.Contains, "band"), ["band"]);
        assert.deepEqual(kw(FilterOperationKeys.IsIn, ["a", "b"]), ["a", "b"]);
        assert.deepEqual(kw(FilterOperationKeys.GreaterThan, "band"), []);
        assert.deepEqual(kw(FilterOperationKeys.EqualTo, 3), []);
    });

    test("a group collects its children's keywords", () => {
        const g = new FilterGroup(FilterGroupOperationKeys.And, undefined, [
            new FilterCondition(titleToken(), FilterOperationKeys.Contains, "band"),
            new FilterCondition(titleToken(), FilterOperationKeys.FreeText, "american rock"),
        ]);
        assert.deepEqual(g.getKeywords(), ["band", "american", "rock"]);
    });
});
