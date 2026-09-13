import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { PropertyRoute, setLegacyPropertyPaths } from "@altea/altea/data/propertyRoute";
import "@altea/altea/server/dynamicQuery/tokenExpressions"; // registers token factories
import { AlbumEntity } from "../../data/music";
import { ArtistEntity } from "../../data/artist";
import { CastProbeEntity, CastProbeTextPartEntity } from "../../data/castProbe";

// The token layer and the route layer must agree on what a CAST is. `AsTypeToken.key` has always been
// `(CleanName)`; until PropertyRoute grew `addCast` the token's route was always a STANDALONE part root,
// which is a route nothing can store and no rule can be written against. Now the token hands back the
// real route where the parent has one — so `Parts.Element.Content.(TextPart).TextContent` and
// `(Dashboard).parts/content.(TextPart).textContent` are the same member seen from the two layers.
//
// DB-free: a token needs reflection and the factory registry, not a schema.
const O = SubTokensOptionsAll;

describe("AsTypeToken — the property route of a cast", () => {
    // panels → Element → content → (CastProbeTextPart)
    function contentToken() {
        const panels = new RootToken(CastProbeEntity).subToken("Panels", O)!;
        const element = panels.subToken("Element", O)!;
        return element.subToken("Content", O)!;
    }

    test("the cast token's key is the route's step spelling", () => {
        const keys = contentToken().subTokens(O).map(t => t.key);
        assert.ok(keys.includes("(CastProbeTextPart)"), keys.join(", "));
        // The same string the route writes, which is what makes the two layers one grammar.
        assert.equal(
            PropertyRoute.root(CastProbeEntity).add("panels").add("Item").add("content")
                .addCast(CastProbeTextPartEntity).propertyString(),
            "panels/content.(CastProbeTextPart)");
    });

    test("casting to a @part yields the OWNER-rooted route, not a standalone part root", () => {
        const cast = contentToken().subToken("(CastProbeTextPart)", O)!;
        const route = cast.getPropertyRoute()!;
        assert.equal(route.rootType, CastProbeEntity);
        assert.equal(route.propertyString(), "panels/content.(CastProbeTextPart)");
        // …so it survives the storage boundary, where a part root is refused.
        route.assertNotPartRoot();
    });

    test("a member under the cast token carries the owner-rooted route too", () => {
        const cast = contentToken().subToken("(CastProbeTextPart)", O)!;
        const member = cast.subToken("TextContent", O)!;
        assert.equal(member.getPropertyRoute()!.propertyString(), "panels/content.(CastProbeTextPart).textContent");
    });

    test("casting to a NON-part still re-roots, exactly as before", () => {
        const author = new RootToken(AlbumEntity).subToken("Author", O)!;
        const cast = author.subToken("(Artist)", O)!;
        assert.equal(cast.getPropertyRoute(), PropertyRoute.root(ArtistEntity));
    });

    // LEGACY MODE generates no cast route (a Signum database has no counterpart for one), so the token
    // must not hand back a route the model does not contain — every consumer of a token's route looks it
    // up in that set. It falls back to what it always used, a standalone part root.
    test("LEGACY MODE falls back to the standalone part root", () => {
        setLegacyPropertyPaths(true);
        try {
            const cast = contentToken().subToken("(CastProbeTextPart)", O)!;
            assert.equal(cast.getPropertyRoute(), PropertyRoute.rootStandalone(CastProbeTextPartEntity));
        } finally {
            setLegacyPropertyPaths(false);
        }
    });
});
