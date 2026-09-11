import "@altea/altea/server"; // installs Entity.save()/delete()
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { retrieve } from "@altea/altea/server/Database";
import { Clock } from "@altea/altea/data/utils/clock";
import { Lite } from "@altea/altea/data/lite";
import { Entity, type Type, type PrimaryKey } from "@altea/altea/data/entity";
import type { Query } from "@altea/altea/server/query";
import type { OperationSymbol, ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { OperationLogic, Operations } from "@altea/altea/server/operationLogic";
import { OperationType } from "@altea/altea/server/operation";
import {
    PackageEntity, PackageOperationEntity, PackageLineEntity, PackageOperationProcess, setOperationArgs,
    getOperationArgs,
} from "../data/Package";
import { ProcessEntity } from "../data/Processes";
import { ProcessLogic, type IProcessAlgorithm } from "./ProcessLogic";
import type { ExecutingProcess } from "./ProcessRunner";

// The half of the module that turns a SET OF ENTITIES into work a process walks. A package is a row plus
// one PackageLineEntity per element; a process algorithm reads the lines, does something per line, and
// stamps `finishTime` — so **a run that dies halfway can be retried and picks up where it stopped**
// (`lines().filter(a => a.finishTime == null)`).
//
// **Registration order does not matter**, despite what `ProcessLogic.register`'s own doc-comment says:
// `SymbolLogic.start` stores `getSymbols` as a THUNK and calls it from `schema.generating` /
// `schema.synchronizing`, so every algorithm registered before the schema is built is seeded, whichever
// side of `ProcessLogic.start` it landed on.
//
// `createLinesFromQuery` keeps its own name because `createLines` cannot be overloaded on a Query vs an
// array in a way TypeScript resolves well.
//
// Port of Signum.Processes' PackageLogic.cs — see port/Processes.md.

export namespace PackageLogic {

    /**
     * A SERVER helper rather than a
     * `@quoted` member on the entity: the data layer must not import the server query API (the call
     * altea-processes / -scheduler already made for `Processes()` / `LastProcess()`).
     */
    export function lines(pack: PackageEntity): Query<PackageLineEntity> {
        const lite = pack.toLite();
        return table(PackageLineEntity).filter(l => l.package.is(lite));
    }

    /** The lines of a package that a previous run did not finish — what every algorithm below walks. */
    export function pendingLines(pack: PackageEntity): Query<PackageLineEntity> {
        const lite = pack.toLite();
        return table(PackageLineEntity).filter(l => l.package.is(lite) && l.finishTime == null);
    }

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        ProcessLogic.register(PackageOperationProcess.PackageOperation, new PackageOperationAlgorithm());
    }

    /**
     * SAVE the package, then insert one line per element, SET-BASED
     * and grouped by concrete type (a `Lite<Entity>` list may be polymorphic, and the insert reads from that
     * type's own table). A package can hold hundreds of thousands of elements, so a row-by-row save is not
     * an option; chunked at 100 lites per statement.
     */
    export async function createLines(pack: PackageEntity, lites: readonly Lite<Entity>[]): Promise<PackageEntity> {
        await pack.save();

        const byType = new Map<Function, PrimaryKey[]>();
        for (const lite of lites) {
            let ids = byType.get(lite.entityType);
            if (ids == undefined)
                byType.set(lite.entityType, ids = []);
            ids.push(lite.id!);
        }

        const packLite = pack.toLite();
        for (const [ctor, ids] of byType)
            for (let i = 0; i < ids.length; i += CHUNK) {
                const chunk = ids.slice(i, i + CHUNK);
                await table(ctor as Type<Entity>)
                    .filter(e => chunk.includes(e.id))
                    .executeInsert(PackageLineEntity, e => ({ package: packLite, target: e.toLite() }));
            }

        return pack;
    }

    /** The same, from full entities rather than lites. */
    export function createLinesFromEntities(pack: PackageEntity, entities: readonly Entity[]): Promise<PackageEntity> {
        return createLines(pack, entities.map(e => e.toLite()));
    }

    /**
     * One statement, no ids in memory at all. This is what a task building a
     * package from "every order older than a week" should use.
     */
    export async function createLinesFromQuery<T extends Entity>(pack: PackageEntity, query: Query<T>): Promise<PackageEntity> {
        await pack.save();
        const packLite = pack.toLite();
        await query.executeInsert(PackageLineEntity, e => ({ package: packLite, target: e.toLite() }));
        return pack;
    }

    /** The process behind a contextual "run this operation on all of
     *  them" menu entry. */
    export async function createPackageOperation(
        lites: readonly Lite<Entity>[],
        operation: OperationSymbol,
        ...operationArgs: unknown[]
    ): Promise<ProcessEntity> {
        const pack = PackageOperationEntity.create({ operation });
        setOperationArgs(pack, operationArgs.length === 0 ? null : operationArgs);
        await createLines(pack, lites);
        return await ProcessLogic.create(PackageOperationProcess.PackageOperation, pack.toLite());
    }

    const CHUNK = 100;
}

/** The package a running process is walking. */
async function packageOf<T extends PackageEntity>(ep: ExecutingProcess, type: Type<T>): Promise<T> {
    const data = ep.data;
    if (data == null)
        throw new Error(`The process ${ep.currentProcess.id} has no package to walk`);
    return await retrieve(data.entityType as Type<T>, data.id!) as T;
}

