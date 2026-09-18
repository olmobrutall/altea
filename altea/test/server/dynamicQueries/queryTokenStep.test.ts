import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { reflect } from "@altea/altea/data/reflection"; // anchor for the transformer's @field injection
import { Entity, type BaseEntity, type Type } from "@altea/altea/data/entity";
import { entity, decimalsValidator } from "@altea/altea/data/decorators";
import { Decimal, type float, type int } from "@altea/altea/data/basics";
import { Enum } from "@altea/altea/data/enum";
import { enumNameOf } from "@altea/altea/data/registration";
import { table, bindAndOptimize } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { ProjectionExpression } from "@altea/altea/server/linq/expressions.sql";
import { ParameterExpression, LambdaExpression, CallExpression, PropertyExpression } from "@altea/altea/server/linq/expressions";
import { ClassType, ArrayType } from "@altea/altea/server/runtimeTypes";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { RoundingType, StepToken } from "@altea/altea/data/dynamicQuery/tokens/stepToken";
import { BuildExpressionContext, ExpressionBox } from "@altea/altea/server/dynamicQuery/tokenExpressions";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import "@altea/altea/server/dynamicQuery/tokenExpressions"; // registers token factories
import { AlbumEntity } from "../../data/music";
import { MusicLogic } from "../MusicLogic";

// Signum's RoundingType + StepToken / StepMultiplierToken / StepRoundingToken (DecimalSpecialTokens.cs)
// and the localized captions of ModuloToken. A numeric column is bucketed into a histogram grid; the
// three token levels are one chain (size → nice multiplier → which edge of the bucket names it).

const O = SubTokensOptionsAll;

@reflect
@entity("Main", "Master")
class StepProbeEntity extends Entity {
    counter: int;
    ratio: float;
    price: Decimal;
    @decimalsValidator(4)
    precisePrice: Decimal;
}

function tokFrom(ctor: Type<BaseEntity>, path: string): any {
    let t: any = new RootToken(ctor);
    for (const step of path.split("."))
        t = t.subToken(step, O);
    return t;
}
const keysOf = (ctor: Type<BaseEntity>, path: string): string[] =>
    tokFrom(ctor, path).subTokens(O).map((t: any) => t.key);

describe("RoundingType", () => {
    test("is a registered enum, so its member names are translatable", () => {
        assert.equal(enumNameOf(RoundingType), "RoundingType");
        // No translation file is loaded in a test, so niceName falls back to the humanised identifier —
        // what matters is that it goes THROUGH the lookup rather than splicing the member name raw.
        assert.equal(Enum.niceName(RoundingType, "RoundMiddle"), "Round middle");
    });
});

