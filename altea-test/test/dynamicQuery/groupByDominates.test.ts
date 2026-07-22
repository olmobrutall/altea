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
import { AggregateToken, AggregateFunction } from "@altea/altea/logic/dynamicQuery/tokens/aggregateToken";
import { DQueryable } from "@altea/altea/logic/dynamicQuery/dQueryable";
import "@altea/altea/logic/dynamicQuery/tokens/factories";
import { MusicLogic } from "../../logic/MusicLogic";
import { AlbumEntity } from "../../entities/music";

// Phase-5: GetRootKeyTokens / Dominates — a group key functionally determined by another (an
// ancestor via navigation) is dropped from the GROUP BY and recovered off the group's key.

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
const et = () => {
    return new RootToken(AlbumEntity);
};
const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, O), et());

describe("Dominates", () => {
    test("an ancestor via navigation dominates its descendant", () => {
        assert.equal(tok("label").dominates(tok("label.name")), true);
        assert.equal(tok("label.name").dominates(tok("label")), false);
    });

    test("domination stops at a collection boundary", () => {
        // Nothing above `songs.Element` dominates a token below it (crossing the collection).
        assert.equal(et().dominates(tok("songs.Element.name")), false);
        // But within the element scope, the element dominates its own property.
        assert.equal(tok("songs.Element").dominates(tok("songs.Element.name")), true);
    });

    test("unrelated tokens do not dominate", () => {
        assert.equal(tok("label").dominates(tok("year")), false);
    });
});

describe("GroupBy drops redundant keys", () => {
    test("group by label + label.name → GROUP BY only the label id", () => {
        const dq = DQueryable.fromEntity(table(AlbumEntity).elementType, table(AlbumEntity).expression)
            .groupBy([tok("label"), tok("label.name")], [new AggregateToken(AggregateFunction.Count, undefined, { queryName: AlbumEntity })]);
        const sql = Connector.withConnector(fake, () =>
            QueryFormatter.format(dq.select([tok("label.name")]).bindProjection().select, false).sql.replace(/\s+/g, " ").toLowerCase());
        // Only the root key (label id) is grouped; the redundant name is recovered by a join.
        assert.match(sql, /group by a\.labelid \)/);
        assert.doesNotMatch(sql, /group by [^)]*name/);
    });
});
