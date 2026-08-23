import { Entity, type Type } from "../data/entity";
import type { Lite } from "../data/lite";
import { OperationSymbol } from "../data/operations";
import type {
    ExecuteSymbol, DeleteSymbol,
    ConstructSymbol, From, FromMany,
} from "../data/operations";
import { OperationLogEntity } from "../data/operationLog";
import { resolveCleanType, resolveType } from "../data/registration";
import { Temporal } from "../data/basics";
import { withQuoted } from "../data/decorators";
import { OperationMessage } from "../data/uiMessages";
import { table } from "./table";
import { QueryLogic } from "./dynamicQuery/queryLogic";
import type { SchemaBuilder } from "./schema/schemaBuilder";
import { SymbolLogic } from "./symbolLogic";
import { Saver } from "./saver";
import { ExceptionLogic } from "./exceptionLogic";
import { UnauthorizedAccessException } from "./exceptions";
import { UserHolder } from "./userHolder";
import "./dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import {
    OperationType,
    type IOperation, type IEntityOperation, type IExecuteOperation, type IDeleteOperation,
    type IConstructOperation, type IConstructorFromOperation, type IConstructorFromManyOperation,
} from "./operation";

// Port of Signum's OperationLogic (Signum/Operations/OperationLogic.cs): the operation
// registry + the service entrypoints. (OperationType + the IOperation interfaces live in
// ./operation; the Graph.* operation classes in ./graph.) Deferred vs Signum:
// OperationLogEntity + logging, authorization, the RequiresSaveOperation save-guard.
// Divergence: the registry is keyed by OperationSymbol alone (not Signum's polymorphic
// (type,symbol)) — one impl per symbol, no operation inheritance — which is all Southwind needs.
// Each operation does declare its owning entity type explicitly (`entityType` in the Graph options,
// Signum's OverridenType), because a generic parameter is erased at runtime and the owner must be
// EXACT: it is the key the reflection metadata blob ships the operation under.

const operations = new Map<OperationSymbol, IOperation>();

// entity ctor → the operations registered on it, maintained alongside `operations`. Rebuilt on every
// register/unregister rather than derived on demand, because the metadata blob reads it per request.
const operationsByType = new Map<Function, Set<OperationSymbol>>();

/** The second half of a surround handler — Signum's `IDisposable.Dispose`. */
export type SurroundOperationAfter = () => void | Promise<void>;

export interface SurroundOperationContext {
    readonly operation: IOperation;
    /** The log row being built. A handler may write onto it (that is how DiffLog stores its dumps). */
    readonly log: OperationLogEntity;
    /** The entity the operation runs on — null for a Construct (there is nothing yet). */
    readonly entity: Entity | null;
    readonly args: unknown[];
}

export type SurroundOperationHandler =
    (ctx: SurroundOperationContext) => SurroundOperationAfter | void | Promise<SurroundOperationAfter | void>;

/**
 * The SCOPING half of Signum's one `SurroundOperation` event — a handler that WRAPS the whole operation
 * rather than observing its two ends. See {@link OperationLogic.aroundOperation}.
 */
export type AroundOperationHandler =
    (ctx: SurroundOperationContext, fn: () => Promise<unknown>) => Promise<unknown>;

/** The two period expressions {@link OperationLogic.registerSystemValidTokens} stamps on a versioned type. */
export interface ISystemVersioned extends Entity {
    systemValidFrom?(): Temporal.PlainDateTime | null;
    systemValidTo?(): Temporal.PlainDateTime | null;
}

export namespace OperationLogic {
    // Signum's OperationLogic.Register(replace). Validates the operation, then stores it
    // by symbol. `replace` allows an external module to swap an operation's impl.
    export function register(operation: IOperation, replace = false): void {
        if (!replace && operations.has(operation.operationSymbol))
            throw new Error(`Operation '${operation.operationSymbol.key}' has already been registered (pass replace=true to override).`);
        operation.assertIsValid();
        const previous = operations.get(operation.operationSymbol);
        if (previous != null && previous.entityType !== operation.entityType)
            operationsByType.get(previous.entityType)?.delete(operation.operationSymbol);
        operations.set(operation.operationSymbol, operation);
        let byType = operationsByType.get(operation.entityType);
        if (byType == null) operationsByType.set(operation.entityType, byType = new Set());
        byType.add(operation.operationSymbol);
    }