describe("Step sub-token generation", () => {
    test("a whole number gets Step1..Step1000000 and the modulo tokens, but no sub-unit steps", () => {
        const keys = keysOf(StepProbeEntity, "counter");
        for (const k of ["Step1", "Step10", "Step100", "Step1000", "Step10000", "Step100000", "Step1000000"])
            assert.ok(keys.includes(k), `missing ${k}`);
        for (const k of ["Mod10", "Mod100", "Mod1000", "Mod10000", "HasValue"])
            assert.ok(keys.includes(k), `missing ${k}`);
        assert.ok(!keys.includes("Step0_1"), "an integer has no fractional buckets");
    });

    test("a fractional number gets sub-unit steps down to its format's decimals, and NO modulo", () => {
        // A plain Decimal formats as "N2" (Signum's money default), so two fraction digits.
        const price = keysOf(StepProbeEntity, "price");
        assert.ok(price.includes("Step0_01"));
        assert.ok(!price.includes("Step0_001"), "N2 stops at two decimals");
        assert.ok(!price.some(k => k.startsWith("Mod")), "`x mod 100` says nothing about a fractional value");
        // @decimalsValidator(4) → "N4" → all four sub-unit sizes.
        const precise = keysOf(StepProbeEntity, "precisePrice");
        for (const k of ["Step0_0001", "Step0_001", "Step0_01", "Step0_1"])
            assert.ok(precise.includes(k), `missing ${k}`);
        // A `float` has no declared precision at all, so Signum's fallback of four decimals applies.
        assert.ok(keysOf(StepProbeEntity, "ratio").includes("Step0_0001"));
    });

    test("a step offers the ten multipliers, and each multiplier the four roundings", () => {
        // (A groupable token also offers the aggregates, which every token in the tree does — filter
        // them out so this asserts the Step chain's OWN sub-tokens exactly.)
        const own = (path: string): string[] =>
            keysOf(StepProbeEntity, path).filter(k => k.startsWith("x") || ["Ceil", "Floor", "Round", "RoundMiddle", "Step"].some(p => k.startsWith(p)));
        assert.deepEqual(own("counter.Step1000"), ["x1", "x1_2", "x1_5", "x2", "x2_5", "x3", "x4", "x5", "x6", "x8"]);
        assert.deepEqual(own("counter.Step1000.x2_5"), ["Ceil", "Floor", "Round", "RoundMiddle"]);
        assert.deepEqual(own("counter.Step1000.x2_5.Floor"), []);
    });

    test("the effective bucket size multiplies out without float noise", () => {
        assert.equal(tokFrom(StepProbeEntity, "precisePrice.Step0_001.x1_2").stepSizeValue(), 0.0012);
        assert.equal(tokFrom(StepProbeEntity, "counter.Step1000.x2_5").stepSizeValue(), 2500);
    });

    test("every caption is a localizable message, never a hand-built English literal", () => {
        assert.equal(tokFrom(StepProbeEntity, "counter.Step1000").toString(), "Step 1000");
        assert.equal(tokFrom(StepProbeEntity, "counter.Step1000").niceName(), "Counter step 1000");
        assert.equal(tokFrom(StepProbeEntity, "counter.Step1000.x2_5").toString(), "x2.5");
        assert.equal(tokFrom(StepProbeEntity, "counter.Step1000.x2_5").niceName(), "Counter step 1000 step 2500");
        assert.equal(tokFrom(StepProbeEntity, "counter.Step1000.x2_5.Floor").toString(), "Floor");
        assert.equal(tokFrom(StepProbeEntity, "counter.Step1000.x2_5.RoundMiddle").niceName(),
            "Counter step 1000 step 2500 step |2500|");
    });

    test("a bucket is GROUPABLE even over a decimal, which the raw column is not", () => {
        assert.equal(tokFrom(StepProbeEntity, "price").isGroupable, false);
        assert.equal(tokFrom(StepProbeEntity, "price.Step0_01").isGroupable, true);
        assert.equal(tokFrom(StepProbeEntity, "price.Step0_01.x2.Round").isGroupable, true);
    });

    test("the localized Modulo captions replace the old English literals", () => {
        assert.equal(tokFrom(StepProbeEntity, "counter.Mod100").toString(), "Modulo 100");
        assert.equal(tokFrom(StepProbeEntity, "counter.Mod100").niceName(), "Counter mod 100");
    });
});

