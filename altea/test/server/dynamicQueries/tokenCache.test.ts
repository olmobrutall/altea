import { test, describe, beforeEach, afterAll, vi } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import "@altea/altea/server/dynamicQuery/tokenExpressions"; // register factories + expression prototypes
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { SubTokensOptionsAll, getSubTokens, setServerTokensProvider } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { isServerOnlyToken, serializeServerToken, type ServerTokenJson, type ExtensionTokenJson } from "@altea/altea/data/dynamicQuery/tokenSerializer";
import { Metadata } from "@altea/altea/data/metadata";
import { initTokenCache } from "@altea/altea/client/TokenCache";
import { isNotPart, type TypeInfo } from "@altea/altea/data/reflection";
import { MusicLogic } from "../MusicLogic";
import { ArtistEntity, AlbumEntity } from "../../data/music";
import { Entity } from "@altea/altea/data/entity";

// TokenCache reads Finder's expression settings, but Finder itself cannot load here (it pulls in the React
// components and their CSS) — so it is stood in for by the one member TokenCache reads, over a map the
// tests below fill (by key; the declaring type each lookup is asked about is recorded beside it).
const expressionSettings = vi.hoisted(() => new Map<string, { isVisibleForType?: (ti: TypeInfo) => boolean }>());
const lookups = vi.hoisted(() => [] as { declaringType: unknown; key: string }[]);
vi.mock("@altea/altea/client/Finder", () => ({
    Finder: {
        getExpressionSettings: (declaringType: unknown, key: string) => {
            lookups.push({ declaringType, key });
            return expressionSettings.get(key);
        },
    },
}));

// The CLIENT wiring: the server-only tokens (registered expressions) come out of the metadata blob and are
// rebuilt off the client's local parent; getSubTokens then merges them with the locally-generated metadata
// tokens.

const O = SubTokensOptionsAll;
const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb);
QueryLogic.expressions.register(ArtistEntity, (a: ArtistEntity) => a.albumCount(), { niceName: () => "Album Count" });
QueryLogic.expressions.register(ArtistEntity, (a: ArtistEntity) => a.name, { key: "artistName", niceName: () => "Artist Name" });
sb.complete();

// Artist's server-only tokens as the server serializes them — what its blob entry carries.
const serverJson = QueryLogic.getToken(ArtistEntity, "", O).subTokens(O).filter(isServerOnlyToken).map(serializeServerToken);

// NOTE: `Metadata.isApplied()` is one-way, so this must stay BEFORE the blocks that apply a blob.
describe("TokenCache before the metadata blob", () => {
    beforeEach(() => initTokenCache());

    // There is nothing to read yet, and an empty answer would look exactly like "this type has none".
    test("asking for sub-tokens is an error, not a silent empty list", async () => {
        await assert.rejects(getSubTokens(new RootToken(ArtistEntity), O), /before the metadata blob was applied/);
    });
});

describe("TokenCache (client-side server-token source)", () => {
    beforeEach(() => {
        // re-assert the wiring (another test in this file may have swapped the provider)
        initTokenCache();
        Metadata.apply({ culture: "en", types: {
            ArtistEntity: { kind: "Entity", fields: {}, extensions: Object.fromEntries(serverJson.map(j => [j.key, j])) },
        } as never });
    });

    test("getSubTokens merges the blob's server tokens with locally-generated metadata tokens", async () => {
        const localRoot = new RootToken(ArtistEntity);
        const keys = (await getSubTokens(localRoot, O)).map(t => t.key);

        // registered expressions, from the blob
        assert.ok(keys.includes("Albums"));
        assert.ok(keys.includes("AlbumCount"));
        assert.ok(keys.includes("artistName"));
        // locally-generated metadata tokens (never crossed the wire)
        assert.ok(keys.includes("ToString"));
        assert.ok(keys.includes("Id"));
    });

    test("the merged server tokens are real, navigable entities instances off the local parent", async () => {
        const localRoot = new RootToken(ArtistEntity);
        const albums = (await getSubTokens(localRoot, O)).find(t => t.key === "Albums")!;
        assert.equal(albums.parent, localRoot);          // hung off the caller's local parent
        assert.equal(albums.niceName(), "Albums");
        assert.equal(albums.fullKey(), "Albums");
        assert.ok(albums.subTokens(O).map(t => t.key).includes("Element")); // navigates locally
    });

    // keep the shared global provider from leaking into other suites
    afterAll(() => setServerTokensProvider(undefined));
});

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
        resultType: (serverJson[0] as ExtensionTokenJson).resultType, allowedReason: null,
    });

    beforeEach(() => {
        initTokenCache();
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

    // Finder's expression settings (`isVisibleForType`) are judged against the token's OWN type, where the
    // chain walk started.
    test("an expression's isVisibleForType leaves it off the types it rules out", async () => {
        applyExtensions({ Entity: [ext("OperationLogs", "Operation Logs"), ext("kept", "Kept")], ArtistEntity: [] });
        expressionSettings.set("OperationLogs", { isVisibleForType: ti => ti.ctor !== ArtistEntity });
        try {
            const artist = (await getSubTokens(new RootToken(ArtistEntity), O)).map(t => t.key);
            assert.ok(!artist.includes("OperationLogs"), `hidden on Artist, got ${artist}`);
            assert.ok(artist.includes("kept"));
            assert.ok((await getSubTokens(new RootToken(AlbumEntity), O)).some(t => t.key === "OperationLogs"),
                "a type the predicate accepts still gets it");
        } finally {
            expressionSettings.clear();
        }
    });

    test("isNotPart is what hides the Entity-level expressions on a part row", async () => {
        applyExtensions({ Entity: [ext("OperationLogs", "Operation Logs")], AlbumEntity: [] });
        expressionSettings.set("OperationLogs", { isVisibleForType: isNotPart });
        try {
            const songs = new RootToken(AlbumEntity).subToken("songs", O)!.subToken("Element", O)!;
            assert.ok(!(await getSubTokens(songs, O)).some(t => t.key === "OperationLogs"), "not on a song row");
            assert.ok((await getSubTokens(new RootToken(AlbumEntity), O)).some(t => t.key === "OperationLogs"));
        } finally {
            expressionSettings.clear();
        }
    });

    // Settings are looked up by the type the expression is DECLARED on — where the chain walk found it —
    // since two types may each declare an expression of the same key.
    test("settings are asked for by the expression's declaring type", async () => {
        applyExtensions({ Entity: [ext("OperationLogs", "Operation Logs")], ArtistEntity: [ext("artistOnly", "Artist Only")] });
        lookups.length = 0;
        await getSubTokens(new RootToken(ArtistEntity), O);
        assert.equal(lookups.find(l => l.key === "OperationLogs")?.declaringType, Entity);
        assert.equal(lookups.find(l => l.key === "artistOnly")?.declaringType, ArtistEntity);
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