    // Remove an operation entirely (so it can be re-registered differently, or dropped).
    export function unregister(symbol: OperationSymbol): boolean {
        const op = operations.get(symbol);
        if (op != null)
            operationsByType.get(op.entityType)?.delete(symbol);
        return operations.delete(symbol);
    }

    export function registeredOperations(): OperationSymbol[] {
        return [...operations.keys()];
    }

    export function tryFindOperation(symbol: OperationSymbol): IOperation | undefined {
        return operations.get(symbol);
    }
    export function findOperation(symbol: OperationSymbol): IOperation {
        const op = operations.get(symbol);
        if (op == null)
            throw new Error(`Operation '${symbol.key}' is not registered.`);
        return op;
    }

    // Signum's `OperationLogic.AllowOperation` event (Operations/OperationLogic.cs) — a pluggable
    // authorization gate. altea core can't import altea-auth, so an auth module installs a hook via
    // `onAllowOperation`; `assertOperationAllowed` (execute-time, inUserInterface:false) throws when
    // denied, and `isOperationAllowed` (button-state, inUserInterface:true) is the boolean form used by
    // getEntityPack to hide operations. `inUserInterface` distinguishes "the client may click it" (Allow)
    // from "server code may run it" (DBOnly or Allow). No hook installed → open (returns true / no throw).
    export type AllowOperationHook =
        (symbol: OperationSymbol, entityType: Function, inUserInterface: boolean, entity: Entity | null) => Promise<boolean>;
    const allowOperationHooks: AllowOperationHook[] = [];
    export function onAllowOperation(fn: AllowOperationHook): void { allowOperationHooks.push(fn); }

    export async function isOperationAllowed(symbol: OperationSymbol, entityType: Function, inUserInterface: boolean, entity: Entity | null): Promise<boolean> {
        for (const h of allowOperationHooks)
            if (!(await h(symbol, entityType, inUserInterface, entity)))
                return false;
        return true;
    }
    export async function assertOperationAllowed(symbol: OperationSymbol, entityType: Function, inUserInterface: boolean, entity: Entity | null): Promise<void> {
        if (!(await isOperationAllowed(symbol, entityType, inUserInterface, entity)))
            throw new UnauthorizedAccessException(`Operation '${symbol.key}' is not authorized`);
    }

    /**
     * The operations registered on an entity type — INCLUDING those declared on an abstract base it
     * inherits from, which is how Signum's polymorphic (type, symbol) registry behaves and what a
     * concrete subtype's frame must show. Used by the metadata builder and the auth admin pack.
     *
     * Was previously derived from the `<Type>Operation.<Member>` key convention, which silently missed
     * every operation whose container is not named after its type (and every abstract-base one).
     */
    export function operationsForType(ctor: Function): OperationSymbol[] {
        const result: OperationSymbol[] = [];
        for (const [owner, symbols] of operationsByType)
            if (owner === ctor || ctor.prototype instanceof owner)
                // A symbol can be indexed before its implementation is registered (see registerForType);
                // one that never gets an implementation is not an operation of this type.
                for (const s of symbols)
                    if (operations.has(s)) result.push(s);
        return result;
    }

    /** As {@link operationsForType}, by clean type name (the auth admin pack works in names). */
    export function operationsForTypeName(cleanTypeName: string): OperationSymbol[] {
        const ctor = resolveCleanType(cleanTypeName) ?? resolveType(cleanTypeName);
        return ctor == null ? [] : operationsForType(ctor);
    }