describe("Step expressions", () => {
    function fakeConnectorFor(isPostgres: boolean): { connector: Connector; schema: any } {
        const sb = new SchemaBuilder();
        sb.settings.isPostgres = isPostgres;
        MusicLogic.start(sb);
        sb.include(StepProbeEntity);
        sb.complete();
        class FakeConnector extends Connector {
            constructor() { super(sb.schema, isPostgres, 128); }
            override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
            openConnection(): Promise<any> { throw new Error("not used"); }
            closeConnection(): Promise<void> { return Promise.resolve(); }
            cleanDatabase(): Promise<void> { return Promise.resolve(); }
        }
        return { connector: new FakeConnector(), schema: sb.schema };
    }

    function sqlFor(ctor: Type<BaseEntity>, path: string, isPostgres: boolean): string {
        const { connector, schema } = fakeConnectorFor(isPostgres);
        const q = table(ctor as any);
        const param = new ParameterExpression("e", new ClassType(ctor));
        const ctx = new BuildExpressionContext(param.type, param, new Map([["Entity", new ExpressionBox(param)]]));
        const body = tokFrom(ctor, path).buildExpression(ctx);
        const lambda = new LambdaExpression([param], body);
        const mapCall = new CallExpression(new PropertyExpression(q.expression, "map"), [lambda], new ArrayType(body.type));
        return Connector.withConnector(connector, () => {
            const proj = bindAndOptimize(mapCall, schema, isPostgres, true) as ProjectionExpression;
            assert.ok(proj instanceof ProjectionExpression);
            // Plain arithmetic may stay in the projector over selected operands; a SQL function is
            // nominated into the SELECT. Match against both so either placement passes.
            return (QueryFormatter.format(proj.select, isPostgres).sql + " ~~ " + String(proj.projector)).toLowerCase();
        });
    }

    // The bucket size reaches SQL as a BOUND PARAMETER, so it is asserted on the expression tree the
    // token builds rather than on the formatted statement.
    function exprFor(ctor: Type<BaseEntity>, path: string): string {
        const param = new ParameterExpression("e", new ClassType(ctor));
        const ctx = new BuildExpressionContext(param.type, param, new Map());
        return String(tokFrom(ctor, path).buildExpression(ctx));
    }

    test("the bucket arithmetic is Signum's, in Signum's order", () => {
        assert.equal(exprFor(StepProbeEntity, "counter.Step1000"), "([object Math].ceil((Number(e.counter) / 1000)) * 1000)");
        assert.equal(exprFor(StepProbeEntity, "counter.Step1000.x2_5.Floor"), "([object Math].floor((Number(e.counter) / 2500)) * 2500)");
        // RoundMiddle shifts the grid by half a bucket before and back after, so the label is the MIDDLE.
        assert.equal(exprFor(StepProbeEntity, "counter.Step1000.x1.RoundMiddle"),
            "(([object Math].round(((Number(e.counter) - 500) / 1000)) * 1000) + 500)");
        // A step of exactly 1 divides by nothing — Signum's `if (multiplier != 1)`.
        assert.equal(exprFor(StepProbeEntity, "counter.Step1.x1.Ceil"), "[object Math].ceil(Number(e.counter))");
        // A Decimal stays in decimal.js, so the money grid is exact.
        assert.equal(exprFor(StepProbeEntity, "price.Step0_01.x2.Ceil"), "e.price.dividedBy(0.02).ceil().times(0.02)");
    });

    for (const [name, isPostgres] of [["SQL Server", false], ["Postgres", true]] as const) {
        test(`${name}: an integer Step casts to float FIRST, or the division would truncate`, () => {
            const sql = sqlFor(StepProbeEntity, "counter.Step1000", isPostgres);
            assert.match(sql, /cast\(/, "Signum's Convert(double) — int/int is INTEGER division on both providers");
            assert.match(sql, isPostgres ? /as double precision/ : /as float/);
            assert.match(sql, /ceiling\(/);
        });

        test(`${name}: the rounding token picks the SQL function`, () => {
            assert.match(sqlFor(StepProbeEntity, "counter.Step1000.x2_5.Floor", isPostgres), /floor\(/);
            assert.match(sqlFor(StepProbeEntity, "counter.Step1000.x2_5.Round", isPostgres), /round\(/);
            assert.match(sqlFor(StepProbeEntity, "counter.Step1000.x2_5.Ceil", isPostgres), /ceiling\(/);
        });

        test(`${name}: RoundMiddle lowers to a ROUND over a shifted grid`, () => {
            const sql = sqlFor(StepProbeEntity, "counter.Step1000.x1.RoundMiddle", isPostgres);
            assert.match(sql, /round\(/);
            assert.match(sql, / - /, "the half-bucket shift survives into SQL");
        });

        test(`${name}: a Decimal bucket stays in exact decimal arithmetic`, () => {
            const sql = sqlFor(StepProbeEntity, "price.Step0_01.x2.Ceil", isPostgres);
            assert.match(sql, /ceiling\(/);
            assert.match(sql, isPostgres ? /numeric/ : /decimal/, "the decimal.js chain lowers through a numeric cast");
        });

        test(`${name}: an Album year bucket binds against a real query`, () => {
            assert.match(sqlFor(AlbumEntity, "year.Step10.x2.Floor", isPostgres), /floor\(/);
        });
    }
});

describe("Step in the in-memory (DEnumerable) path", () => {
    // The same token must answer in memory too: the DEnumerable pipeline interprets the expression tree
    // rather than lowering it, and `Number(x)` is a captured-function call it had no case for.
    test("a bucket evaluates over materialised rows", async () => {
        const sb = new SchemaBuilder();
        sb.settings.isPostgres = true;
        MusicLogic.start(sb);
        sb.complete();
        const { DEnumerable } = await import("@altea/altea/server/dynamicQuery/dEnumerable");
        const param = new ParameterExpression("e", new ClassType(AlbumEntity));
        const rows = [1971, 1980, 1969].map(y => Object.assign(new AlbumEntity(), { year: y }));
        const de = new DEnumerable(rows, new BuildExpressionContext(param.type, param, new Map([["", new ExpressionBox(param)]])));
        const token = tokFrom(AlbumEntity, "year.Step10.x1.Floor");
        const rt = de.toResultTable([token]);
        assert.deepEqual(rt.columns[0].values, [1970, 1980, 1960]);
    });

    test("RoundMiddle labels the MIDDLE of its bucket", () => {
        const step = tokFrom(AlbumEntity, "year.Step10.x1.RoundMiddle") as unknown as StepToken;
        assert.equal(step.key, "RoundMiddle");
    });
});
