import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { table, bindAndOptimize } from "@altea/altea/logic/table";
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

// RedundantJoinRemover: two references to the same entity via different paths (toLite display model
// vs direct navigation) must produce ONE join, not two identical ones.

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
const labelJoins = (sql: string) => (sql.replace(/\s+/g, " ").match(/join dbo\.label /gi) ?? []).length;
// Joins whose owner side is the album's LabelID FK (distinguishes the label reference from
// label.owner, a separate self-referential join on OwnerID).
const albumLabelJoins = (sql: string) => (sql.replace(/\s+/g, " ").match(/a\.labelid = /gi) ?? []).length;

describe("RedundantJoinRemover", () => {
    // The DynamicQuery shape: reference columns project as lites (buildLite → toLite), whose display
    // model navigates the label for its ToStr — the same join `a.label.name` needs.
    test("plain: { lbl: a.label.toLite(), nm: a.label.name } → one Label join", () => {
        const proj = Connector.withConnector(fake, () =>
            bindAndOptimize(table(AlbumEntity).map(a => ({ lbl: a.label.toLite(), nm: a.label.name })).expression, sb.schema, false));
        const sql = QueryFormatter.format(proj.select, false).sql;
        assert.equal(labelJoins(sql), 1);
        assert.match(sql.replace(/\s+/g, " "), /label/i);
    });

    test("grouped: group by label + label.name → one Label join", () => {
        const et = () => {
            return new RootToken(AlbumEntity);
        };
        const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, O), et());
        const sql = Connector.withConnector(fake, () => {
            const dq = DQueryable.fromEntity(table(AlbumEntity).elementType, table(AlbumEntity).expression)
                .groupBy([tok("label"), tok("label.name")], [new AggregateToken(AggregateFunction.Count, undefined, { queryName: AlbumEntity })])
                .select([tok("label"), tok("label.name")]);
            return QueryFormatter.format(dq.bindProjection().select, false).sql;
        });
        assert.equal(labelJoins(sql), 1);
    });

    test("bare full-entity projection: { lbl: a.label, nm: a.label.name } → one join on the album's label FK", () => {
        // Projecting the full label entity eager-expands it (its columns + its own references), and
        // a.label.name navigates it too. The completion join on the album's LabelID must be shared —
        // exactly one — even though the expansion adds a SEPARATE join for label.owner (on OwnerID).
        const proj = Connector.withConnector(fake, () =>
            bindAndOptimize(table(AlbumEntity).map(a => ({ lbl: a.label, nm: a.label.name })).expression, sb.schema, false));
        const sql = QueryFormatter.format(proj.select, false).sql;
        assert.equal(albumLabelJoins(sql), 1);                              // one join on A.LabelID
        assert.match(sql.replace(/\s+/g, " ").toLowerCase(), /\.ownerid = /); // label.owner is a distinct join
    });

    test("distinct references still keep separate joins (label vs country)", () => {
        // label and label.country are different tables → two joins, not merged.
        const proj = Connector.withConnector(fake, () =>
            bindAndOptimize(table(AlbumEntity).map(a => ({ n: a.label.name, c: a.label.country.name })).expression, sb.schema, false));
        const sql = QueryFormatter.format(proj.select, false).sql.replace(/\s+/g, " ").toLowerCase();
        assert.equal(labelJoins(sql), 1);        // label joined once
        assert.match(sql, /join dbo\.country/);  // country joined separately
    });
});