    /**
     * ALSO register an existing operation on another type (Signum's polymorphic (type, symbol) registry).
     * For an operation whose owner is a TS INTERFACE — which has no runtime constructor, so it cannot be
     * an `entityType` — each implementor adds itself as it is wired up: SchedulerLogic does this for
     * `ITaskOperation.ExecuteSync` from `registerExecuteTask`. The implementation stays the one registered
     * under the symbol; only the ownership set widens.
     *
     * Order-independent by design: the symbol need NOT be registered yet. An implementor can wire itself
     * up before the module that owns the operation gets to its graph (SimpleTaskLogic.start runs before
     * SchedulerLogic registers ITaskOperation), and readers skip a symbol with no implementation anyway.
     */
    export function registerForType(symbol: OperationSymbol, ctor: Function): void {
        let byType = operationsByType.get(ctor);
        if (byType == null) operationsByType.set(ctor, byType = new Set());
        byType.add(symbol);
    }

    /** Every entity ctor that has at least one operation registered on it (the metadata builder). */
    export function typesWithOperations(): Function[] {
        return [...operationsByType.keys()];
    }

    /**
     * Signum's `OperationLogic.SurroundOperation` — wrap every operation execution. A handler sees the
     * OperationLogEntity being built, the entity the operation runs on, and its args; it may return an
     * "after" callback that runs once the target is known (Signum returns an IDisposable, and the `using`
     * scope is what runs the second half). The first and only consumer is @altea/altea-diff-log, which
     * records the entity's dump before and after.
     *
     * A throwing handler is logged and skipped: an auditing concern must not break what it observes.
     */
    export const surroundOperation: SurroundOperationHandler[] = [];

    /**
     * The other half of Signum's `SurroundOperation`: a handler that establishes an ambient SCOPE around
     * the whole operation — the log build, the execution and the log save. Its consumer is
     * @altea/altea-isolation, which runs an operation inside the isolation of the row it targets.
     *
     * ALTEA: Signum has ONE event, because a C# `IDisposable` expresses both "observe the two ends" and
     * "hold a scope". A JavaScript ambient is an AsyncLocalStorage, which cannot be entered without a
     * callback, so the two uses need two shapes — and their CONTRACTS differ, which is why merging them
     * would be wrong in either direction:
     *  - {@link OperationLogic.surroundOperation} observes. A throwing handler is logged and skipped
     *    (auditing must not break what it observes), and its "after" half runs at a precise point — after
     *    the target is known, before the log is saved — so what it writes onto the log persists.
     *  - `aroundOperation` scopes. A throwing handler FAILS the operation, because it decides what the
     *    operation is allowed to see.
     * Handlers compose, first-registered outermost.
     */
    export const aroundOperation: AroundOperationHandler[] = [];

    // Signum's OperationLogic.Start: wires the OperationSymbol table through SymbolLogic,
    // seeding only the RegisteredOperations, and includes the OperationLogEntity table + its query
    // (Signum's sb.Include<OperationLogEntity>().WithQuery(...)). Call AFTER the graphs have registered.
    export function start(sb: SchemaBuilder): void {
        SymbolLogic.start(sb, OperationSymbol, () => registeredOperations());
        sb.include(OperationLogEntity).withQuery();

        // Signum's `sb.Schema.SchemaCompleted += () => RegisterCurrentLogs(sb.Schema)`: every
        // @systemVersioned type gains the `PreviousOperationLog` sub-token, so a query over that type's
        // HISTORY can show who produced each version. Deferred to schemaCompleted because the set of
        // versioned tables is only final once every module has run its includes.
        sb.schema.schemaCompleted.push(schema => {
            for (const [type, table] of schema.tables)
                if (table.systemVersioned != null) {
                    registerPreviousLog(type);
                    registerSystemValidTokens(type);
                }
        });
    }

