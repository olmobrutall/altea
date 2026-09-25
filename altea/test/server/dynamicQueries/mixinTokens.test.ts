import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { table } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { PropertyRouteType } from "@altea/altea/data/propertyRoute";
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { MusicLogic } from "../MusicLogic";
import { NoteWithDateEntity } from "../../data/note";

// Signum's EntityProperties lists a mixin's fields FLAT among the entity's own sub-tokens
// (`Note.Corrupt`, no mixin step in the key); the route and the expression go through the mixin.

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
const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, SubTokensOptionsAll), new RootToken(NoteWithDateEntity));

describe("Mixin tokens", () => {
    test("a mixin field is a flat sub-token whose route goes through the mixin", () => {
        const t = tok("Corrupt");
        assert.equal(t.fullKey(), "Corrupt");
        assert.equal(t.getPropertyRoute().parent.propertyRouteType, PropertyRouteType.Mixin);
    });

    test("it translates to the mixin's column", () => {
        const sql = Connector.withConnector(fake, () =>
            QueryFormatter.format(table(NoteWithDateEntity).toDQueryable().select([tok("Corrupt")]).bindProjection().select, false)
                .sql.replace(/\s+/g, " ").toLowerCase());
        assert.match(sql, /corrupt/);
    });
});
