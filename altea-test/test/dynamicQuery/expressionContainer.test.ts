import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { table, bindAndOptimize } from "@altea/altea/logic/table";
import { Connector } from "@altea/altea/logic/connection/connector";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { QueryFormatter } from "@altea/altea/logic/linq/queryFormatter";
import { ProjectionExpression } from "@altea/altea/logic/linq/expressions.sql";
import { ParameterExpression, CallExpression, PropertyExpression, LambdaExpression } from "@altea/altea/logic/linq/expressions";
import { ClassType, ArrayType, LiteralType } from "@altea/altea/entities/runtimeTypes";
import { Implementations } from "@altea/altea/entities/implementations";
import { BuildExpressionContext, ExpressionBox, SubTokensOptionsAll } from "@altea/altea/logic/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/logic/dynamicQuery/tokens/rootToken";
import { ExtensionToken } from "@altea/altea/logic/dynamicQuery/tokens/extensionToken";
import { QueryLogic } from "@altea/altea/logic/dynamicQuery/queryLogic";
import { PropertyRoute } from "@altea/altea/entities/propertyRoute";
import "@altea/altea/logic/dynamicQuery/fluentIncludeQuery"; // withExpressionTo / withExpressionFrom
import "@altea/altea/logic/dynamicQuery/tokens/factories";
import { MusicLogic } from "../../logic/MusicLogic";
import { ArtistEntity, BandEntity, AlbumEntity } from "../../entities/music";

// Phase-4: ExpressionContainer / withExpressionTo / withExpressionFrom. A registered cross-entity
// expression shows up as a sub-token whose BuildExpression inlines the registered lambda against the
// parent.

const O = SubTokensOptionsAll;
const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
// MusicLogic.start registers the ENTITY-valued expression `Album.withExpressionFrom(ArtistEntity,
// a => a.albums())` → an `albums` extension token on Artist (auto niceName = AlbumEntity plural).
MusicLogic.start(sb);
// A SCALAR expression is not an entity navigation, so withExpressionTo/From (which auto-derive the
// niceName from a target entity) don't apply — register it directly with an explicit niceName thunk.
QueryLogic.expressions.register(ArtistEntity, (a: ArtistEntity) => a.albumCount(), { niceName: () => "Album Count" });
// A clean single-route expression (a plain navigation) — its token should expose the route + inherit
// the route's IsAllowed via the MetadataVisitor.
QueryLogic.expressions.register(ArtistEntity, (a: ArtistEntity) => a.name, { key: "artistName", niceName: () => "Artist Name" });
// withExpressionFrom keys on the lambda's PARAMETER type: configured off the BandEntity include but
// with an ArtistEntity-param lambda, so `friendsCovariant` (an entity collection) registers on ARTIST.
sb.include(BandEntity)
    .withExpressionFrom(ArtistEntity, a => a.friendsCovariant());
sb.complete();

class FakeConnector extends Connector {
    constructor() { super(sb.schema, false, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}
const fake = new FakeConnector();

function entityToken(): RootToken {
    return new RootToken(ArtistEntity);
}

function bandEntityToken(): RootToken {
    return new RootToken(BandEntity);
}

describe("registered expressions appear as sub-tokens", () => {
    test("Artist's Entity column exposes the registered albums + albumCount + friendsCovariant", () => {
        const keys = entityToken().subTokens(O).map(t => t.key);
        assert.ok(keys.includes("albums"));
        assert.ok(keys.includes("albumCount"));
        assert.ok(keys.includes("friendsCovariant"));
    });

    test("an entity projection carries element implementations, collection sub-tokens + auto plural niceName", () => {
        const al = entityToken().subToken("albums", O)!;
        assert.ok(al instanceof ExtensionToken);
        assert.equal(al.getElementImplementations()!.only(), AlbumEntity);
        const subKeys = al.subTokens(O).map(t => t.key);
        assert.ok(subKeys.includes("Element"));
        assert.ok(subKeys.includes("Count"));
        // withExpressionFrom auto-derived the niceName from the target entity's NicePluralName.
        assert.equal(al.niceName(), "Albums");
    });

    test("withExpressionFrom keys on the lambda's parameter type, not the include's type", () => {
        // Registered off Include(BandEntity) but with an ArtistEntity-param lambda → shows on Artist…
        assert.ok(entityToken().subTokens(O).map(t => t.key).includes("friendsCovariant"));
        // …and NOT on Band (the source is the param type Artist, not the FluentInclude's Band).
        assert.ok(!bandEntityToken().subTokens(O).map(t => t.key).includes("friendsCovariant"));
    });
});

describe("extension token inherits metadata from its expression (MetadataVisitor)", () => {
    test("a clean single-route expression exposes its PropertyRoute", () => {
        const t = entityToken().subToken("artistName", O)!;
        assert.match(t.getPropertyRoute()!.toString(), /\(Artist\)\.name/);
    });

    test("a computed/void expression (albumCount) has no single route", () => {
        assert.equal(entityToken().subToken("albumCount", O)!.getPropertyRoute(), undefined);
    });

    test("isAllowed is inherited from the expression's source route", () => {
        const name = entityToken().subToken("artistName", O)!;
        assert.equal(name.isAllowed(), null); // allowed by default
        try {
            PropertyRoute.isAllowedCallback = r => /\(Artist\)\.name/.test(r.toString()) ? "Denied" : null;
            assert.equal(name.isAllowed(), "Denied");
            // albumCount is a void aggregate → no provenance → stays allowed.
            assert.equal(entityToken().subToken("albumCount", O)!.isAllowed(), null);
        } finally {
            PropertyRoute.isAllowedCallback = undefined;
        }
    });
});

describe("extension token inlines the registered expression", () => {
    test("Entity.albumCount → e.albumCount() (explicit niceName thunk), binds to a count subquery over albums", () => {
        const ac = entityToken().subToken("albumCount", O)!;
        assert.equal(ac.niceName(), "Album Count"); // the () => string thunk supplied at registration

        const param = new ParameterExpression("e", new ClassType(ArtistEntity));
        const ctx = new BuildExpressionContext(param.type, param, new Map([["Entity", new ExpressionBox(param)]]));
        const body = ac.buildExpression(ctx);
        // buildExtension inlines the (already-expanded) albumCount body, correlating `this` → the
        // parent artist `e`: count albums whose author is `e`.
        assert.match(body.toString(), /\.count\(\)/);
        assert.match(body.toString(), /author/);

        const q = table(ArtistEntity);
        const mapCall = new CallExpression(new PropertyExpression(q.expression, "map"), [new LambdaExpression([param], body)], new ArrayType(LiteralType.number));
        const sql = Connector.withConnector(fake, () => {
            const proj = bindAndOptimize(mapCall, sb.schema, false, true) as ProjectionExpression;
            assert.ok(proj instanceof ProjectionExpression);
            return QueryFormatter.format(proj.select, false).sql.toLowerCase();
        });
        assert.match(sql, /count/);
        assert.match(sql, /album/);
    });
});