    /**
     * Signum's `OperationLogic.RegisterPreviousLog<T>` — the `PreviousOperationLog` expression: for a
     * given ROW VERSION, the operation log entry that produced it, i.e. the earliest successful log on
     * this entity whose `end` falls inside the version's system period.
     *
     * Only meaningful on a @systemVersioned type (`systemPeriod()` throws otherwise), which is why
     * {@link start} registers it exactly for those. @altea/altea-time-machine's version grid is the
     * consumer: it columns `Entity.PreviousOperationLog.Start / .User / .Operation`.
     *
     * altea divergence: Signum writes `e.SystemPeriod().Contains(ol.End.Value)`, but altea's
     * `NullableInterval.contains` is an IN-MEMORY method on the materialised interval (see
     * server/systemTime.ts) — only `.min` / `.max` lower to the period columns. So the containment is
     * spelled out against those two bounds, with `Temporal.PlainDateTime.compare(a, b) <op> 0` (the form
     * the provider translates, Temporal having no relational operators). Signum's `TimeZoneMode.Local`
     * branch has no counterpart: altea stores naive local timestamps throughout.
     */
    /**
     * The `systemValidFrom` / `systemValidTo` query tokens of a @systemVersioned type — WHEN this row
     * version was current. They are what a history query orders and identifies a version by, so the Time
     * Machine (@altea/altea-time-machine) cannot address a version without them.
     *
     * altea divergence: Signum ships them as built-in `Entity.SystemValidFrom` / `.SystemValidTo` tokens
     * off its `Entity` root token. altea has NO `Entity` root token (its tokens are rootless), and no
     * system-time tokens existed at all — so they are registered EXPRESSIONS over `systemPeriod()`, whose
     * `.min` / `.max` the binder already lowers to the period columns. That makes them rootless and
     * camelCase like every other altea token, which is why `QueryTokenString.systemValidFrom()` emits the
     * bare key.
     */
    export function registerSystemValidTokens<T extends Entity>(type: Type<T>): void {
        const proto = (type as unknown as { prototype: Record<string, unknown> }).prototype;

        proto.systemValidFrom = withQuoted(function (this: Entity): Temporal.PlainDateTime | null {
            return this.systemPeriod().min;
        });
        proto.systemValidTo = withQuoted(function (this: Entity): Temporal.PlainDateTime | null {
            return this.systemPeriod().max;
        });

        QueryLogic.expressions.register(type, (e: ISystemVersioned) => e.systemValidFrom!(),
            { niceName: () => OperationMessage.SystemValidFrom.niceToString() });
        QueryLogic.expressions.register(type, (e: ISystemVersioned) => e.systemValidTo!(),
            { niceName: () => OperationMessage.SystemValidTo.niceToString() });
    }

    export function registerPreviousLog<T extends Entity>(type: Type<T>): void {
        const proto = (type as unknown as { prototype: Record<string, unknown> }).prototype;

        proto.previousOperationLog = withQuoted(function (this: Entity): Promise<OperationLogEntity | null> {
            return table(OperationLogEntity)
                .filter(ol => ol.target!.is(this)
                    && ol.exception == null
                    && ol.end != null
                    && Temporal.PlainDateTime.compare(this.systemPeriod().min!, ol.end!) <= 0
                    && (this.systemPeriod().max == null
                        || Temporal.PlainDateTime.compare(ol.end!, this.systemPeriod().max!) < 0))
                .orderBy(a => a.end)
                .firstOrNull();
        });

        QueryLogic.expressions.register(type, (e: IOperationLogged) => e.previousOperationLog!(),
            { niceName: () => OperationMessage.PreviousOperationLog.niceToString() });
    }
}

/**
 * The expression {@link OperationLogic.registerPreviousLog} stamps onto every @systemVersioned type.
 * Declared as an interface (rather than widening `Entity`) for the same reason altea-alert declares
 * `IAlertTarget`: the member exists only on the types that were registered.
 */
export interface IOperationLogged extends Entity {
    previousOperationLog?(): Promise<OperationLogEntity | null>;
}

