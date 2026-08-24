import "@altea/altea/server"; // installs Entity.save()/delete()
import { type FluentStateMachine } from "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { UserHolder } from "@altea/altea/server/userHolder";
import { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import {
    ProcessEntity, ProcessAlgorithmSymbol, ProcessExceptionLineEntity, ProcessStateEnum,
    ProcessOperation, ProcessPermission, ProcessMessage,
} from "../data/Processes";
import { PackageEntity, PackageOperationEntity, PackageLineEntity } from "../data/Package";
import { ProcessRunner, ExecutingProcess } from "./ProcessRunner.server";
import { ProcessesServer } from "./ProcessesServer.server";

// Port of Signum.Processes' ProcessLogic.cs — the module's `start(sb)`: the tables, the algorithm registry,
// and the ProcessGraph state machine (Save / Execute / Suspend / Cancel / Plan / Retry).
//
// altea divergences, documented inline:
//  - `Polymorphic`-free: the registry is a Map keyed by the algorithm symbol's KEY, not the symbol OBJECT.
//    A symbol read back from the database is a fresh instance, so an identity-keyed Map misses on every run
//    that came from a row (the bug the scheduler port hit and fixed).
//  - Signum's `Graph<ProcessEntity, ProcessState>` carries fromStates / toStates and validates the
//    transition. altea's Graph.Execute supports the same via `getState` + `fromStates` / `toStates`.
//  - `QueryLogic.Expressions.Register(...)` for Processes / LastProcess / ExceptionLines is NOT ported (they
//    would make the isomorphic layer import the server query API — as in the scheduler port).
//  - `CacheLogic.ServerBroadcast`, `ExceptionLogic.DeleteLogs`, `PreDeleteSqlSync` and
//    `PropertyAuthLogic.SetMaxAutomaticUpgrade(p => p.User, Read)` are not ported (missing infrastructure).

export interface IProcessAlgorithm {
    /** May another process of the SAME algorithm run at the same time? (Signum's AllowParallelExecution) */
    readonly allowParallelExecution: boolean;
    execute(executingProcess: ExecutingProcess): Promise<void>;
}

export namespace ProcessLogic {

    /** Signum's `JustMyProcesses` — when true a process is pinned to the host that created it. */
    export let justMyProcesses = true;

    const registeredProcesses = new Map<string, IProcessAlgorithm>();
    const declared: ProcessAlgorithmSymbol[] = [];

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // A PermissionSymbol declared with init() is seeded by PermissionAuthLogic; reaching it is enough.
        void ProcessPermission.ViewProcessPanel;

        SymbolLogic.start(sb, ProcessAlgorithmSymbol, () => declared);

        sb.include(ProcessAlgorithmSymbol).withQuery();
        sb.include(ProcessEntity)
            .withStateMachine(p => p.state, registerProcessOperations)
            .withQuery();
        sb.include(ProcessExceptionLineEntity).withQuery();
        sb.include(PackageEntity).withQuery();
        sb.include(PackageOperationEntity).withQuery();
        sb.include(PackageLineEntity).withQuery();

        if (sb.webBuilder)
            ProcessesServer.start(sb.webBuilder);
    }

    /** Signum's `Register(processAlgorithm, algorithm)`. Call BEFORE start — the symbol table is seeded from
     *  the registered keys. */
    export function register(processAlgorithm: ProcessAlgorithmSymbol, algorithm: IProcessAlgorithm): void {
        if (processAlgorithm == null)
            throw new Error("ProcessLogic.register: the symbol is null — is it declared with init() inside a namespace?");
        if (registeredProcesses.has(processAlgorithm.key))
            throw new Error(`ProcessLogic.register: '${processAlgorithm.key}' is already registered`);

        registeredProcesses.set(processAlgorithm.key, algorithm);
        declared.push(processAlgorithm);
    }

    /** Signum's `Register(processAlgorithm, Action<ExecutingProcess>)` — the common case. */
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

    /** Signum's `GetProcessAlgorithm`. */
    export function getProcessAlgorithm(processAlgorithm: ProcessAlgorithmSymbol): IProcessAlgorithm {
        const algorithm = registeredProcesses.get(processAlgorithm.key);
        if (algorithm == null)
            throw new Error(`The process algorithm '${processAlgorithm.key}' is not registered`);
        return algorithm;
    }

    /** Signum's `ProcessAlgorithmSymbol.Create(data)` — a new process in the Created state. */
    export async function create(
        processAlgorithm: ProcessAlgorithmSymbol,
        data?: Lite<Entity> | null,
    ): Promise<ProcessEntity> {
        const user = UserHolder.currentUserLite();
        if (user == null)
            throw new Error("ProcessLogic.create: there is no current user to own the process");

        const process = ProcessEntity.create({
            algorithm: processAlgorithm,
            state: ProcessStateEnum.Created,
            data: data ?? null,
            machineName: justMyProcesses ? ProcessRunner.machineName() : ProcessEntity.None,
            applicationName: justMyProcesses ? ProcessRunner.applicationName() : ProcessEntity.None,
            user,
        });

        await process.save();
        return process;
    }

    /** Signum's `ExecuteTest` — run a process SYNCHRONOUSLY, bypassing the queue (for tests / the terminal). */
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

    // Signum's ProcessGraph — the state machine. Every transition that queues work wakes the runner up
    // AFTER the commit, so the runner never reads a row that is not there yet.
    function registerProcessOperations(sm: FluentStateMachine<ProcessEntity, ProcessStateEnum>): void {
        sm.withExecute(ProcessOperation.Save, {
        fromStates: [ProcessStateEnum.Created],
        toStates: [ProcessStateEnum.Created],
        canBeNew: true,
        canBeModified: true,
        execute: () => { },
        });

        sm.withExecute(ProcessOperation.Execute, {
        fromStates: [ProcessStateEnum.Created, ProcessStateEnum.Planned, ProcessStateEnum.Canceled, ProcessStateEnum.Suspended],
        toStates: [ProcessStateEnum.Queued],
        execute: (p: ProcessEntity) => {
            pinToThisMachine(p);
            p.state = ProcessStateEnum.Queued;
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
        fromStates: [ProcessStateEnum.Executing],
        toStates: [ProcessStateEnum.Suspending],
        execute: (p: ProcessEntity) => {
            p.state = ProcessStateEnum.Suspending;
            p.suspendDate = Clock.now;
            wakeUpOnCommit("ProcessOperation.Suspend");
        },
        });

        sm.withExecute(ProcessOperation.Cancel, {
        // Signum: cancelling an in-flight run would leave it running with a Canceled row, so suspend first.
        canExecute: (p: ProcessEntity) => ProcessRunner.isExecutingInThisMachine(p.toLite())
            ? ProcessMessage.ProcessExecutingSuspendFirst.niceToString() : null,
        fromStates: [ProcessStateEnum.Planned, ProcessStateEnum.Created, ProcessStateEnum.Suspended,
            ProcessStateEnum.Queued, ProcessStateEnum.Executing, ProcessStateEnum.Suspending],
        toStates: [ProcessStateEnum.Canceled],
        execute: (p: ProcessEntity) => {
            p.state = ProcessStateEnum.Canceled;
            p.cancelationDate = Clock.now;
        },
        });

        sm.withExecute(ProcessOperation.Plan, {
        fromStates: [ProcessStateEnum.Created, ProcessStateEnum.Canceled, ProcessStateEnum.Planned, ProcessStateEnum.Suspended],
        toStates: [ProcessStateEnum.Planned],
        execute: (p: ProcessEntity, args: unknown[]) => {
            pinToThisMachine(p);
            p.state = ProcessStateEnum.Planned;
            p.plannedDate = args[0] as Temporal.PlainDateTime;
            wakeUpOnCommit("ProcessOperation.Plan");
        },
        });

        sm.withConstructFrom(ProcessEntity, ProcessOperation.Retry, {
        canConstruct: (p: ProcessEntity) => [ProcessStateEnum.Error, ProcessStateEnum.Canceled,
            ProcessStateEnum.Finished, ProcessStateEnum.Suspended].includes(p.state)
            ? null : `A process can only be retried from Error / Canceled / Finished / Suspended`,
        toStates: [ProcessStateEnum.Created],
        construct: async (p: ProcessEntity) => await create(p.algorithm, p.data),
        });
    }
}