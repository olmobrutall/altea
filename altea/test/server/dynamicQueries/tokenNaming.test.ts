import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { SubTokensOptionsAll, stripLegacyRootPrefix } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { setLegacyPropertyPaths } from "@altea/altea/data/propertyRoute";
import { tokenSequence } from "@altea/altea/client/QueryTokenString";
import "@altea/altea/server/dynamicQuery/tokenExpressions"; // registers token factories
import { table, bindAndOptimize } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { ProjectionExpression } from "@altea/altea/server/linq/expressions.sql";
import { ParameterExpression, LambdaExpression, CallExpression, PropertyExpression } from "@altea/altea/server/linq/expressions";
import { ClassType, ArrayType } from "@altea/altea/server/runtimeTypes";
import { BuildExpressionContext, ExpressionBox } from "@altea/altea/server/dynamicQuery/tokenExpressions";
import { MusicLogic } from "../MusicLogic";
import { AlbumEntity, NoteWithDateEntity, AwardNominationEntity } from "../../data/music";

// A query token's KEY is PascalCase, as Signum's is — the spelling `QueryTokenString.tokenSequence`
// (and therefore `Type.token(…)`, every `defaultColumns` entry and every `findOptions` builder) has
// always produced, and the one a Signum database's stored assets hold. Pinned here because getting it
// wrong is silent: a mis-cased key resolves through the case-insensitive fallback and only shows up as
// a token STRING that differs from the one the other framework wrote.

const O = SubTokensOptionsAll;
const album = () => new RootToken(AlbumEntity);

describe("token keys are PascalCase, like Signum's", () => {
    test("a field token takes the field's name, capitalised", () => {
        const keys = album().subTokens(O).map(t => t.key);
        for (const k of ["Id", "Name", "Year", "Author", "Label", "Songs", "ToString", "HasValue"])
            assert.ok(keys.includes(k), `missing ${k}`);
        assert.ok(!keys.includes("name"), "the camelCase field name is not a key");
    });

    test("a nested path chains them", () => {
        assert.equal(album().subToken("Label", O)!.subToken("Name", O)!.fullKey(), "Label.Name");
    });

    test("a value-member token uses Signum's PropertyInfo name, not altea's binder member", () => {
        assert.equal(album().subToken("Name", O)!.subToken("Length", O)!.fullKey(), "Name.Length");
        const dates = new RootToken(NoteWithDateEntity).subToken("CreationTime", O)!.subTokens(O).map(t => t.key);
        for (const k of ["Year", "Month", "Day", "DayOfWeek", "Hour", "Date"])
            assert.ok(dates.includes(k), `missing date part ${k}`);
    });

    test("it is the spelling the typed token builder produces", () => {
        // The whole reason for the rule: `Type.token(a => a.name)` has always PascalCased, so a token
        // BUILT by the builder and a token key had to agree — they only did on the client, whose cache
        // is case-insensitive, never on the server's lookup.
        assert.equal(tokenSequence((a: AlbumEntity) => a.label.name, true), "Label.Name");
        assert.equal(album().subToken("Label", O)!.subToken("Name", O)!.fullKey(), "Label.Name");
    });
});

describe("resolution tolerates the older spelling", () => {
    test("a camelCase key still resolves, and yields the PascalCase token", () => {
        assert.equal(album().subToken("name", O)!.fullKey(), "Name");
        assert.equal(album().subToken("label", O)!.subToken("name", O)!.fullKey(), "Label.Name");
    });

    test("an unknown key is still unknown", () => {
        assert.equal(album().subToken("nope", O), undefined);
    });
});

describe("legacy mode drops the Signum root prefix", () => {
    after(() => setLegacyPropertyPaths(false));

    test("normal mode keeps it (there is no `Entity` member to reach, so it simply fails)", () => {
        setLegacyPropertyPaths(false);
        assert.equal(stripLegacyRootPrefix(album(), "Entity.Name", O), "Entity.Name");
    });

    test("legacy mode strips it, and a bare `Entity` IS the root", () => {
        setLegacyPropertyPaths(true);
        assert.equal(stripLegacyRootPrefix(album(), "Entity.Name", O), "Name");
        assert.equal(stripLegacyRootPrefix(album(), "Entity", O), "");
    });

    test("only the LEADING segment, and only when nothing answers to it", () => {
        setLegacyPropertyPaths(true);
        assert.equal(stripLegacyRootPrefix(album(), "Name", O), "Name");
        // `Entity` deeper in the path is a member like any other — never the root.
        assert.equal(stripLegacyRootPrefix(album(), "Label.Entity", O), "Label.Entity");
    });
});

// A polymorphic (`@implementedBy`) reference exposes the members its DECLARED type declares, beside the
// per-implementation AsType tokens. Signum offers the AsType tokens alone (so its own Southwind chart
// stores `Customer.Address.Country`, a token its picker cannot build); both binders translate the
// member perfectly well, through a CASE over the implementations.
describe("a polymorphic reference exposes its declared type's members", () => {
    const nomination = () => new RootToken(AwardNominationEntity);
    const award = () => nomination().subToken("Award", O)!;

    test("the abstract base's own members are directly reachable", () => {
        const keys = award().subTokens(O).map(t => t.key);
        for (const k of ["Year", "Category", "Result"])
            assert.ok(keys.includes(k), `missing base member ${k}`);
        assert.equal(award().subToken("Category", O)!.fullKey(), "Award.Category");
    });

    test("…alongside Id / ToString / HasValue and one AsType token per implementation", () => {
        const keys = award().subTokens(O).map(t => t.key);
        for (const k of ["Id", "ToString", "HasValue", "(GrammyAward)", "(PersonalAward)", "(AmericanMusicAward)"])
            assert.ok(keys.includes(k), `missing ${k}`);
    });

    test("an implementation-only member stays under its AsType token", () => {
        // Nothing implementation-specific exists on these three, so assert the shape instead: the
        // AsType token re-roots at the concrete type and offers the same members from there.
        assert.equal(award().subToken("(GrammyAward)", O)!.subToken("Category", O)!.fullKey(),
            "Award.(GrammyAward).Category");
    });

    test("the member lowers to SQL as a CASE over the implementations", () => {
        const sb = new SchemaBuilder();
        sb.settings.isPostgres = false;
        MusicLogic.start(sb);
        sb.complete();
        class FakeConnector extends Connector {
            constructor() { super(sb.schema, false, 128); }
            override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
            openConnection(): Promise<any> { throw new Error("not used"); }
            closeConnection(): Promise<void> { return Promise.resolve(); }
            cleanDatabase(): Promise<void> { return Promise.resolve(); }
        }
        const fake = new FakeConnector();

        const q = table(AwardNominationEntity);
        const param = new ParameterExpression("e", new ClassType(AwardNominationEntity));
        const ctx = new BuildExpressionContext(param.type, param, new Map([["Entity", new ExpressionBox(param)]]));
        const body = award().subToken("Category", O)!.buildExpression(ctx);
        const lambda = new LambdaExpression([param], body);
        const mapCall = new CallExpression(new PropertyExpression(q.expression, "map"), [lambda], new ArrayType(body.type));
        const sql = Connector.withConnector(fake, () => {
            const proj = bindAndOptimize(mapCall, sb.schema, false, true) as ProjectionExpression;
            return QueryFormatter.format(proj.select, false).sql.toLowerCase();
        });
        // One join per implementation, and a CASE picking whichever row the FK points at.
        assert.match(sql, /case/);
        assert.match(sql, /grammyaward|grammy_award/);
        assert.match(sql, /category/);
    });
});
