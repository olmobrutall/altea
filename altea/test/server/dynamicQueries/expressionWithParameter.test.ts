import { test, describe, beforeAll } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { IndexerContainerToken, ExtensionWithParameterToken } from "@altea/altea/data/dynamicQuery/tokens/indexerToken";
import { splitTokenKey, parentTokenKey } from "@altea/altea/data/dynamicQuery/tokens/tokenKey";
import { serializeServerToken, deserializeServerToken } from "@altea/altea/data/dynamicQuery/tokenSerializer";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { Column, QueryRequest } from "@altea/altea/server/dynamicQuery/requests";
import { Enum } from "@altea/altea/data/enum";
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { hasDb, start } from "../setup";
import { table } from "@altea/altea/server/table";
import { ArtistEntity, Sex } from "../../data/music";

// Signum's RegisterWithParameter: a `[Prefix]` container whose children are one per key the registration
// lists at runtime, each evaluating the expression with that key. The key text is the key's toString().
//
// Registered at module level: the transformer stamps a Quoted argument where it is written.
QueryLogic.expressions.registerWithParameter(ArtistEntity, "string",
    (a: ArtistEntity, prefix: string) => a.name.startsWith(prefix),
    () => ["Michael", "Sm", "M. J"],
    { prefix: "StartsWith", niceName: () => "Starts with" });

QueryLogic.expressions.registerWithParameter(ArtistEntity, Sex,
    (a: ArtistEntity, sex: Sex) => a.sex == sex,
    () => Enum.values(Sex) as unknown as Sex[],
    { prefix: "IsSex", niceName: () => "Is sex" });

// An ENTITY key (ReNew's `[Skill].[Java]`): the keys come from a list warmed before use, as a cache's would.
let artists: ArtistEntity[] = [];
QueryLogic.expressions.registerWithParameter(ArtistEntity, ArtistEntity,
    (a: ArtistEntity, other: ArtistEntity) => a.is(other),
    () => artists,
    { prefix: "IsArtist", niceName: () => "Is artist" });

const O = SubTokensOptionsAll;

describe("splitTokenKey", () => {
    test("a '.' inside brackets stays in its part", () => {
        assert.deepEqual(splitTokenKey("Friends.Element.[StartsWith].[M. J]"), ["Friends", "Element", "[StartsWith]", "[M. J]"]);
        assert.equal(parentTokenKey("[StartsWith].[M. J]"), "[StartsWith]");
        assert.equal(parentTokenKey("Name"), null);
    });
});

describe.skipIf(!hasDb)("expressions with a parameter", () => {
    beforeAll(async () => {
        await start();
        artists = await table(ArtistEntity).toArray() as ArtistEntity[];
    });

    test("the container lists one child per key, keyed by its text", () => {
        const container = QueryLogic.getToken(ArtistEntity, "[StartsWith]", O);
        assert.ok(container instanceof IndexerContainerToken);
        assert.equal(container.toString(), "[Starts with]");
        assert.deepEqual(container.subTokens(O).map(t => t.key).sort(), ["[M. J]", "[Michael]", "[Sm]"]);

        const sexes = QueryLogic.getToken(ArtistEntity, "[IsSex]", O).subTokens(O);
        assert.deepEqual(sexes.map(t => t.key).sort(), ["[Female]", "[Male]", "[Undefined]"]);
    });

    test("a stored token resolves, a '.' in the key included", () => {
        const child = QueryLogic.getToken(ArtistEntity, "[StartsWith].[M. J]", O);
        assert.ok(child instanceof ExtensionWithParameterToken);
        assert.equal(child.fullKey(), "[StartsWith].[M. J]");
        assert.equal(child.type.typeName, "Boolean");
    });

    test("a column evaluates the expression with its key", async () => {
        const request = new QueryRequest(ArtistEntity, [], [], [
            new Column(QueryLogic.getToken(ArtistEntity, "Name", O)),
            new Column(QueryLogic.getToken(ArtistEntity, "[StartsWith].[Michael]", O)),
            new Column(QueryLogic.getToken(ArtistEntity, "[IsSex].[Male]", O)),
        ]);
        const rt = await QueryLogic.queries.executeQueryAsync(request);
        const michael = rt.rows.find(r => r.value(0) === "Michael Jackson");
        assert.ok(michael, "the seeded artist is there");
        assert.equal(michael!.value(1), true);
        assert.equal(michael!.value(2), true);
        assert.ok(rt.rows.some(r => r.value(1) === false), "and one that does not start with it");
    });

    test("an entity key is its toString, and compares by identity in SQL", async () => {
        const keys = QueryLogic.getToken(ArtistEntity, "[IsArtist]", O).subTokens(O).map(t => t.key);
        assert.ok(keys.includes("[Michael Jackson]"));

        const request = new QueryRequest(ArtistEntity, [], [], [
            new Column(QueryLogic.getToken(ArtistEntity, "Name", O)),
            new Column(QueryLogic.getToken(ArtistEntity, "[IsArtist].[Michael Jackson]", O)),
        ]);
        const rt = await QueryLogic.queries.executeQueryAsync(request);
        assert.deepEqual(rt.rows.filter(r => r.value(1) === true).map(r => r.value(0)), ["Michael Jackson"]);
    });

    test("the wire form rebuilds the same tokens on the other side", () => {
        const container = QueryLogic.getToken(ArtistEntity, "[IsSex]", O) as IndexerContainerToken;
        const root = QueryLogic.getToken(ArtistEntity, "", O);
        const rebuilt = deserializeServerToken(serializeServerToken(container), root) as IndexerContainerToken;
        assert.equal(rebuilt.fullKey(), "[IsSex]");

        const male = container.subTokens(O).find(t => t.key === "[Male]")!;
        const rebuiltMale = deserializeServerToken(serializeServerToken(male), rebuilt);
        assert.equal(rebuiltMale.fullKey(), "[IsSex].[Male]");
        assert.equal(rebuiltMale.niceName(), Enum.niceName(Sex, "Male" as never));
    });
});
