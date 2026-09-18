import "@altea/altea/server"; // installs Entity.save()/delete()
import { type FluentStateMachine } from "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { UserHolder } from "@altea/altea/server/userHolder";
import { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import { Temporal, type int } from "@altea/altea/data/basics";
import { table } from "@altea/altea/server/table";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { AutoDynamicQueryCore } from "@altea/altea/server/dynamicQuery/dynamicQueryCore";
import { Clock } from "@altea/altea/data/utils/clock";
import {
    ProcessEntity, ProcessAlgorithmSymbol, ProcessExceptionLineEntity, ProcessState,
    ProcessOperation, ProcessPermission, ProcessMessage,
} from "../data/Processes";
import {
    PackageEntity, PackageOperationEntity, PackageLineEntity,
    PackageLastProcessRowModel, PackageOperationLastProcessRowModel, PackageLineLastProcessRowModel,
} from "../data/Package";
import { ProcessRunner, ExecutingProcess } from "./ProcessRunner";
import { ProcessesServer } from "./ProcessesServer";
import { PermissionLogic } from "@altea/altea-auth/server/PermissionLogic";

// The module's `start(sb)`: the tables, the algorithm registry, and the ProcessGraph state machine
// (Save / Execute / Suspend / Cancel / Plan / Retry).
//
// **The registry is keyed by the algorithm symbol's KEY, not the symbol OBJECT.** A symbol read back from
// the database is a fresh instance, so an identity-keyed Map misses on every run that came from a row —
// the bug the scheduler port hit and fixed.
//
// Port of Signum.Processes' ProcessLogic.cs — see port/Processes.md.
//  - `CacheLogic.ServerBroadcast`, `ExceptionLogic.DeleteLogs`, `PreDeleteSqlSync` and
//    `PropertyAuthLogic.SetMaxAutomaticUpgrade(p => p.User, Read)` are not ported (missing infrastructure).

export interface IProcessAlgorithm {
    /** May another process of the SAME algorithm run at the same time? */
    readonly allowParallelExecution: boolean;
    execute(executingProcess: ExecutingProcess): Promise<void>;
}

export namespace ProcessLogic {

    /** When true a process is pinned to the host that created it. */
    export let justMyProcesses = true;

    const registeredProcesses = new Map<string, IProcessAlgorithm>();
    const declared: ProcessAlgorithmSymbol[] = [];

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        PermissionLogic.registerPermissions(ProcessPermission.ViewProcessPanel);

        SymbolLogic.start(sb, ProcessAlgorithmSymbol, () => declared);

        sb.include(ProcessAlgorithmSymbol).withQuery();
        sb.include(ProcessEntity)
            .withStateMachine(p => p.state, registerProcessOperations)
            .withQuery();
        // Signum's `Duration` column on the process: how long the run took. Signum gets the token from
        // the `[ExpressionField]` property itself; altea registers it, because a `@quoted` method is not a
        // member of the type as far as the query metadata is concerned. The caption is a MESSAGE rather
        // than `nicePropertyName(p => p.durationMilliseconds())`: that resolves under (declaring type,
        // member) and a quoted method has no translatable <Member> entry, so it would humanise to
        // "Duration milliseconds" in every culture. Signum's second expression, `DurationSpan`, is not
        // ported — see the note in data/Processes.
        QueryLogic.expressions.register(ProcessEntity, p => p.durationMilliseconds(),
            ProcessMessage.Duration);

        sb.include(ProcessExceptionLineEntity).withQuery();
        sb.include(PackageEntity).withQuery();
        sb.include(PackageOperationEntity).withQuery();
        sb.include(PackageLineEntity).withQuery();

        // The three *LastProcess queries. Each is the plain query PLUS the last process that ran the
        // package and, through it, what failed — which Signum reaches through the
        // [AutoExpressionField] extension methods `LastProcess()` and `Exception(pl, p)`; altea has
        // neither — and the second takes a PARAMETER, which is not a query token here at all — so the
        // subqueries are spelled out inline. `.$v` unwraps the Promise a terminal is typed with: it is
        // the compile-time Promise<T> -> T marker, an identity at the expression level (SQL has no
        // async), and it is what lets an aggregate stand in a PROJECTION rather than be awaited.
        //
        // A projection, so each is an AutoDynamicQueryCore over the projected Query rather than
        // `withQuery()`, which takes none, and each is named by its row model.
        // Every subquery is written out rather than shared through a local helper: a local-function
        // call inside a query lambda has no SQL translation, so the repetition is the price of the
        // two expressions this module does not register.
        QueryLogic.queries.register(PackageLastProcessRowModel, () => new AutoDynamicQueryCore(() =>
            table(PackageEntity).map(pk => PackageLastProcessRowModel.create({
                entity: pk.toLite(),
                id: pk.id as int,
                name: pk.name,
                numLines: table(PackageLineEntity).filter(l => l.package.is(pk.toLite())).count().$v as int,
                lastProcess: table(ProcessEntity).filter(p => p.data!.is(pk.toLite()))
                    .orderByDescending(p => p.executionStart!).firstOrNull().$v?.toLite() ?? null,
                numErrors: table(PackageLineEntity)
                    .filter(l => l.package.is(pk.toLite()) && table(ProcessExceptionLineEntity)
                        .filter(el => el.line!.is(l.toLite()) && el.process.is(table(ProcessEntity).filter(p => p.data!.is(pk.toLite()))
                            .orderByDescending(p => p.executionStart!).firstOrNull().$v!.toLite()))
                        .count().$v > 0)
                    .count().$v as int,
            }))));

        QueryLogic.queries.register(PackageOperationLastProcessRowModel, () => new AutoDynamicQueryCore(() =>
            table(PackageOperationEntity).map(pk => PackageOperationLastProcessRowModel.create({
                entity: pk.toLite(),
                id: pk.id as int,
                name: pk.name,
                operation: pk.operation,
                numLines: table(PackageLineEntity).filter(l => l.package.is(pk.toLite())).count().$v as int,
                lastProcess: table(ProcessEntity).filter(p => p.data!.is(pk.toLite()))
                    .orderByDescending(p => p.executionStart!).firstOrNull().$v?.toLite() ?? null,
                numErrors: table(PackageLineEntity)
                    .filter(l => l.package.is(pk.toLite()) && table(ProcessExceptionLineEntity)
                        .filter(el => el.line!.is(l.toLite()) && el.process.is(table(ProcessEntity).filter(p => p.data!.is(pk.toLite()))
                            .orderByDescending(p => p.executionStart!).firstOrNull().$v!.toLite()))
                        .count().$v > 0)
                    .count().$v as int,
            }))));

        QueryLogic.queries.register(PackageLineLastProcessRowModel, () => new AutoDynamicQueryCore(() =>
            table(PackageLineEntity).map(pl => PackageLineLastProcessRowModel.create({
                entity: pl.toLite(),
                package: pl.package,
                id: pl.id as int,
                target: pl.target,
                result: pl.result,
                finishTime: pl.finishTime,
                lastProcess: table(ProcessEntity).filter(p => p.data!.is(pl.package))
                    .orderByDescending(p => p.executionStart!).firstOrNull().$v?.toLite() ?? null,
                exception: table(ProcessExceptionLineEntity)
                    .filter(el => el.line!.is(pl.toLite()) && el.process.is(table(ProcessEntity).filter(p => p.data!.is(pl.package))
                        .orderByDescending(p => p.executionStart!).firstOrNull().$v!.toLite()))
                    .singleOrNull().$v?.exception ?? null,
            }))));
        if (sb.webBuilder)
            ProcessesServer.start(sb.webBuilder);
    }

    /** Register an algorithm. Call BEFORE start — the symbol table is seeded from
     *  the registered keys. */
    export function register(processAlgorithm: ProcessAlgorithmSymbol, algorithm: IProcessAlgorithm): void {
        if (processAlgorithm == null)
            throw new Error("ProcessLogic.register: the symbol is null — is it declared with init() inside a namespace?");
        if (registeredProcesses.has(processAlgorithm.key))
            throw new Error(`ProcessLogic.register: '${processAlgorithm.key}' is already registered`);

        registeredProcesses.set(processAlgorithm.key, algorithm);
        declared.push(processAlgorithm);
    }

    /** The common case. */
    export function registerAction(
        processAlgorithm: ProcessAlgorithmSymbol,
        action: (executingProcess: ExecutingProcess) => Promise<void>,
        options?: { allowParallelExecution?: boolean },
    ): void {
        register(processAlgorithm, {
            allowParallelExecution: options?.allowParallelExecution ?? false,
            execute: action,
        });
    }

    /** The registered algorithm for a symbol, or throw. */
    export function getProcessAlgorithm(processAlgorithm: ProcessAlgorithmSymbol): IProcessAlgorithm {
        const algorithm = registeredProcesses.get(processAlgorithm.key);
        if (algorithm == null)
            throw new Error(`The process algorithm '${processAlgorithm.key}' is not registered`);
        return algorithm;
    }

    /** A new process in the Created state. */
    export async function create(
        processAlgorithm: ProcessAlgorithmSymbol,
        data?: Lite<Entity> | null,
    ): Promise<ProcessEntity> {
        const user = UserHolder.currentUserLite();
        if (user == null)
            throw new Error("ProcessLogic.create: there is no current user to own the process");

        const process = ProcessEntity.create({
            algorithm: processAlgorithm,
            state: ProcessState.Created,
            data: data ?? null,
            machineName: justMyProcesses ? ProcessRunner.machineName() : ProcessEntity.None,
            applicationName: justMyProcesses ? ProcessRunner.applicationName() : ProcessEntity.None,
            user,
        });

        await process.save();
        return process;
    }

    /** Run a process SYNCHRONOUSLY, bypassing the queue (for tests / the terminal). */
    export async function executeTest(process: ProcessEntity): Promise<ProcessEntity> {
        process.queuedDate = Clock.now;
        const ep = new ExecutingProcess(getProcessAlgorithm(process.algorithm), process);
        await ep.takeForThisMachine();
        await ep.execute();
        return ep.currentProcess;
    }

    function pinToThisMachine(p: ProcessEntity): void {
        p.machineName = justMyProcesses ? ProcessRunner.machineName() : ProcessEntity.None;
        p.applicationName = justMyProcesses ? ProcessRunner.applicationName() : ProcessEntity.None;
    }

    function wakeUpOnCommit(reason: string): void {
        Transaction.postRealCommit(async () => { ProcessRunner.wakeUp(reason); });
    }

    // The state machine. Every transition that queues work wakes the runner up
    // AFTER the commit, so the runner never reads a row that is not there yet.
    function registerProcessOperations(sm: FluentStateMachine<ProcessEntity, ProcessState>): void {
        sm.withExecute(ProcessOperation.Save, {
        fromStates: [ProcessState.Created],
        toStates: [ProcessState.Created],
        canBeNew: true,
        canBeModified: true,
        execute: () => { },
        });

        sm.withExecute(ProcessOperation.Execute, {
        fromStates: [ProcessState.Created, ProcessState.Planned, ProcessState.Canceled, ProcessState.Suspended],
        toStates: [ProcessState.Queued],
        execute: (p: ProcessEntity) => {
            pinToThisMachine(p);
            p.state = ProcessState.Queued;
            p.queuedDate = Clock.now;
            p.executionStart = null;
            p.executionEnd = null;
            p.suspendDate = null;
            p.progress = null;
            p.exception = null;
            p.exceptionDate = null;
            wakeUpOnCommit("ProcessOperation.Execute");
        },
        });

        sm.withExecute(ProcessOperation.Suspend, {
        fromStates: [ProcessState.Executing],
        toStates: [ProcessState.Suspending],
        execute: (p: ProcessEntity) => {
            p.state = ProcessState.Suspending;
            p.suspendDate = Clock.now;
            wakeUpOnCommit("ProcessOperation.Suspend");
        },
        });

        sm.withExecute(ProcessOperation.Cancel, {
        // Cancelling an in-flight run would leave it running with a Canceled row, so suspend first.
        canExecute: (p: ProcessEntity) => ProcessRunner.isExecutingInThisMachine(p.toLite())
            ? ProcessMessage.ProcessExecutingSuspendFirst.niceToString() : null,
        fromStates: [ProcessState.Planned, ProcessState.Created, ProcessState.Suspended,
            ProcessState.Queued, ProcessState.Executing, ProcessState.Suspending],
        toStates: [ProcessState.Canceled],
        execute: (p: ProcessEntity) => {
            p.state = ProcessState.Canceled;
            p.cancelationDate = Clock.now;
        },
        });

        sm.withExecute(ProcessOperation.Plan, {
        fromStates: [ProcessState.Created, ProcessState.Canceled, ProcessState.Planned, ProcessState.Suspended],
        toStates: [ProcessState.Planned],
        execute: (p: ProcessEntity, args: unknown[]) => {
            pinToThisMachine(p);
            p.state = ProcessState.Planned;
            p.plannedDate = args[0] as Temporal.PlainDateTime;
            wakeUpOnCommit("ProcessOperation.Plan");
        },
        });

        sm.withConstructFrom(ProcessEntity, ProcessOperation.Retry, {
        canConstruct: (p: ProcessEntity) => [ProcessState.Error, ProcessState.Canceled,
            ProcessState.Finished, ProcessState.Suspended].includes(p.state)
            ? null : `A process can only be retried from Error / Canceled / Finished / Suspended`,
        toStates: [ProcessState.Created],
        construct: async (p: ProcessEntity) => await create(p.algorithm, p.data),
        });
    }
}