import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { table } from "@altea/altea/logic/table";
import { Connector } from "@altea/altea/logic/connection/connector";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { QueryFormatter } from "@altea/altea/logic/linq/queryFormatter";
import { ClassType } from "@altea/altea/entities/runtimeTypes";
import { Implementations } from "@altea/altea/entities/implementations";
import { SubTokensOptionsAll } from "@altea/altea/logic/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/logic/dynamicQuery/tokens/rootToken";
import { DQueryable } from "@altea/altea/logic/dynamicQuery/dQueryable";
import { DEnumerableCount } from "@altea/altea/logic/dynamicQuery/dEnumerable";
import { Column, Pagination } from "@altea/altea/logic/dynamicQuery/requests";
import "@altea/altea/logic/dynamicQuery/tokens/factories";
import { MusicLogic } from "../../logic/MusicLogic";
import { AlbumEntity } from "../../entities/music";

// Phase-5: SQL-side pagination + count (Signum's DQueryable.TryPaginate). Paginate → OFFSET/FETCH,
// a short page skips the COUNT, a full page runs COUNT(*).

const O = SubTokensOptionsAll;
const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb);
sb.complete();

// A connector that serves page rows for normal queries and a fixed total for COUNT queries, so the
// full-page → COUNT path is exercised DB-free.
class PagingConnector extends Connector {
    constructor(public pageRows: unknown[], public total: number) { super(sb.schema, false, 128); }
    override executeQuery(sql: string): Promise<unknown[]> {
        return Promise.resolve(/count\(\*\)/i.test(sql) ? [{ c0: this.total }] : this.pageRows);
    }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}

const et = () => {
    return new RootToken(AlbumEntity);
};
const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, O), et());
const base = () => {
    const q = table(AlbumEntity);
    return DQueryable.fromEntity(q.elementType, q.expression).select([tok("name"), tok("year")]);
};
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ c0: "n" + i, c1: i }));

describe("SQL-side pagination builds the right SQL", () => {
    const conn = new PagingConnector([], 0);
    const sql = (p: any) => QueryFormatter.format(p.select, false).sql.replace(/\s+/g, " ").toLowerCase();

    test("Paginate → OFFSET/FETCH", () => {
        const s = Connector.withConnector(conn, () => sql(base().tryPaginate(new Pagination.Paginate(10, 2)).bindProjection()));
        assert.match(s, /offset\s+10\s+rows\s+fetch\s+next\s+10\s+rows\s+only/);
    });

    test("count → SELECT COUNT(*)", () => {
        const s = Connector.withConnector(conn, () => sql(base().bindCountProjection()));
        assert.match(s, /count\(\*\)/);
    });
});

describe("tryPaginateAsync materialises page + total", () => {
    test("Firsts(n): page rows, total unknown", async () => {
        const conn = new PagingConnector(rows(3), 99);
        const de = await Connector.withConnector(conn, () => base().tryPaginateAsync(new Pagination.Firsts(3)));
        assert.ok(de instanceof DEnumerableCount);
        assert.equal(de.collection.length, 3);
        assert.equal(de.totalElements, undefined);
    });

    test("All: total = row count", async () => {
        const conn = new PagingConnector(rows(4), 99);
        const de = await Connector.withConnector(conn, () => base().tryPaginateAsync(new Pagination.All()));
        assert.equal(de.totalElements, 4);
    });

    test("Paginate short page → total from page, no COUNT query", async () => {
        let counted = false;
        const conn = new PagingConnector(rows(3), 99);
        const orig = conn.executeQuery.bind(conn);
        conn.executeQuery = (sql: string) => { if (/count\(\*\)/i.test(sql)) counted = true; return orig(sql); };
        // page 1, size 10, only 3 rows returned → end reached, total = 3.
        const de = await Connector.withConnector(conn, () => base().tryPaginateAsync(new Pagination.Paginate(10, 1)));
        assert.equal(de.collection.length, 3);
        assert.equal(de.totalElements, 3);
        assert.equal(counted, false, "a short page must not run a COUNT query");
    });

    test("Paginate full page → COUNT query supplies the total", async () => {
        const conn = new PagingConnector(rows(10), 42);
        // page 1, size 10, a full page → run COUNT → total 42.
        const de = await Connector.withConnector(conn, () => base().tryPaginateAsync(new Pagination.Paginate(10, 1)));
        assert.equal(de.collection.length, 10);
        assert.equal(de.totalElements, 42);
    });
});
