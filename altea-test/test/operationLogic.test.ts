import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Connector } from "@altea/altea/logic/connection/connector";
import { graph } from "@altea/altea/logic/graphBuilder";
import { Graph } from "@altea/altea/logic/graph";
import { Operations, OperationLogic } from "@altea/altea/logic/operationLogic";
import { AlbumEntity, AlbumState, ArtistEntity } from "../entities/music";
import { AlbumOperation } from "../entities/testOperations";

// Phase 3 — OperationLogic + graph(). Runs OFFLINE: construct and avoidImplicitSave
// execute do no DB work, and RealTransaction.start is lazy, so Transaction.create never
// opens the fake connection. canExecute needs no transaction at all. (The implicit
// save()/delete() paths are one line onto already-tested code and are exercised in the
// DB-gated suites.)
class FakeConnector extends Connector {
    constructor() { super({} as any, false, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("no DB in this offline test"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}
const fake = new FakeConnector();
const offline = <T>(fn: () => Promise<T>): Promise<T> => Connector.withConnector(fake, fn);

// The graph — mirrors OrderGraph.Register(): declarative const, register() called once.
// graph(T, StateEnum, …) binds T + S; g.GetState mirrors Signum's `GetState = o => o.State`.
const AlbumGraph = graph(AlbumEntity, AlbumState, g => {
    g.GetState = a => a.state;
    g.Construct(AlbumOperation.Create, {
        toStates: [AlbumState.New],
        construct: () => AlbumEntity.create({ state: AlbumState.New }),
    });
    g.Construct(AlbumOperation.CreateInvalid, {
        toStates: [AlbumState.New],
        construct: () => AlbumEntity.create({ state: AlbumState.Saved }), // violates toStates
    });
    g.ConstructFrom(AlbumOperation.Clone, {
        toStates: [AlbumState.New],
        construct: from => AlbumEntity.create({ state: AlbumState.New, name: from.name }),
    });
    g.ConstructFromMany(AlbumOperation.CreateFromArtists, {
        toStates: [AlbumState.New],
        construct: lites => AlbumEntity.create({ state: AlbumState.New, name: `Compilation of ${lites.length}` }),
    });
    g.Execute(AlbumOperation.Save, {
        fromStates: [AlbumState.New, AlbumState.Saved],
        toStates: [AlbumState.Saved],
        canBeNew: true,
        avoidImplicitSave: true, // keep the transition offline; persistence proven elsewhere
        execute: a => { a.state = AlbumState.Saved; },
    });
    g.Execute(AlbumOperation.OnlyWhenSaved, {
        fromStates: [AlbumState.Saved],
        avoidImplicitSave: true,
        execute: () => { /* no-op */ },
    });
    g.Delete(AlbumOperation.Delete, {
        fromStates: [AlbumState.Saved],
        delete: a => a.delete(),
    });
});
AlbumGraph.register();

// Compile-time discrimination checks — never executed, only type-checked. If the
// From/FromMany/Simple markers ever stopped keeping the constructor kinds distinct, the
// unused `@ts-expect-error` directives would fail the build. This is the safety half of
// the ConstructSymbol<T, From<F>> design.
async function _kindDiscrimination(): Promise<void> {
    // @ts-expect-error — Clone is From<…>; construct() only accepts a Simple ConstructSymbol
    await Operations.construct(AlbumOperation.Clone);
    // @ts-expect-error — Create is Simple; constructFrom() needs a From<…> ConstructSymbol
    await Operations.constructFrom(AlbumEntity.create({}), AlbumOperation.Create);
    // @ts-expect-error — CreateFromArtists is FromMany<…>; constructFrom() needs From<…>
    await Operations.constructFrom(AlbumEntity.create({}), AlbumOperation.CreateFromArtists);
}
void _kindDiscrimination;

describe("OperationLogic / graph", () => {
    test("register wires every operation into OperationLogic", () => {
        const keys = OperationLogic.registeredOperations().map(s => s.key);
        for (const k of ["AlbumOperation.Create", "AlbumOperation.Save", "AlbumOperation.Delete"])
            assert.ok(keys.includes(k), `expected ${k} registered`);
    });

    test("construct runs in a transaction and returns a new entity in the target state", async () => {
        const album = await offline(() => Operations.construct(AlbumOperation.Create));
        assert.ok(album instanceof AlbumEntity);
        assert.equal(album.state, AlbumState.New);
        assert.equal(album.isNew, true);
    });

    test("construct enforces toStates", async () => {
        await assert.rejects(
            () => offline(() => Operations.construct(AlbumOperation.CreateInvalid)),
            /State should be one of/);
    });

    test("execute applies the state transition and returns the same instance", async () => {
        const album = AlbumEntity.create({ state: AlbumState.New });
        const result = await offline(() => Operations.execute(album, AlbumOperation.Save));
        assert.equal(result, album);
        assert.equal(result.state, AlbumState.Saved);
    });

    test("constructFrom builds a new entity from a source", async () => {
        const source = AlbumEntity.create({ state: AlbumState.Saved, name: "Original" });
        source.isNew = false; // constructFrom rejects a new source unless canBeNew
        const clone = await offline(() => Operations.constructFrom(source, AlbumOperation.Clone));
        assert.ok(clone instanceof AlbumEntity);
        assert.notEqual(clone, source);
        assert.equal(clone.state, AlbumState.New);
        assert.equal(clone.name, "Original");
    });

    test("constructFrom rejects a new source entity", async () => {
        const source = AlbumEntity.create({ state: AlbumState.Saved }); // isNew
        await assert.rejects(
            () => offline(() => Operations.constructFrom(source, AlbumOperation.Clone)),
            /is new/);
    });

    test("constructFromMany builds a new entity from many lites", async () => {
        const a1 = ArtistEntity.create({ name: "A1" });
        const a2 = ArtistEntity.create({ name: "A2" });
        const lites = [a1.toLite(true), a2.toLite(true)]; // fat lites (sources are new)
        const album = await offline(() => Operations.constructFromMany(lites, AlbumOperation.CreateFromArtists));
        assert.ok(album instanceof AlbumEntity);
        assert.equal(album.state, AlbumState.New);
        assert.equal(album.name, "Compilation of 2");
    });

    test("execute rejects when the from-state is wrong", async () => {
        const album = AlbumEntity.create({ state: AlbumState.New });
        album.isNew = false; // not new, but in New state — OnlyWhenSaved requires Saved
        await assert.rejects(
            () => offline(() => Operations.execute(album, AlbumOperation.OnlyWhenSaved)),
            /State should be one of/);
    });

    test("canExecute gates on isNew, fromStates and returns null when allowed", () => {
        const brandNew = AlbumEntity.create({ state: AlbumState.New });
        assert.equal(Operations.canExecute(brandNew, AlbumOperation.Save), null); // canBeNew + New in from
        assert.match(Operations.canExecute(brandNew, AlbumOperation.Delete)!, /is new/);

        const savedButNewState = AlbumEntity.create({ state: AlbumState.New });
        savedButNewState.isNew = false;
        assert.match(Operations.canExecute(savedButNewState, AlbumOperation.Delete)!, /State should be/);

        const proper = AlbumEntity.create({ state: AlbumState.Saved });
        proper.isNew = false;
        assert.equal(Operations.canExecute(proper, AlbumOperation.Delete), null);
    });

    test("delete rejects a new entity before touching the DB", async () => {
        const album = AlbumEntity.create({ state: AlbumState.Saved }); // isNew
        await assert.rejects(
            () => offline(() => Operations.delete(album, AlbumOperation.Delete)),
            /is new/);
    });

    // Operations are real classes — createable/replaceable/removable from outside the graph.
    test("operations can be replaced and removed from outside the graph", () => {
        const original = OperationLogic.findOperation(AlbumOperation.Save);
        assert.ok(original instanceof Graph.Execute);

        // A fresh standalone Graph.Execute with stricter fromStates, swapped in via replace.
        const replacement = new Graph.Execute<AlbumEntity, AlbumState>(AlbumOperation.Save);
        replacement.getState = a => a.state;
        replacement.fromStates = [AlbumState.Saved];
        replacement.toStates = [AlbumState.Saved];
        replacement.avoidImplicitSave = true;
        replacement.execute = () => { /* no-op */ };
        OperationLogic.register(replacement, /* replace */ true);
        assert.equal(OperationLogic.findOperation(AlbumOperation.Save), replacement);

        // The replacement's behaviour is live: a New album is now rejected by canExecute.
        const album = AlbumEntity.create({ state: AlbumState.New });
        album.isNew = false;
        assert.match(Operations.canExecute(album, AlbumOperation.Save)!, /State should be/);

        // And it can be removed entirely.
        assert.equal(OperationLogic.unregister(AlbumOperation.Save), true);
        assert.equal(OperationLogic.tryFindOperation(AlbumOperation.Save), undefined);

        OperationLogic.register(original, /* replace */ true); // restore for any later runs
    });
});