// Signum wraps every operation execution in a transaction that also writes an OperationLogEntity
// (OperationLogic.OnSuspiciousOperation / the OperationRunner). altea has no ambient transaction yet, so
// the log is a best-effort side write: the operation runs, then the log row is persisted. A log-save
// failure is swallowed (console.error) so it can NEVER mask the operation's own result — in particular,
// if the OperationLog table hasn't been created yet (needs `terminal sync`), operations keep working and
// logging is simply skipped. Divergence from Signum, whose logging is transactional.
async function logOperation<T>(
    symbol: OperationSymbol,
    origin: Entity | null,
    entity: Entity | null,
    args: unknown[],
    run: () => Promise<T>,
    getTarget: (result: T) => Entity | null,
): Promise<T> {
    // Signum's object initializer (`new OperationLogEntity { Operation = …, Start = …, User = … }`), which
    // is altea's `create` — NOT a bare `new`. A MIXIN's field initializers are applied by the factory
    // (applyMixinDefaults): altea inlines mixin fields onto the owner without declaring them there, so
    // `new` leaves them undefined and the implicit NotNull validator then rejects the row. That is not
    // hypothetical for this type — @altea/altea-diff-log's mixin adds a non-nullable `cleaned` flag.
    const log = OperationLogEntity.create({
        operation: symbol,
        origin: origin == null || origin.isNew ? null : origin.toLite(),
        user: UserHolder.currentUserLite(),
        start: Temporal.Now.plainDateTimeISO(),
    });

    // The SCOPING half (OperationLogic.aroundOperation): establish every registered ambient around the
    // whole thing — the surround handlers, the execution and the log save — before anything reads the
    // database. @altea/altea-isolation runs the operation inside the isolation of the row it targets, and
    // the log row it writes has to land in that same isolation.
    if (OperationLogic.aroundOperation.length > 0) {
        const ctx: SurroundOperationContext = { operation: OperationLogic.findOperation(symbol), log, entity, args };
        let composed = () => body();
        for (const handler of [...OperationLogic.aroundOperation].reverse()) {
            const inner = composed;
            composed = () => handler(ctx, inner) as Promise<T>;
        }
        return await composed();
    }
    return await body();

    async function body(): Promise<T> {
        // Signum's `OperationLogic.SurroundOperation` (an event returning an IDisposable). Each handler may
        // observe the log + entity BEFORE the operation and return an "after" callback that runs once the
        // target is known — which is exactly the before/after pair @altea/altea-diff-log records.
        const afters = await runSurroundBefore(symbol, log, entity, args);

        try {
            const result = await run();
            log.setTarget(getTarget(result));
            log.end = Temporal.Now.plainDateTimeISO();
            // AFTER setTarget, so a handler reading `log.target` sees the operation's result (Signum's
            // `log.GetTemporalTarget()`), and BEFORE the save, so what a handler writes onto the log persists.
            await runSurroundAfter(afters, symbol);
            await persistLog(log);
            return result;
        } catch (error) {
            log.end = Temporal.Now.plainDateTimeISO();
            // The "after" half still runs on failure — Signum's `using` disposes either way — so a handler that
            // allocated state releases it, and a partial record is still written.
            await runSurroundAfter(afters, symbol);
            // Link the exception row (Signum's OperationLogEntity.Exception) — best-effort.
            try {
                const ex = await ExceptionLogic.logException(error);
                log.exception = ex.isNew ? null : ex.toLite();
            } catch (exError) {
                console.error("OperationLogic.logOperation: failed to log exception:", exError);
            }
            await persistLog(log);
            throw error;
        }
    }
}

async function runSurroundBefore(symbol: OperationSymbol, log: OperationLogEntity, entity: Entity | null,
    args: unknown[]): Promise<SurroundOperationAfter[]> {

    const afters: SurroundOperationAfter[] = [];
    for (const handler of OperationLogic.surroundOperation) {
        try {
            const after = await handler({ operation: OperationLogic.findOperation(symbol), log, entity, args });
            if (after != undefined)
                afters.push(after);
        } catch (e) {
            // A surrounding CONCERN (auditing) must never break the operation it observes.
            console.error(`OperationLogic.surroundOperation: a handler failed before '${symbol.key}':`, e);
        }
    }
    return afters;
}

