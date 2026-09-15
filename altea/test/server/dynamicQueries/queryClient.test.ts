import { test, describe, beforeEach, afterAll } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import "@altea/altea/server/dynamicQuery/tokenExpressions"; // register factories + expression prototypes
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { SubTokensOptionsAll, getSubTokens, setServerTokensProvider } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { isServerOnlyToken, serializeServerToken, type ServerTokenJson } from "@altea/altea/data/dynamicQuery/tokenSerializer";
import { Metadata } from "@altea/altea/data/metadata";
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

    // keep the shared global provider from leaking the fake transport into other suites
    afterAll(() => setServerTokensProvider(undefined));
});

// NOTE: this block APPLIES a metadata blob, and `Metadata.isApplied()` is one-way — so it must stay
// AFTER the block above, which exercises the pre-blob fetch path.
//
// An expression is registered against a TYPE, so the answer rides in the metadata blob the client already
// holds — once, on the type that DECLARES it — instead of costing a request per TOKEN of that type. This
// is the same inheritance the operations section gets, over the same chain.
describe("extension tokens resolved from the metadata blob", () => {

    const extensionsOf = (types: string[]): Record<string, Record<string, unknown>> =>
        Object.fromEntries(types.map(t => [t, { kind: "Entity", fields: {}, extensions: {} as Record<string, unknown> }]));

    function applyExtensions(byType: Record<string, ServerTokenJson[]>): void {
        const types = extensionsOf(Object.keys(byType));
        for (const [typeName, list] of Object.entries(byType))
            for (const ext of list)
                (types[typeName]!.extensions as Record<string, unknown>)[ext.key] = ext;
        Metadata.apply({ culture: "en", types: types as never });
    }

    const ext = (key: string, niceName: string): ServerTokenJson => ({
        tokenType: "Extension", key, niceName, isProjection: false,
        resultType: serverJson[0]!.resultType, allowedReason: null,
    });

    beforeEach(() => {
        initQueryClient();
        clearServerTokenCache();
        
        setFetchServerTokens(async () => { throw new Error("must not reach the server"); });
    });

    test("a token reads its own type's extensions with no request", async () => {
        applyExtensions({ ArtistEntity: [ext("artistOnly", "Artist Only")] });
        const keys = (await getSubTokens(new RootToken(ArtistEntity), O)).map(t => t.key);
        assert.ok(keys.includes("artistOnly"));
        assert.ok(keys.includes("Id"), "local metadata tokens are still merged in");
    });

    // The shape that made the blob worth using: Alerts / Notes / OperationLogs / SystemValidFrom are
    // registered on `Entity`, so every entity inherits them from one entry.
    test("an expression declared on Entity reaches every entity", async () => {
        applyExtensions({ Entity: [ext("operationLogs", "Operation Logs")], ArtistEntity: [] });
        const artist = (await getSubTokens(new RootToken(ArtistEntity), O)).find(t => t.key === "operationLogs");
        assert.ok(artist, "inherited from Entity");
        assert.equal(artist!.niceName(), "Operation Logs");
    });

    test("the nearest declaring type wins on a key collision", async () => {
        applyExtensions({
            Entity: [ext("shared", "from base")],
            ArtistEntity: [ext("shared", "from subtype")],
        });
        const found = (await getSubTokens(new RootToken(ArtistEntity), O)).filter(t => t.key === "shared");
        assert.equal(found.length, 1, "not offered twice");
        assert.equal(found[0]!.niceName(), "from subtype");
    });

    // Signum's rule, and the server's first guard: an expression on the ELEMENT type surfaces under
    // `.Element` / `.Any`, never on the raw collection navigation.
    test("a raw collection navigation gets none of its element type's extensions", async () => {
        applyExtensions({ Entity: [ext("operationLogs", "Operation Logs")], ArtistEntity: [] });
        const friends = (await getSubTokens(new RootToken(ArtistEntity), O)).find(t => t.key === "Friends")!;
        assert.ok(friends, "the collection is reachable");
        assert.deepEqual((await getSubTokens(friends, O)).filter(t => t.key === "operationLogs"), []);
    });

    afterAll(() => setServerTokensProvider(undefined));
});
