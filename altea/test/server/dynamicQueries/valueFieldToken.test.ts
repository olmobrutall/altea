import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { SubTokensOptionsAll, valueFieldSubToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { setLegacyPropertyPaths } from "@altea/altea/data/propertyRoute";
import { ArtistEntity } from "../../data/artist";

// `@valueField` and the query token, the three halves of one rule (see PropertyRoute / QueryTokenString):
//
//  - Signum's `MList<Lite<Artist>>` element IS the value, so its token ends at `Friends.Any`. altea's
//    element is a `@part` ROW whose `@valueField` holds the value, so the same thing is
//    `Friends.Any.Friend` — one hop further.
//  - NORMAL mode only knows altea's spelling; LEGACY mode also READS Signum's, which is the hop being
//    made for it (`appendLegacyValueField`, applied by `QueryLogic.getToken` and by the client's
//    TokenCompleter). One direction: a token altea writes back stays altea's, or a Signum deployment
//    reading the same row could not resolve it.
//  - a row with no `@valueField` — a richer part, an embedded element — is left where it stopped.

describe("@valueField query tokens", () => {
    afterAll(() => { setLegacyPropertyPaths(false); });

    test("the element's @valueField is a sub-token of Any", () => {
        setLegacyPropertyPaths(false);
        const any = QueryLogic.getToken(ArtistEntity, "Friends.Any", SubTokensOptionsAll);
        const vf = valueFieldSubToken(any, SubTokensOptionsAll);
        assert.ok(vf != undefined);
        assert.equal(vf!.fullKey(), "Friends.Any.Friend");
    });

    test("NORMAL mode resolves altea's spelling and stops where it is told", () => {
        setLegacyPropertyPaths(false);
        assert.equal(QueryLogic.getToken(ArtistEntity, "Friends.Any.Friend", SubTokensOptionsAll).fullKey(),
            "Friends.Any.Friend");
        // `Friends.Any` is the ROW here, and altea never writes it as a value.
        assert.equal(QueryLogic.getToken(ArtistEntity, "Friends.Any", SubTokensOptionsAll).fullKey(),
            "Friends.Any");
    });

    test("LEGACY MODE reads Signum's `Friends.Any` as the value", () => {
        setLegacyPropertyPaths(true);
        assert.equal(QueryLogic.getToken(ArtistEntity, "Friends.Any", SubTokensOptionsAll).fullKey(),
            "Friends.Any.Friend");
        // …and the fictitious leading `Entity.` a Signum-stored token carries comes off first.
        assert.equal(QueryLogic.getToken(ArtistEntity, "Entity.Friends.Any", SubTokensOptionsAll).fullKey(),
            "Friends.Any.Friend");
        // altea's own spelling still resolves to itself — the hop is not applied twice.
        assert.equal(QueryLogic.getToken(ArtistEntity, "Friends.Any.Friend", SubTokensOptionsAll).fullKey(),
            "Friends.Any.Friend");
        // Element, not only the quantifiers.
        assert.equal(QueryLogic.getToken(ArtistEntity, "Friends.Element", SubTokensOptionsAll).fullKey(),
            "Friends.Element.Friend");
    });

    test("a token that is not a collection element is untouched", () => {
        setLegacyPropertyPaths(true);
        assert.equal(QueryLogic.getToken(ArtistEntity, "Name", SubTokensOptionsAll).fullKey(), "Name");
        assert.equal(QueryLogic.getToken(ArtistEntity, "Friends", SubTokensOptionsAll).fullKey(), "Friends");
        assert.equal(valueFieldSubToken(
            QueryLogic.getToken(ArtistEntity, "Name", SubTokensOptionsAll), SubTokensOptionsAll), undefined);
    });
});
