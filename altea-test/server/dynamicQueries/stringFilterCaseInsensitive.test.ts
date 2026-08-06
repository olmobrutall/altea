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
import { AlbumEntity } from "../../data/music";

// Case-insensitive string filters (Signum's FilterCondition.ToLowerString, ported into
// dynamicQuery/requests.ts). On a case-SENSITIVE backend (Postgres) a string comparison must lower BOTH
// sides so Contains / EqualTo / IsIn match regardless of case — matching SQL Server's default
// case-insensitive collation, which needs no lowering. These are SQL-generation tests: the marker is a
// `lower(` wrapping the string column (the nominator emits LOWER on both dialects; we compare lowercased).

const O = SubTokensOptionsAll;

const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb);
sb.complete();

class FakeConnector extends Connector {
    constructor(isPostgres: boolean) { super(sb.schema, isPostgres, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}
const pg = new FakeConnector(true);
const ss = new FakeConnector(false);

const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, O), new RootToken(AlbumEntity));

// Build the SQL for `<token> <op> <value>` under the given connector's dialect.
function filterSql(conn: FakeConnector, op: FilterOperation, value: unknown): string {
    return Connector.withConnector(conn, () => {
        const dq: DQueryable = table(AlbumEntity).toDQueryable()
            .where([new FilterCondition(tok("name"), op, value)])
            .select([tok("name")]);
        return QueryFormatter.format(dq.bindProjection().select, conn.isPostgres).sql.toLowerCase();
    });
}

describe("Postgres lowers both sides of a string filter (case-insensitive)", () => {
    test("Contains → lower(name) like lower(pattern)", () => {
        const s = filterSql(pg, FilterOperation.Contains, "Abc");
        assert.match(s, /lower\(/, "the string column should be wrapped in LOWER on Postgres");
        assert.doesNotMatch(s, /'%Abc%'/, "the pattern value should be lowercased, not kept as 'Abc'");
    });

    test("EqualTo → lower(name) = lowered value", () => {
        const s = filterSql(pg, FilterOperation.EqualTo, "Abc");
        assert.match(s, /lower\(/);
    });

    test("IsIn → lower(name) in (lowered values)", () => {
        const s = filterSql(pg, FilterOperation.IsIn, ["Abc", "DEF"]);
        assert.match(s, /lower\(/);
    });
});

describe("SQL Server does NOT lower (default case-insensitive collation)", () => {
    test("Contains keeps the raw column + value", () => {
        const s = filterSql(ss, FilterOperation.Contains, "Abc");
        assert.doesNotMatch(s, /lower\(/, "SQL Server must not lower — its default collation is case-insensitive");
    });

    test("EqualTo keeps the raw column + value", () => {
        const s = filterSql(ss, FilterOperation.EqualTo, "Abc");
        assert.doesNotMatch(s, /lower\(/);
    });
});