/** Retrieve a line's target — the lite carries the concrete type, so this works for a polymorphic package. */
function targetOf(line: PackageLineEntity): Promise<Entity> {
    return retrieve(line.target.entityType as Type<Entity>, line.target.id!);
}

/**
 * Apply the operation the package NAMES to each of its lines,
 * dispatching on that operation's kind. The one algorithm that is registered by the module itself
 * (`PackageLogic.start`), because the operation is data rather than a compile-time choice.
 */
export class PackageOperationAlgorithm implements IProcessAlgorithm {
    readonly allowParallelExecution = false;

    async execute(ep: ExecutingProcess): Promise<void> {
        const pack = await packageOf(ep, PackageOperationEntity);
        const symbol = pack.operation;

        // The package itself is appended to the args when it carries a ConfigString, so an algorithm
        // that needs the configuration can read it off the last argument.
        const args = getOperationArgs(pack) ?? [];
        const withPackage = pack.configString != null && pack.configString.length > 0 ? [...args, pack] : args;

        const lines = await PackageLogic.pendingLines(pack).toArray() as PackageLineEntity[];

        await ep.forEach(lines, l => `PackageLine ${l.id}`, async line => {
            const target = await targetOf(line);
            const operationType = OperationLogic.findOperation(symbol).operationType;

            await OperationLogic.assertOperationAllowed(symbol, target.constructor, true, target);

            switch (operationType) {
                case OperationType.Execute:
                    await Operations.execute(target, symbol as ExecuteSymbol<Entity>, ...withPackage);
                    break;
                case OperationType.Delete:
                    await Operations.delete(target, symbol as DeleteSymbol<Entity>, ...withPackage);
                    break;
                case OperationType.ConstructorFrom: {
                    const result = await Operations.constructFrom(
                        target, symbol as ConstructSymbol<Entity, From<Entity>>, ...withPackage);
                    line.result = result?.toLite() ?? null;
                    break;
                }
                default:
                    throw new Error(`Unexpected operation type ${operationType}`);
            }

            line.finishTime = Clock.now;
            await line.save();
        }, l => l.target);
    }
}

/** Run ONE known Execute operation over every line. */
export class PackageExecuteAlgorithm<T extends Entity> implements IProcessAlgorithm {
    readonly allowParallelExecution = false;

    constructor(readonly symbol: ExecuteSymbol<T>) {
        if (symbol == null)
            throw new Error("PackageExecuteAlgorithm: the operation symbol is null — is it declared with init()?");
    }

    async execute(ep: ExecutingProcess): Promise<void> {
        const pack = await packageOf(ep, PackageEntity);
        const args = getOperationArgs(pack) ?? [];
        const lines = await PackageLogic.pendingLines(pack).toArray() as PackageLineEntity[];

        await ep.forEach(lines, l => `PackageLine ${l.id}`, async line => {
            await Operations.execute(await targetOf(line) as T, this.symbol, ...args);
            line.finishTime = Clock.now;
            await line.save();
        }, l => l.target);
    }
}

/** Delete every line's target, one line at a time. */
export class PackageDeleteAlgorithm<T extends Entity> implements IProcessAlgorithm {
    readonly allowParallelExecution = false;

    constructor(readonly symbol: DeleteSymbol<T>) {
        if (symbol == null)
            throw new Error("PackageDeleteAlgorithm: the operation symbol is null — is it declared with init()?");
    }

    async execute(ep: ExecutingProcess): Promise<void> {
        const pack = await packageOf(ep, PackageEntity);
        const args = getOperationArgs(pack) ?? [];
        const lines = await PackageLogic.pendingLines(pack).toArray() as PackageLineEntity[];

        await ep.forEach(lines, l => `PackageLine ${l.id}`, async line => {
            await Operations.delete(await targetOf(line) as T, this.symbol, ...args);
            line.finishTime = Clock.now;
            await line.save();
        }, l => l.target);
    }
}

/**
 * Build something per line and record WHAT was built in
 * `line.result`, which is what makes a "create an invoice per order" process reviewable afterwards.
 */
export class PackageConstructFromAlgorithm<F extends Entity, T extends Entity> implements IProcessAlgorithm {
    readonly allowParallelExecution = false;

    constructor(readonly symbol: ConstructSymbol<T, From<F>>) {
        if (symbol == null)
            throw new Error("PackageConstructFromAlgorithm: the operation symbol is null — is it declared with init()?");
    }

    async execute(ep: ExecutingProcess): Promise<void> {
        const pack = await packageOf(ep, PackageEntity);
        const args = getOperationArgs(pack) ?? [];
        const lines = await PackageLogic.pendingLines(pack).toArray() as PackageLineEntity[];

        await ep.forEach(lines, l => `PackageLine ${l.id}`, async line => {
            const result = await Operations.constructFrom(await targetOf(line) as F, this.symbol, ...args);
            if (result != null) {
                // There is no "allow save" scope to open — a
                // construct-from returning an unsaved entity is saved by whoever asked for it.
                if (result.isNew)
                    await result.save();
                line.result = result.toLite();
            }
            line.finishTime = Clock.now;
            await line.save();
        }, l => l.target);
    }
}
