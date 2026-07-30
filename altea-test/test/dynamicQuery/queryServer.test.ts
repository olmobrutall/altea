import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import "@altea/altea/server/dynamicQuery/tokenExpressions"; // register factories + install expression prototypes
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { SubTokensOptionsAll } from "@altea/altea/entities/dynamicQuery/tokens/queryToken";
import { ExtensionToken } from "@altea/altea/entities/dynamicQuery/tokens/extensionToken";
import { isServerOnlyToken, serializeServerToken, deserializeServerToken } from "@altea/altea/entities/dynamicQuery/tokenSerializer";
import { WebBuilder } from "@altea/altea/server/webApi";
import { QueryServer } from "@altea/altea/server/queryServer";
import { MusicLogic } from "../../logic/MusicLogic";
import { ArtistEntity } from "../../entities/music";

// Phase 2 — the server endpoint that ships the SERVER-ONLY sub-tokens (extensions) the client can't
// compute locally. Driven through the real WebBuilder + real handler via a fake Express app (records
// the wrapped handler), then invoked with a fake req/res — full coverage without opening a socket.

const O = SubTokensOptionsAll;
const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb); // registers Album.withExpressionFrom(Artist, a => a.albums()) → `albums` on Artist
QueryLogic.expressions.register(ArtistEntity, (a: ArtistEntity) => a.albumCount(), { niceName: () => "Album Count" });
QueryLogic.expressions.register(ArtistEntity, (a: ArtistEntity) => a.name, { key: "artistName", niceName: () => "Artist Name" });
sb.complete();

// A minimal Express stand-in that records each route's final (wrapped) handler by path.
function fakeWebBuilder(): { ws: WebBuilder; routes: Record<string, Function> } {
    const routes: Record<string, Function> = {};
    const app = {
        get: (path: string, ...handlers: Function[]) => { routes["GET " + path] = handlers[handlers.length - 1]; },
        post() { }, put() { }, delete() { }, patch() { }, use() { },
    };
    return { ws: new WebBuilder(app as never), routes };
}

// Invoke a recorded (wrapped) handler with a fake req/res; resolves with whatever res.json received.
function invoke(handler: Function, params: Record<string, string>, query: Record<string, string>): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let statusCode = 200;
        const res: Record<string, unknown> = {
            json: (x: unknown) => { statusCode === 200 ? resolve(x) : reject(new Error(`status ${statusCode}: ${JSON.stringify(x)}`)); return res; },
            status: (c: number) => { statusCode = c; return res; },
            type: () => res, send: () => res, end: () => res,
        };
        handler({ params, query }, res, (err: unknown) => reject(err ?? new Error("next() called")));
    });
}

describe("QueryServer /api/query/:queryKey/serverTokens", () => {
    test("registers the GET route", () => {
        const { ws, routes } = fakeWebBuilder();
        QueryServer.start(ws);
        assert.ok(routes["GET /api/query/:queryKey/serverTokens"] != undefined);
    });

    test("returns exactly the server-only (extension) sub-tokens, serialized", async () => {
        const { ws, routes } = fakeWebBuilder();
        QueryServer.start(ws);
        const handler = routes["GET /api/query/:queryKey/serverTokens"];

        const body = await invoke(handler, { queryKey: "Artist" }, {}) as { key: string; niceName: string }[];
        const keys = body.map(t => t.key);
        // the registered extensions on Artist (metadata tokens like id/ToString/name are NOT here —
        // the client generates those locally)
        assert.ok(keys.includes("albums"));
        assert.ok(keys.includes("albumCount"));
        assert.ok(keys.includes("artistName"));
        // no metadata token leaked in
        assert.ok(!keys.includes("ToString"));
    });

    test("the returned JSON rebuilds into a working ExtensionToken on the client's local parent", async () => {
        const { ws, routes } = fakeWebBuilder();
        QueryServer.start(ws);
        const handler = routes["GET /api/query/:queryKey/serverTokens"];
        const body = await invoke(handler, { queryKey: "Artist" }, {}) as Parameters<typeof deserializeServerToken>[0][];

        // client-side: it already has the Artist root token locally
        const localRoot = QueryLogic.getToken(ArtistEntity, "", O);
        const albumsJson = body.find(t => t.key === "albums")!;
        const rebuilt = deserializeServerToken(albumsJson, localRoot) as ExtensionToken;

        assert.ok(rebuilt instanceof ExtensionToken);
        assert.equal(rebuilt.niceName(), "Albums");
        assert.equal(rebuilt.fullKey(), "albums");
        // and it navigates locally (element/count sub-tokens generated client-side)
        const subKeys = rebuilt.subTokens(O).map(t => t.key);
        assert.ok(subKeys.includes("Element"));
    });

    test("matches getToken + isServerOnlyToken filtering directly", () => {
        const direct = QueryLogic.getToken(ArtistEntity, "", O).subTokens(O).filter(isServerOnlyToken).map(serializeServerToken);
        assert.ok(direct.length > 0);
        assert.ok(direct.every(t => t.tokenType === "Extension"));
        const keys = direct.map(t => t.key);
        for (const k of ["albums", "albumCount", "artistName"])
            assert.ok(keys.includes(k), `expected server token '${k}'`);
    });
});
