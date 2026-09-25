import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { AlbumEntity } from "../../data/music";

// Signum's `Type.propertyRouteAssert(a => …)` / `tryPropertyRoute`: a route rooted at the type, from an
// inline property lambda — the same route PropertyRoute.root(T).addLambda builds.
describe("Type.propertyRoute", () => {
    test("a member of the type", () => {
        const pr = AlbumEntity.propertyRoute(a => a.name);
        assert.equal(pr.rootType, AlbumEntity);
        assert.equal(pr.propertyString(), PropertyRoute.root(AlbumEntity).addLambda(a => a.name).propertyString());
    });

    test("through a reference, like addLambda (which re-roots there)", () => {
        assert.equal(AlbumEntity.propertyRoute(a => a.label.name).toString(),
            PropertyRoute.root(AlbumEntity).addLambda(a => a.label.name).toString());
        assert.ok(AlbumEntity.tryPropertyRoute(a => a.label.name) instanceof PropertyRoute);
    });
});
