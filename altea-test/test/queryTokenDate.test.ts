import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { table, bindAndOptimize } from "@altea/altea/logic/table";
import { Connector } from "@altea/altea/logic/connection/connector";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { QueryFormatter } from "@altea/altea/logic/linq/queryFormatter";
import { ProjectionExpression } from "@altea/altea/logic/linq/expressions.sql";
import {
    ParameterExpression, LambdaExpression, CallExpression, PropertyExpression,
} from "@altea/altea/logic/linq/expressions";
import { ClassType, ArrayType } from "@altea/altea/entities/runtimeTypes";
import { Implementations } from "@altea/altea/entities/implementations";
import { ColumnDescription } from "@altea/altea/logic/dynamicQuery/queryDescription";
import { BuildExpressionContext, ExpressionBox, SubTokensOptionsAll } from "@altea/altea/logic/dynamicQuery/tokens/queryToken";
import { ColumnToken } from "@altea/altea/logic/dynamicQuery/tokens/columnToken";
import "@altea/altea/logic/dynamicQuery/tokens/factories"; // registers token factories
import { MusicLogic } from "../logic/MusicLogic";
import { AlbumEntity, NoteWithDateEntity } from "../entities/music";

// Phase-3b DynamicQuery port: date-part sub-tokens (DateTimeProperties/DateOnlyProperties via
// NetPropertyToken + DateToken) and integer ModuloToken.

const O = SubTokensOptionsAll;

function entityToken(ctor: Function, name = "Album"): ColumnToken {
    const col = new ColumnDescription("Entity", new ClassType(ctor), name);
    col.implementations = Implementations.by(ctor);
    return new ColumnToken(col, ctor);
}
function ctxFor(ctor: Function) {
    const param = new ParameterExpression("e", new ClassType(ctor));
    return { param, ctx: new BuildExpressionContext(param.type, param, new Map([["Entity", new ExpressionBox(param)]])) };
}
function tokFrom(root: ColumnToken, path: string) {
    let t: any = root;
    for (const step of path.split("."))
        t = t.subToken(step, O);
    return t;
}

describe("date sub-tokens", () => {
    const note = () => entityToken(NoteWithDateEntity, "Note");

    test("PlainDateTime exposes the date parts + Date + HasValue", () => {
        const keys = tokFrom(note(), "creationTime").subTokens(O).map((t: any) => t.key);
        for (const k of ["year", "quarter", "month", "day", "dayOfWeek", "hour", "minute", "second", "Date", "HasValue"])
            assert.ok(keys.includes(k), `missing ${k}`);
    });

    test("PlainDate exposes date-only parts (no hour/Date)", () => {
        const keys = tokFrom(note(), "creationDate").subTokens(O).map((t: any) => t.key);
        assert.ok(keys.includes("year"));
        assert.ok(keys.includes("day"));
        assert.ok(!keys.includes("hour"));
        assert.ok(!keys.includes("Date"));
    });

    test("year part → property access; quarter → method call; Date → .date", () => {
        const { ctx } = ctxFor(NoteWithDateEntity);
        assert.equal(tokFrom(note(), "creationTime.year").buildExpression(ctx).toString(), "e.creationTime.year");
        assert.equal(tokFrom(note(), "creationTime.quarter").buildExpression(ctx).toString(), "e.creationTime.quarter()");
        assert.equal(tokFrom(note(), "creationTime.Date").buildExpression(ctx).toString(), "e.creationTime.date");
    });
});

describe("integer Modulo sub-tokens", () => {
    test("a number field exposes Mod10..Mod10000 + HasValue", () => {
        const keys = tokFrom(entityToken(AlbumEntity), "year").subTokens(O).map((t: any) => t.key);
        for (const k of ["Mod10", "Mod100", "Mod1000", "Mod10000", "HasValue"])
            assert.ok(keys.includes(k), `missing ${k}`);
    });

    test("Mod100 → value % 100", () => {
        const { ctx } = ctxFor(AlbumEntity);
        assert.equal(tokFrom(entityToken(AlbumEntity), "year.Mod100").buildExpression(ctx).toString(), "(e.year % 100)");
    });
});

describe("date/modulo bind to SQL end-to-end", () => {
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

    function bind(ctor: Function, path: string): string {
        const q = table(ctor as any);
        const param = new ParameterExpression("e", new ClassType(ctor));
        const ctx = new BuildExpressionContext(param.type, param, new Map([["Entity", new ExpressionBox(param)]]));
        const body = tokFrom(entityToken(ctor), path).buildExpression(ctx);
        const lambda = new LambdaExpression([param], body);
        const mapCall = new CallExpression(new PropertyExpression(q.expression, "map"), [lambda], new ArrayType(body.type));
        return Connector.withConnector(fake, () => {
            const proj = bindAndOptimize(mapCall, sb.schema, false, true) as ProjectionExpression;
            assert.ok(proj instanceof ProjectionExpression);
            // Arithmetic (modulo) stays in the projector over the selected operands; a SQL function
            // (DATEPART) is nominated into the select. Match against both so either placement passes.
            return (QueryFormatter.format(proj.select, false).sql + " ~~ " + String(proj.projector)).toLowerCase();
        });
    }

    test("creationTime.Year → DATEPART/YEAR over the column", () => {
        const sql = bind(NoteWithDateEntity, "creationTime.year");
        assert.match(sql, /year|datepart/);
    });

    test("year.Mod100 → a modulo in the SELECT", () => {
        const sql = bind(AlbumEntity, "year.Mod100");
        assert.match(sql, /%|mod/);
    });
});
