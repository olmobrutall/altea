import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import "@altea/altea/server/dynamicQuery/tokenExpressions"; // register factories + expression prototypes
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { SubTokensOptionsAll, getSubTokens, setServerTokensProvider } from "@altea/altea/entities/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/entities/dynamicQuery/tokens/rootToken";
import { isServerOnlyToken, serializeServerToken } from "@altea/altea/entities/dynamicQuery/tokenSerializer";
import { initQueryClient, setFetchServerTokens, clearServerTokenCache } from "@altea/altea/client/QueryClient";
import { MusicLogic } from "../../logic/MusicLogic";
import { ArtistEntity } from "../../entities/music";

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
        // re-assert the wiring (another test under --test-isolation=none may have swapped the provider)
        // and route the transport at the canned server JSON instead of a real ajax call.
        initQueryClient();
        clearServerTokenCache();
        setFetchServerTokens(async () => serverJson);
    });

    test("getSubTokens merges fetched server tokens with locally-generated metadata tokens", async () => {
        const localRoot = new RootToken(ArtistEntity);
        const keys = (await getSubTokens(localRoot, O)).map(t => t.key);

        // fetched-from-server (extension) tokens
        assert.ok(keys.includes("albums"));
        assert.ok(keys.includes("albumCount"));
        // locally-generated metadata tokens (never crossed the wire)
        assert.ok(keys.includes("ToString"));
        assert.ok(keys.includes("id"));
    });

    test("the merged server tokens are real, navigable entities instances off the local parent", async () => {
        const localRoot = new RootToken(ArtistEntity);
        const albums = (await getSubTokens(localRoot, O)).find(t => t.key === "albums")!;
        assert.equal(albums.parent, localRoot);          // hung off the caller's local parent
        assert.equal(albums.niceName(), "Albums");
        assert.ok(albums.subTokens(O).map(t => t.key).includes("Element")); // navigates locally
    });

    // keep the shared global provider from leaking the fake transport into other suites
    after(() => setServerTokensProvider(undefined));
});
