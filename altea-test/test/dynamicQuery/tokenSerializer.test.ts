import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import "@altea/altea/entities/dynamicQuery/tokens/factories"; // register metadata factories → local subtoken gen
import { RootToken } from "@altea/altea/entities/dynamicQuery/tokens/rootToken";
import { ExtensionToken, type ExtensionInfo } from "@altea/altea/entities/dynamicQuery/tokens/extensionToken";
import { SubTokensOptionsAll, getSubTokens, setServerTokensProvider } from "@altea/altea/entities/dynamicQuery/tokens/queryToken";
import { Implementations } from "@altea/altea/entities/implementations";
import { ClassType, LiteType, ArrayType, LiteralType, TemporalType } from "@altea/altea/entities/runtimeTypes";
import {
    serializeServerToken, deserializeServerToken, serializeRuntimeType, deserializeRuntimeType,
} from "@altea/altea/entities/dynamicQuery/tokenSerializer";
import { ArtistEntity, AlbumEntity } from "../../entities/music";

// Phase 2 of the QueryToken → entities move: the client generates the metadata sub-tokens locally,
// and only the SERVER-ONLY tokens (extensions/…) come over the wire. This proves they round-trip to
// real entities token instances the client can then navigate locally.

const O = SubTokensOptionsAll;

describe("token serializer", () => {
    test("RuntimeType round-trips by clean type name / tag", () => {
        const cases = [
            new ClassType(AlbumEntity),
            new LiteType(new ClassType(AlbumEntity)),
            new ArrayType(new LiteType(new ClassType(AlbumEntity))),
            LiteralType.string, LiteralType.number, LiteralType.boolean,
            new TemporalType("date"),
        ];
        for (const rt of cases)
            assert.deepEqual(serializeRuntimeType(deserializeRuntimeType(serializeRuntimeType(rt))), serializeRuntimeType(rt));

        // a class rehydrates to the SAME constructor (via the clean-name registry)
        const c = deserializeRuntimeType(serializeRuntimeType(new ClassType(AlbumEntity)));
        assert.ok(c instanceof ClassType && c.constructorFunction === AlbumEntity);
    });

    test("an ExtensionToken serializes and rebuilds off the client's local parent", () => {
        const parent = new RootToken(ArtistEntity);
        const info: ExtensionInfo = {
            key: "albums",
            niceName: () => "Albums",
            resultType: new ArrayType(new LiteType(new ClassType(AlbumEntity))),
            isProjection: true,
            implementations: Implementations.by(AlbumEntity),
            propertyRoute: undefined,
            allowedReason: () => null,
            serverInfo: { lambda: "secret", meta: "secret" }, // must NOT survive serialization
        };
        const original = new ExtensionToken(parent, info);

        const json = serializeServerToken(original);
        assert.equal(json.tokenType, "Extension");
        assert.equal(json.key, "albums");
        assert.equal(json.niceName, "Albums");
        assert.equal(json.isProjection, true);
        assert.equal(json.implementations, "Album");
        // the opaque server handle is never emitted
        assert.equal((json as unknown as Record<string, unknown>).serverInfo, undefined);

        const rebuilt = deserializeServerToken(json, parent) as ExtensionToken;
        assert.ok(rebuilt instanceof ExtensionToken);
        assert.equal(rebuilt.key, "albums");
        assert.equal(rebuilt.niceName(), "Albums");
        assert.equal(rebuilt.fullKey(), "albums"); // rootless off the entity root
        assert.equal(rebuilt.isAllowed(), null);
        assert.equal(rebuilt.getElementImplementations()!.only(), AlbumEntity);
        assert.equal(rebuilt.info.serverInfo, undefined); // client token can't build a SQL expression

        // the rebuilt token generates its element sub-tokens LOCALLY (no server round-trip)
        const subKeys = rebuilt.subTokens(O).map(t => t.key);
        assert.ok(subKeys.includes("Element"));
        assert.ok(subKeys.includes("Count"));
    });

    test("getSubTokens merges local metadata tokens with async-fetched server-only tokens", async () => {
        const parent = new RootToken(ArtistEntity);
        // simulate the client's cached-ajax source returning one serialized server-only extension token
        const serverJson = serializeServerToken(new ExtensionToken(parent, {
            key: "albums", niceName: () => "Albums", isProjection: true,
            resultType: new ArrayType(new LiteType(new ClassType(AlbumEntity))),
            implementations: Implementations.by(AlbumEntity),
        }));
        try {
            setServerTokensProvider(async (t) => [deserializeServerToken(serverJson, t)]);
            const keys = (await getSubTokens(parent, O)).map(t => t.key);
            assert.ok(keys.includes("albums"));         // the fetched server-only token
            assert.ok(keys.includes("ToString"));        // …alongside locally-generated metadata tokens
            assert.ok(keys.length > 2);
        } finally {
            setServerTokensProvider(undefined); // shared module state under --test-isolation=none
        }
    });

    test("propertyRoute + allowedReason round-trip (a clean single-route extension)", () => {
        const parent = new RootToken(ArtistEntity);
        const info: ExtensionInfo = {
            key: "artistName",
            niceName: () => "Artist Name",
            resultType: LiteralType.string,
            isProjection: false,
            allowedReason: () => "Denied",
        };
        const json = serializeServerToken(new ExtensionToken(parent, info));
        assert.equal(json.allowedReason, "Denied");

        const rebuilt = deserializeServerToken(json, parent) as ExtensionToken;
        assert.equal(rebuilt.isAllowed(), "Denied");
        assert.equal(rebuilt.niceName(), "Artist Name");
    });
});
