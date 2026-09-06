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

// Port of Signum.Processes' PackageLogic.cs — the half of the module that turns a SET OF ENTITIES into
// work a process walks. A package is a row plus one PackageLineEntity per element; a process algorithm
// reads the lines, does something per line, and stamps `finishTime` — so a run that dies halfway can be
// retried and picks up where it stopped (`Lines().Where(a => a.FinishTime == null)`, kept verbatim).
//
// This used to be recorded as NOT ported, and CLAUDE.md said so: altea-workflow's timeout process walks
// its own package lines, which was true and made the module look avoidable. It is not — Southwind's
// Orders domain is built on it (`OrderTask.CancelOldOrdersWithProcess` → `OrderProcess.CancelOrders` →
// `PackageExecuteAlgorithm<OrderEntity>(OrderOperation.Cancel)`, plus the `CancelWithProcess` contextual
// operation), and without it eastwind had to invent different tasks, which a Southwind database then read
// as four symbols removed and four added.
//
// **Where the TABLES are.** Signum splits `PackageLogic.Start(sb, packages, packageOperations)` between
// including the three tables + their queries and registering the algorithm. altea's `ProcessLogic.start`
// already includes all three unconditionally and registers the three `*LastProcess` queries, so what is
// left here is the ALGORITHMS and the helpers that build a package. Hence no `packages` /
// `packageOperations` flags: there is nothing left for them to gate.
//
// **Order does not matter**, unlike what `ProcessLogic.register`'s own doc-comment says ("Call BEFORE
// start — the symbol table is seeded from the registered keys"). `SymbolLogic.start` stores `getSymbols`
// as a THUNK and calls it from `schema.generating` / `schema.synchronizing`, so every algorithm registered
// before the schema is built is seeded, whichever side of `ProcessLogic.start` it landed on. Signum's own
// `ProcessLogic.AssertStarted(sb)` guard therefore has no counterpart worth writing.
//
// altea divergences:
//  - **no `ProgressProxy` argument.** Signum appends one to every operation's args so a long per-line
//    operation can report sub-progress; altea has no such type, and the operation signatures take plain
//    args. Cancellation is still honoured, at the LINE boundary, because `ExecutingProcess.forEach`
//    checks the signal (Signum's `ForEachLine` does the same).
//  - **`ExceptionLogic.DeleteLogs` is not ported** — the note every log-owning module here carries — so
//    `ExceptionLogic_DeletePackages` has no counterpart.
//  - **the two `PreDeleteSqlSync` cascades are not ported.** Signum sweeps a package line whose TARGET or
//    RESULT type is being removed, and everything belonging to a removed OPERATION symbol. Both need
//    `Administrator.unsafeDeletePreCommand` over an `@implementedByAll` discriminator, which altea's sync
//    has no counterpart for (altea-view-log records the same gap for its own target column).
//  - **`RegisterUserTypeCondition` is not ported**: its middle rule (`PackageOperationEntity` visible when
//    a process the user owns points at it) is a subquery over another type's condition, which altea's
//    TypeConditionLogic cannot express — the accommodation eastwind's user-asset scoping already
//    documents. An app that needs it registers the three conditions itself.
//  - `CreateLinesQuery` keeps its own name here (`createLinesFromQuery`), because `createLines` cannot be
//    overloaded on a Query vs an array in a way TypeScript resolves well.

export namespace PackageLogic {

    /**
     * Signum's `[AutoExpressionField] Lines(this PackageEntity p)`. A SERVER helper rather than a
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
     * Signum's `CreateLines(package, lites)` — SAVE the package, then insert one line per element, SET-BASED
     * and grouped by concrete type (a `Lite<Entity>` list may be polymorphic, and the insert reads from that
     * type's own table). A package can hold hundreds of thousands of elements, so a row-by-row save is not
     * an option; Signum chunks at 100 lites per statement and so does this.
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

    /** Signum's `CreateLines(package, entities)` overload — the same, from full entities. */
    export function createLinesFromEntities(pack: PackageEntity, entities: readonly Entity[]): Promise<PackageEntity> {
        return createLines(pack, entities.map(e => e.toLite()));
    }

    /**
     * Signum's `CreateLinesQuery` — one statement, no ids in memory at all. This is what a task building a
     * package from "every order older than a week" should use.
     */
    export async function createLinesFromQuery<T extends Entity>(pack: PackageEntity, query: Query<T>): Promise<PackageEntity> {
        await pack.save();
        const packLite = pack.toLite();
        await query.executeInsert(PackageLineEntity, e => ({ package: packLite, target: e.toLite() }));
        return pack;
    }

    /** Signum's `CreatePackageOperation` — the process behind a contextual "run this operation on all of
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

/** The package a running process is walking — Signum's `(PackageEntity)executingProcess.Data!`. */
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
 * Signum's `PackageOperationAlgorithm` — apply the operation the package NAMES to each of its lines,
 * dispatching on that operation's kind. The one algorithm that is registered by the module itself
 * (`PackageLogic.start`), because the operation is data rather than a compile-time choice.
 */
export class PackageOperationAlgorithm implements IProcessAlgorithm {
    readonly allowParallelExecution = false;

    async execute(ep: ExecutingProcess): Promise<void> {
        const pack = await packageOf(ep, PackageOperationEntity);
        const symbol = pack.operation;

        // Signum appends the package itself to the args when it carries a ConfigString, so an algorithm
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

/** Signum's `PackageExecuteAlgorithm<T>` — run ONE known Execute operation over every line. */
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

/** Signum's `PackageDeleteAlgorithm<T>`. */
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
 * Signum's `PackageConstructFromAlgorithm<F, T>` — build something per line and record WHAT was built in
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
                // Signum wraps the save in `OperationLogic.AllowSave<T>()`; altea has no such scope — a
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
