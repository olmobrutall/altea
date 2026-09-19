import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { init } from "@altea/altea/data/reflection";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { table, bindAndOptimize } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { ProjectionExpression } from "@altea/altea/server/linq/expressions.sql";
import {
    ParameterExpression, LambdaExpression, CallExpression, PropertyExpression,
    Expression, ObjectExpression, ConstantExpression, ConditionalExpression,
} from "@altea/altea/server/linq/expressions";
import { ClassType, ArrayType } from "@altea/altea/server/runtimeTypes";
import { QueryToken, SubTokensOptions, SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import {
    ContainerTokenKey, OperationsContainerToken, OperationToken,
} from "@altea/altea/data/dynamicQuery/tokens/operationToken";
import { QuickLinksToken } from "@altea/altea/data/dynamicQuery/tokens/manualToken";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { BuildExpressionContext, ExpressionBox } from "@altea/altea/server/dynamicQuery/tokenExpressions";
import "@altea/altea/server/dynamicQuery/tokenExpressions"; // installs the buildExpression prototypes
import "@altea/altea/server/fluentOperations"; // FluentInclude.withStateMachine / withExecute / …
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { inState } from "@altea/altea/server/operation";
import { QueryTokenMessage } from "@altea/altea/data/dynamicQueries";
import { AlbumEntity, AlbumState } from "../../data/music";

// The `[Operations]` container + its OperationToken leaves (Signum's OperationsContainerToken.cs /
// OperationToken.cs): an entity OPERATION surfaced as a search-result COLUMN. Fully offline — the
// eligibility set and the expression are both built from the in-memory operation registry.
//
// Own operation container (CellOp), so these registrations cannot collide with
// operations/operationLogic.test.ts's AlbumOperation ones.
namespace CellOp {
    export const Publish: ExecuteSymbol<AlbumEntity> = init();
    export const Touch: ExecuteSymbol<AlbumEntity> = init();
    export const Review: ExecuteSymbol<AlbumEntity> = init();
    export const Remove: DeleteSymbol<AlbumEntity> = init();
    export const Clone2: ConstructSymbol<AlbumEntity, From<AlbumEntity>> = init();
}

const sb = new SchemaBuilder();
sb.include(AlbumEntity).withStateMachine(a => a.state, sm => {
    // Eligible: a state guard, no other can-execute — the refusal is a CASE over the state column.
    sm.withExecute(CellOp.Publish, {
        fromStates: [AlbumState.New],
        toStates: [AlbumState.Saved],
        avoidImplicitSave: true,
        execute: a => { a.state = AlbumState.Saved; },
    })
        // Eligible: no guard at all — the button is always enabled.
        .withExecute(CellOp.Touch, {
            fromStates: [AlbumState.New, AlbumState.Saved],
            toStates: [AlbumState.New, AlbumState.Saved],
            avoidImplicitSave: true,
            execute: () => { /* no-op */ },
        })
        // NOT eligible: an IN-MEMORY-only canExecute has no SQL twin, so its reason cannot be shown per row.
        .withExecute(CellOp.Review, {
            fromStates: [AlbumState.Saved],
            toStates: [AlbumState.Saved],
            avoidImplicitSave: true,
            canExecute: a => a.name.length === 0 ? "no name" : null,
            execute: () => { /* no-op */ },
        })
        // Eligible: the guard is QUOTED, so it lowers to SQL (Signum's CanDeleteExpression).
        .withDelete(CellOp.Remove, {
            fromStates: [AlbumState.Saved],
            canExecuteExpression: a => a.year > 2000 ? "too recent" : null,
        })
        // Eligible: a ConstructFrom is an IEntityOperation too, and `toStates` never guards the SOURCE row.
        .withConstructFrom(AlbumEntity, CellOp.Clone2, {
            toStates: [AlbumState.New],
            construct: from => AlbumEntity.create({ state: AlbumState.New, name: from.name }),
        });
});

// Wires the eligible-operations + expression seams (Signum assigns the three OperationToken statics at
// the end of OperationLogic.Start).
OperationLogic.start(new SchemaBuilder());

const O = SubTokensOptionsAll;

function entityToken(): RootToken {
    return new RootToken(AlbumEntity);
}
function tok(path: string): QueryToken {
    let t: QueryToken = entityToken();
    for (const step of path.split("."))
        t = t.subToken(step, O)!;
    return t;
}

describe("the [Operations] container", () => {

    test("hangs off an entity token, but only with CanOperation", () => {
        assert.ok(entityToken().subTokens(O).map(t => t.key).includes(ContainerTokenKey.Operations));
        const noOp = O & ~SubTokensOptions.CanOperation;
        assert.ok(!entityToken().subTokens(noOp).map(t => t.key).includes(ContainerTokenKey.Operations));
    });

    test("the container key is the literal, and its caption the bracketed message", () => {
        const c = tok(ContainerTokenKey.Operations);
        assert.ok(c instanceof OperationsContainerToken);
        assert.equal(c.key, "[Operations]");
        assert.equal(c.toString(), `[${QueryTokenMessage.Operations.niceToString()}]`);
        assert.equal(c.niceName(), c.toString());
        assert.equal(c.niceTypeName(), QueryTokenMessage.ContainerOfCellOperations.niceToString());
        assert.ok(c.hideInAutoExpand);
        assert.ok(c.hasOperation());
    });

    test("the quick-links container keeps its own key (both ContainerTokenKey members)", () => {
        const q = tok(ContainerTokenKey.QuickLinks);
        assert.ok(q instanceof QuickLinksToken);
        assert.equal(q.key, "[QuickLinks]");
        assert.equal(ContainerTokenKey.Operations, "[Operations]");
    });
});

describe("eligibility — only an operation whose refusal is expressible in SQL", () => {

    const leafKeys = (): string[] => tok(ContainerTokenKey.Operations).subTokens(O).map(t => t.key);

    test("a state-guarded operation, an unguarded one, a quoted guard and a ConstructFrom are offered", () => {
        const keys = leafKeys();
        assert.ok(keys.includes("CellOp#Publish"));
        assert.ok(keys.includes("CellOp#Touch"));
        assert.ok(keys.includes("CellOp#Remove"));
        assert.ok(keys.includes("CellOp#Clone2"));
    });

    test("an in-memory-only canExecute is NOT offered", () => {
        assert.ok(!leafKeys().includes("CellOp#Review"));
        assert.ok(!OperationLogic.isEligibleForCellOperation(OperationLogic.findOperation(CellOp.Review), AlbumEntity));
    });

    test("a plain Construct is not an entity operation, so it is never offered", () => {
        // `Create` (operations/…) aside, the rule itself: only Execute / Delete / ConstructorFrom pass.
        for (const key of leafKeys())
            assert.ok(!key.startsWith("Create"), key);
    });
});

describe("the OperationToken leaf", () => {

    test("its key escapes the dot, while toString keeps the operation key", () => {
        const t = tok(`${ContainerTokenKey.Operations}.CellOp#Publish`);
        assert.ok(t instanceof OperationToken);
        assert.equal(t.key, "CellOp#Publish");
        assert.equal(t.toString(), "CellOp.Publish");
        assert.ok(t.hasOperation());
        assert.ok(!t.isGroupable);
    });

    test("its value type is CellOperationDTO — the name the client's format rule matches on", () => {
        const t = tok(`${ContainerTokenKey.Operations}.CellOp#Publish`);
        assert.equal(t.type.getTypeName(), "CellOperationDTO");
        assert.equal(t.niceTypeName(), QueryTokenMessage.CellOperation.niceToString());
        assert.equal(t.subTokens(O).length, 0);
    });

    test("a leaf resolves case-insensitively too, like every other stored token", () => {
        assert.ok(tok(`${ContainerTokenKey.Operations}.cellop#publish`) instanceof OperationToken);
    });
});

describe("the per-row expression", () => {

    class FakeConnector extends Connector {
        constructor() { super({} as any, false, 128); }
        override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
        openConnection(): Promise<any> { throw new Error("not used"); }
        closeConnection(): Promise<void> { return Promise.resolve(); }
        cleanDatabase(): Promise<void> { return Promise.resolve(); }
    }
    const fake = new FakeConnector();

    function bindToken(path: string): string {
        const q = table(AlbumEntity);
        const param = new ParameterExpression("e", new ClassType(AlbumEntity));
        const ctx = new BuildExpressionContext(param.type, param, new Map([["Entity", new ExpressionBox(param)]]));
        const body = tok(path).buildExpression(ctx);
        const lambda = new LambdaExpression([param], body);
        const mapCall = new CallExpression(new PropertyExpression(q.expression, "map"), [lambda], new ArrayType(body.type));
        return Connector.withConnector(fake, () => {
            const proj = bindAndOptimize(mapCall, sb.schema, false, true) as ProjectionExpression;
            assert.ok(proj instanceof ProjectionExpression);
            return QueryFormatter.format(proj.select, false).sql;
        });
    }

    // The projected shape (Signum's `new CellOperationDTO(entity.ToLite(), operationKey, canExecute)`).
    function projection(path: string): Record<string, Expression> {
        const param = new ParameterExpression("e", new ClassType(AlbumEntity));
        const ctx = new BuildExpressionContext(param.type, param, new Map([["Entity", new ExpressionBox(param)]]));
        const body = tok(path).buildExpression(ctx);
        assert.ok(body instanceof ObjectExpression, `expected an object literal, got ${body.constructor.name}`);
        return body.properties;
    }

    test("every leaf projects { lite, operationKey, canExecute }", () => {
        const p = projection(`${ContainerTokenKey.Operations}.CellOp#Touch`);
        assert.deepEqual(Object.keys(p), ["lite", "operationKey", "canExecute"]);
        assert.ok(p["operationKey"] instanceof ConstantExpression);
        assert.equal((p["operationKey"] as ConstantExpression).value, "CellOp.Touch");
    });

    test("a state-guarded operation folds its refusal into a conditional over the state", () => {
        const canExecute = projection(`${ContainerTokenKey.Operations}.CellOp#Publish`)["canExecute"]!;
        assert.ok(canExecute instanceof ConditionalExpression);
        // `Publish` runs from New, so `Saved` is the one state that refuses — and the sentence is the
        // one the in-memory guard writes, naming BOTH sides by their nice names.
        const message = (canExecute as ConditionalExpression).whenTrue as ConstantExpression;
        assert.equal(message.value, inState(AlbumState.Saved, AlbumState, AlbumState.New));
        // …and the fall-through (an allowed state, no other guard) is a plain null.
        assert.equal(((canExecute as ConditionalExpression).whenFalse as ConstantExpression).value, null);
    });

    test("an operation allowed from every state has no conditional at all", () => {
        const canExecute = projection(`${ContainerTokenKey.Operations}.CellOp#Touch`)["canExecute"]!;
        assert.ok(canExecute instanceof ConstantExpression);
        assert.equal((canExecute as ConstantExpression).value, null);
    });

    test("a quoted canExecuteExpression is inlined over the row, under the state branches", () => {
        // `Remove` runs from Saved only, so: New → the state refusal, Saved → the quoted guard.
        const canExecute = projection(`${ContainerTokenKey.Operations}.CellOp#Remove`)["canExecute"]!;
        assert.ok(canExecute instanceof ConditionalExpression);
        const guard = (canExecute as ConditionalExpression).whenFalse;
        assert.ok(guard instanceof ConditionalExpression, "the quoted guard survives as the fall-through");
    });

    test("the whole projection binds to real SQL, reading the state and the guarded column", () => {
        const sql = bindToken(`${ContainerTokenKey.Operations}.CellOp#Remove`).toLowerCase();
        assert.match(sql, /from dbo\.album/);
        assert.match(sql, /stateid/);
        assert.match(sql, /year/);
    });
});
