import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { ParameterExpression, PropertyExpression, CallExpression, LambdaExpression, BinaryExpression } from "@altea/altea/logic/linq/expressions";
import { ClassType, LiteralType } from "@altea/altea/entities/runtimeTypes";
import { PropertyRoute } from "@altea/altea/entities/propertyRoute";
import { CleanMeta, DirtyMeta } from "@altea/altea/logic/dynamicQuery/meta";
import { MetadataVisitor } from "@altea/altea/logic/dynamicQuery/metadataVisitor";
import { AlbumEntity, AlbumEntity_Songs, LabelEntity, ArtistEntity, BandEntity } from "../../entities/music";

// MetadataVisitor: track which entity PropertyRoutes an expression reads, producing a Meta
// (CleanMeta / DirtyMeta). Expressions are hand-built (the pre-bind altea AST the visitor walks).

const album = new ParameterExpression("a", new ClassType(AlbumEntity));
const N = LiteralType.number;
const prop = (o: any, n: string) => new PropertyExpression(o, n);
// A method call `source.method(args)` (altea models it as Call(Property(source, method), args)).
const call = (source: any, method: string, args: any[] = []) => new CallExpression(prop(source, method), args, N);
const meta = (body: any) => MetadataVisitor.gatherMeta(body, album, AlbumEntity);

// Restore the (global, process-shared under --test-isolation=none) auth callback after each test.
afterEach(() => { PropertyRoute.isAllowedCallback = undefined; });

describe("CleanMeta — direct navigation", () => {
    test("a reference column → CleanMeta with the route + implementations", () => {
        const m = meta(prop(album, "label"));
        assert.ok(m instanceof CleanMeta);
        assert.match(m.propertyRoutes[0].toString(), /\(Album\)\.label/);
        assert.equal(m.implementations!.only(), LabelEntity);
    });

    test("a deep value navigation → CleanMeta re-rooted at the referenced entity", () => {
        // (Album).label.name re-roots through the single-impl ref → (Label).name (Signum's AddImp).
        const m = meta(prop(prop(album, "label"), "name"));
        assert.ok(m instanceof CleanMeta);
        assert.match(m.propertyRoutes[0].toString(), /\(Label\)\.name/);
        assert.equal(m.implementations, undefined); // a string, not an entity ref
    });

    test("navigating a polymorphic reference expands over each implementation", () => {
        // author is @implementedBy(Artist, Band); add() can't re-root a poly ref, so the visitor
        // expands to (Artist).name + (Band).name.
        const m = meta(prop(prop(album, "author"), "name"));
        assert.ok(m instanceof CleanMeta);
        const roots = new Set(m.propertyRoutes.map(r => r.rootType));
        assert.deepEqual(roots, new Set([ArtistEntity, BandEntity]));
    });
});

describe("DirtyMeta — computed values", () => {
    test("groupBy(...).count() → void DirtyMeta (Count carries no provenance)", () => {
        const s = new ParameterExpression("s", new ClassType(AlbumEntity_Songs));
        const grouped = call(prop(album, "songs"), "groupBy", [new LambdaExpression([s], prop(s, "name"))]);
        const m = meta(call(grouped, "count"));
        assert.ok(m instanceof DirtyMeta);
        assert.equal(m.cleanMetas.length, 0);
        assert.equal(m.isAllowed(), null);
    });

    test("sum(selector) propagates the selector's clean route", () => {
        const s = new ParameterExpression("s", new ClassType(AlbumEntity_Songs));
        const m = meta(call(prop(album, "songs"), "sum", [new LambdaExpression([s], prop(s, "seconds"))]));
        assert.ok(m instanceof CleanMeta);
        assert.match(m.propertyRoutes[0].toString(), /\(AlbumEntity_Songs\)\.seconds/);
    });

    test("arithmetic over two columns → DirtyMeta keeping both contributors", () => {
        const s = new ParameterExpression("s", new ClassType(AlbumEntity_Songs));
        const sum = call(prop(album, "songs"), "sum", [new LambdaExpression([s], prop(s, "seconds"))]);
        const m = meta(new BinaryExpression("+", sum, prop(album, "year")));
        assert.ok(m instanceof DirtyMeta);
        const routes = m.cleanRoutes.map(r => r.toString());
        assert.ok(routes.some(r => /seconds/.test(r)));
        assert.ok(routes.some(r => /year/.test(r)));
    });
});

describe("IsAllowed provenance (via PropertyRoute.isAllowedCallback)", () => {
    test("a clean column inherits its route's denial; a void aggregate stays allowed", () => {
        PropertyRoute.isAllowedCallback = r => /seconds/.test(r.toString()) ? "Not allowed" : null;

        const s = new ParameterExpression("s", new ClassType(AlbumEntity_Songs));
        const sumSeconds = meta(call(prop(album, "songs"), "sum", [new LambdaExpression([s], prop(s, "seconds"))]));
        assert.equal(sumSeconds.isAllowed(), "Not allowed"); // CleanMeta over the denied route

        const label = meta(prop(album, "label"));
        assert.equal(label.isAllowed(), null); // a different, allowed route

        const s2 = new ParameterExpression("s", new ClassType(AlbumEntity_Songs));
        const count = meta(call(call(prop(album, "songs"), "groupBy", [new LambdaExpression([s2], prop(s2, "name"))]), "count"));
        assert.equal(count.isAllowed(), null); // Count has no provenance → allowed even though it enumerates songs
    });
});
