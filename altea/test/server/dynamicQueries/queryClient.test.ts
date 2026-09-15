import { test, describe, beforeEach, afterAll } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import "@altea/altea/server/dynamicQuery/tokenExpressions"; // register factories + expression prototypes
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { SubTokensOptionsAll, getSubTokens, setServerTokensProvider, canHaveServerOnlyTokens } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { isServerOnlyToken, serializeServerToken } from "@altea/altea/data/dynamicQuery/tokenSerializer";
import { initQueryClient, setFetchServerTokens, clearServerTokenCache } from "@altea/altea/client/QueryClient";
import { MusicLogic } from "../MusicLogic";
import { ArtistEntity } from "../../data/music";

// Phase 2 — the CLIENT wiring: setServerTokensProvider fetches the server-only tokens (via an
// injectable transport, here faked with the server's own serialized output) and rebuilds them off the
// client's local parent; getSubTokens then merges them with the locally-generated metadata tokens.

const O = SubTokensOptionsAll;
const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb);
QueryLogic.expressions.register(ArtistEntity, (a: ArtistEntity) => a.albumCount(), { niceName: () => "Album Count" });
QueryLogic.expressions.register(ArtistEntity, (a: ArtistEntity) => a.name, { key: "artistName", niceName: () => "Artist Name" });
sb.complete();

// The JSON the server would return for Artist's server-only tokens (produced by the server path).
const serverJson = QueryLogic.getToken(ArtistEntity, "", O).subTokens(O).filter(isServerOnlyToken).map(serializeServerToken);

describe("QueryClient (client-side server-token source)", () => {
    beforeEach(() => {
        // re-assert the wiring (another test in this file may have swapped the provider)
        // and route the transport at the canned server JSON instead of a real ajax call.
        initQueryClient();
        clearServerTokenCache();
        setFetchServerTokens(async () => serverJson);
    });

    test("getSubTokens merges fetched server tokens with locally-generated metadata tokens", async () => {
        const localRoot = new RootToken(ArtistEntity);
        const keys = (await getSubTokens(localRoot, O)).map(t => t.key);

        // fetched-from-server (extension) tokens
        assert.ok(keys.includes("Albums"));
        assert.ok(keys.includes("AlbumCount"));
        // locally-generated metadata tokens (never crossed the wire)
        assert.ok(keys.includes("ToString"));
        assert.ok(keys.includes("Id"));
    });

    test("the merged server tokens are real, navigable entities instances off the local parent", async () => {
        const localRoot = new RootToken(ArtistEntity);
        const albums = (await getSubTokens(localRoot, O)).find(t => t.key === "Albums")!;
        assert.equal(albums.parent, localRoot);          // hung off the caller's local parent
        assert.equal(albums.niceName(), "Albums");
        assert.ok(albums.subTokens(O).map(t => t.key).includes("Element")); // navigates locally
    });

    // A parent that can only ever answer `[]` must not be ASKED. A token picker expands a whole level
    // at once, so the wasted requests came a dozen at a time; the rule the client skips on is the same
    // `canHaveServerOnlyTokens` the server's getExtensionsTokens returns on, so the two cannot drift.
    test("does not fetch for a parent that can carry no server-only tokens", async () => {
        const asked: string[] = [];
        setFetchServerTokens(async (_qk, tokenFullKey) => { asked.push(tokenFullKey); return serverJson; });

        const localRoot = new RootToken(ArtistEntity);
        const subs = await getSubTokens(localRoot, O);
        asked.length = 0; // the root itself IS an entity token and is legitimately asked

        // a raw COLLECTION nav: its element type's expressions belong on .Element / .Any, never here
        const albums = subs.find(t => t.key === "Albums")!;
        assert.equal((await getSubTokens(albums, O)).length > 0, true);

        // a value token: no entity type, so no expression can be registered against it
        const name = subs.find(t => t.key === "Name")!;
        await getSubTokens(name, O);

        assert.deepEqual(asked, [], "neither parent should have crossed the wire");

        // the ELEMENT of that same collection is an entity token and IS asked — the skip is a rule
        // about the parent's shape, not a blanket suppression.
        const element = (await getSubTokens(albums, O)).find(t => t.key === "Element")!;
        await getSubTokens(element, O);
        assert.deepEqual(asked, [element.fullKey()]);
    });

    test("canHaveServerOnlyTokens agrees with the server for every token of a level", async () => {
        const root = QueryLogic.getToken(ArtistEntity, "", O);
        for (const t of root.subTokens(O)) {
            const serverAnswer = QueryLogic.expressions.getExtensionsTokens(t).length > 0;
            if (serverAnswer)
                assert.ok(canHaveServerOnlyTokens(t), `${t.fullKey()} has extensions but the client would skip it`);
        }
    });

    // keep the shared global provider from leaking the fake transport into other suites
    afterAll(() => setServerTokensProvider(undefined));
});