async function runSurroundAfter(afters: SurroundOperationAfter[], symbol: OperationSymbol): Promise<void> {
    // Reverse order, like nested `using` scopes unwinding.
    for (const after of [...afters].reverse()) {
        try {
            await after();
        } catch (e) {
            console.error(`OperationLogic.surroundOperation: a handler failed after '${symbol.key}':`, e);
        }
    }
}

async function persistLog(log: OperationLogEntity): Promise<void> {
    try {
        await Saver.save([log]);
    } catch (saveError) {
        console.error("OperationLogic.logOperation: failed to persist OperationLogEntity:", saveError);
    }
}

function find(symbol: OperationSymbol, type: OperationType): IOperation {
    const op = OperationLogic.findOperation(symbol);
    if (op.operationType !== type)
        throw new Error(`Operation '${symbol.key}' is a ${op.operationType}, not a ${type}.`);
    return op;
}

// Service entrypoints (Signum's OperationLogic.Execute/Delete/Construct/… extension
// methods). An object literal so `delete` (reserved word) works as a method. Typed by
// the symbol containers, so the compiler rejects the wrong operation kind / entity type.
export const Operations = {
    async execute<T extends Entity>(entity: T, symbol: ExecuteSymbol<T>, ...args: unknown[]): Promise<T> {
        // Signum's execute-time authorization (Graph.Execute → AssertOperationAllowed, inUserInterface:false).
        await OperationLogic.assertOperationAllowed(symbol, entity.constructor, false, entity);
        return await logOperation(symbol, null, entity, args,
            () => (find(symbol, OperationType.Execute) as IExecuteOperation).doExecute(entity, args) as Promise<T>,
            result => result);
    },
    async delete<T extends Entity>(entity: T, symbol: DeleteSymbol<T>, ...args: unknown[]): Promise<void> {
        await OperationLogic.assertOperationAllowed(symbol, entity.constructor, false, entity);
        await logOperation(symbol, null, entity, args,
            () => (find(symbol, OperationType.Delete) as IDeleteOperation).doDelete(entity, args),
            () => entity);
    },
    async construct<T extends Entity>(symbol: ConstructSymbol<T>, ...args: unknown[]): Promise<T> {
        return await logOperation(symbol, null, null, args,
            () => (find(symbol, OperationType.Constructor) as IConstructOperation).doConstruct(args) as Promise<T>,
            result => result);
    },
    async constructFrom<T extends Entity, F extends Entity>(entity: F, symbol: ConstructSymbol<T, From<F>>, ...args: unknown[]): Promise<T> {
        await OperationLogic.assertOperationAllowed(symbol, entity.constructor, false, entity);
        return await logOperation(symbol, entity, entity, args,
            () => (find(symbol, OperationType.ConstructorFrom) as IConstructorFromOperation).doConstructFrom(entity, args) as Promise<T>,
            result => result);
    },
    async constructFromMany<T extends Entity, F extends Entity>(lites: Lite<F>[], symbol: ConstructSymbol<T, FromMany<F>>, ...args: unknown[]): Promise<T> {
        return await logOperation(symbol, null, null, args,
            () => (find(symbol, OperationType.ConstructorFromMany) as IConstructorFromManyOperation).doConstructFromMany(lites as Lite<Entity>[], args) as Promise<T>,
            result => result);
    },
    // The button-state check (Signum's entity.CanExecute(symbol)).
    canExecute<T extends Entity>(entity: T, symbol: ExecuteSymbol<T> | DeleteSymbol<T>): string | null {
        return (OperationLogic.findOperation(symbol) as IEntityOperation).onCanExecute(entity);
    },
};
