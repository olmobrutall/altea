import { Entity, type Type } from "../data/entity";
import type { Lite } from "../data/lite";
import { OperationSymbol } from "../data/operations";
import type {
    ExecuteSymbol, DeleteSymbol,
    ConstructSymbol, From, FromMany,
} from "../data/operations";
import { OperationLogEntity } from "../data/operationLog";
import type { IQuery } from "../data/iquery";
import { resolveCleanType, resolveType } from "../data/registration";
import { Temporal } from "../data/basics";
import { withQuoted } from "../data/decorators";
import { OperationMessage } from "../data/uiMessages";
import { CollectionMessage } from "../data/dynamicQueries";
import "../data/globals"; // Array.prototype.joinComma (Signum's CommaOr)
import type { Quoted } from "quote-transformer/quoted";
import { table } from "./table";
import { QueryLogic } from "./dynamicQuery/queryLogic";
import type { SchemaBuilder } from "./schema/schemaBuilder";
import { SymbolLogic } from "./symbolLogic";
import { Saver } from "./saver";
import { ExceptionLogic } from "./exceptionLogic";
import { UnauthorizedAccessException } from "./exceptions";
import { UserHolder } from "./userHolder";
import { ExecutionMode } from "./executionMode";
import { Transaction } from "./connection/transaction";
import "./dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import {
    OperationType,
    type IOperation, type IEntityOperation, type IExecuteOperation, type IDeleteOperation,
    type IConstructOperation, type IConstructorFromOperation, type IConstructorFromManyOperation,
    type IGraphStateOperation,
    stateEnumOf, normalizeState, stateNiceToString,
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

// Keyed by the symbol's KEY, never by the symbol OBJECT. A symbol read back from the DATABASE is a
// FRESH instance, not the declared singleton — so an identity-keyed Map answers "not registered" for an
// operation named by DATA rather than named in code. altea-processes' PackageOperationAlgorithm is
// exactly that caller (the operation to apply is a column on the package), and altea-scheduler /
// -processes already key their own registries this way for the same reason.
const operations = new Map<string, IOperation>();

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


export namespace OperationLogic {
    // Signum's OperationLogic.Register(replace). Validates the operation, then stores it
    // by symbol. `replace` allows an external module to swap an operation's impl.
    export function register(operation: IOperation, replace = false): void {
        if (!replace && operations.has(operation.operationSymbol.key!))
            throw new Error(`Operation '${operation.operationSymbol.key}' has already been registered (pass replace=true to override).`);
        operation.assertIsValid();
        const previous = operations.get(operation.operationSymbol.key!);
        if (previous != null && previous.entityType !== operation.entityType)
            operationsByType.get(previous.entityType)?.delete(operation.operationSymbol);
        operations.set(operation.operationSymbol.key!, operation);
        let byType = operationsByType.get(operation.entityType);
        if (byType == null) operationsByType.set(operation.entityType, byType = new Set());
        byType.add(operation.operationSymbol);
    }

    // Remove an operation entirely (so it can be re-registered differently, or dropped).
    export function unregister(symbol: OperationSymbol): boolean {
        const op = operations.get(symbol.key!);
        if (op != null)
            operationsByType.get(op.entityType)?.delete(symbol);
        return operations.delete(symbol.key!);
    }

    export function registeredOperations(): OperationSymbol[] {
        return [...operations.values()].map(o => o.operationSymbol);
    }

    export function tryFindOperation(symbol: OperationSymbol): IOperation | undefined {
        return operations.get(symbol.key!);
    }
    export function findOperation(symbol: OperationSymbol): IOperation {
        const op = operations.get(symbol.key!);
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
    /**
     * Signum's `OperationLogic.OperationAllowedMessage` — why the operation was refused, or null when it
     * was not. Localized, and it names the operation TWICE: once as the user knows it (its nice name) and
     * once as the developer does (its key), because an authorization complaint is read by both.
     */
    export async function operationAllowedMessage(symbol: OperationSymbol, entityType: Function, inUserInterface: boolean, entity: Entity | null): Promise<string | null> {
        if (await isOperationAllowed(symbol, entityType, inUserInterface, entity))
            return null;

        return OperationMessage.Operation01IsNotAuthorized.niceToString(symbol.niceToString(), symbol.key) +
            (inUserInterface ? " " + OperationMessage.InUserInterface.niceToString() : "");
    }
    export async function assertOperationAllowed(symbol: OperationSymbol, entityType: Function, inUserInterface: boolean, entity: Entity | null): Promise<void> {
        const message = await operationAllowedMessage(symbol, entityType, inUserInterface, entity);
        if (message != null)
            throw new UnauthorizedAccessException(message);
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
                    if (operations.has(s.key!)) result.push(s);
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
     * The operations this type DECLARES — its own entry in the (type → symbols) registry, with no walk up
     * the chain. {@link operationsForType} is the inclusive question ("what can run on one of these?");
     * this is the exclusive one ("what is registered HERE?"), which is what a consumer that models
     * inheritance itself needs: the metadata blob ships each operation once, on this type, and the client
     * walks the prototype chain rather than being handed the same object once per subclass.
     */
    export function declaredOperationsForType(ctor: Function): OperationSymbol[] {
        const symbols = operationsByType.get(ctor);
        // Same rule as operationsForType: a symbol indexed before (or without) an implementation is not
        // an operation of this type.
        return symbols == null ? [] : [...symbols].filter(s => operations.has(s.key!));
    }

    /**
     * Signum's `OperationLogic.GetContextualCanExecute` — why each of these operations cannot run over the
     * current SELECTION, without retrieving a single entity: the distinct STATES of the selected rows are
     * read in SQL and checked against each operation's `fromStates`. This is what greys out an operation in
     * the contextual menu of a SearchControl (see /api/operation/stateCanExecutes).
     *
     * altea divergences from Signum:
     *  - the registry is keyed by symbol ALONE (one implementation per operation), so Signum's per-type
     *    `FindOperation(type, key)` and its group-by-StateType collapse into a lookup.
     *  - Signum ALSO folds in `CanExecuteExpression` (a SQL-evaluable can-execute). altea has no such
     *    expression — see `OperationMetadata.hasCanExecuteExpression`, which the server never sets — so only
     *    the state check runs, and an operation with a plain in-memory `canExecute` is left alone (the
     *    single-lite path fetches an EntityPack for that, exactly as it does in Signum).
     *  - the messages of several groups are joined with "
", as Signum's `"
".Combine` does.
     */
    export async function getContextualCanExecute(lites: Lite<Entity>[], symbols: OperationSymbol[]): Promise<Record<string, string>> {

        const result: Record<string, string> = {};

        // Grouped by hand rather than with the `groupBy` array extension: the key is a CONSTRUCTOR, and
        // that extension stringifies its key with `toString()` — which for a class is its whole source.
        const byType = new Map<Type<Entity>, Lite<Entity>[]>();
        for (const lite of lites) {
            const ctor = lite.entityType as Type<Entity>;
            let group = byType.get(ctor);
            if (group == null) byType.set(ctor, group = []);
            group.push(lite);
        }

        for (const [ctor, group] of byType) {
            // Signum groups the state-carrying operations by their StateType and runs ONE
            // `Select(getState).Distinct()` per group (`GetContextualGraphCanExecute<T, E, S>`) — so the
            // key here is the ENUM, resolved off each operation (stamped by `withStateMachine`, so no
            // property route is walked). Keying on the SELECTOR instance instead would be finer, but it
            // splits the common case: a second `withStateMachine(o => o.state, …)` block — the ordinary
            // way another module adds operations to a type — is a different function object over the same
            // states, and would cost a second identical query. Two properties of the same enum type on
            // one entity, which the enum key would merge, do not happen in practice.
            // A selector whose enum cannot be resolved keys on itself, so those never merge either.
            const byStateEnum = new Map<object | ((entity: any) => unknown), { symbol: OperationSymbol, op: IGraphStateOperation }[]>();
            for (const symbol of symbols) {
                const op = tryFindOperation(symbol) as IGraphStateOperation | undefined;
                if (op?.getState == null || op.fromStates == null || op.fromStates.length === 0)
                    continue;
                const key = stateEnumOf(op, ctor) ?? op.getState;
                let ops = byStateEnum.get(key);
                if (ops == null) byStateEnum.set(key, ops = []);
                ops.push({ symbol, op });
            }

            for (const ops of byStateEnum.values()) {
                // Any member's selector reads the same column for the whole group (that is what sharing
                // the enum means here), so one GROUP BY serves all of them.
                const states = await distinctStates(ctor, group, ops[0].op.getState!);

                for (const { symbol, op } of ops) {
                    const stateEnum = stateEnumOf(op, ctor); // memoised on the operation by the grouping pass

                    // Both sides through the enum's NAME: `fromStates` holds the enum's numeric values (S
                    // is inferred from the selector), while a materialised enum column yields the member
                    // name — the same ordinal↔name boundary @altea/altea-map's operation map crosses.
                    const allowed = new Set(op.fromStates!.map(s => normalizeState(s, stateEnum)));
                    const invalid = states.filter(s => !allowed.has(normalizeState(s, stateEnum)));
                    if (invalid.length === 0)
                        continue;

                    const nice = (s: unknown): string => stateNiceToString(s, stateEnum);

                    const or = CollectionMessage.Or.niceToString();
                    const message = OperationMessage.StateShouldBe0InsteadOf1.niceToString(
                        op.fromStates!.map(nice).joinComma(or),
                        invalid.map(nice).joinComma(or));

                    result[symbol.key] = result[symbol.key] == null ? message : result[symbol.key] + "\n" + message;
                }
            }
        }

        return result;
    }

    /** The distinct values the operation's state selector takes over the selected rows — one GROUP BY. */
    async function distinctStates(ctor: Type<Entity>, lites: Lite<Entity>[], getState: (entity: any) => unknown): Promise<unknown[]> {
        const ids = lites.map(l => l.id);
        const rows = await table(ctor)
            .filter((e: Entity) => ids.includes(e.id))
            .groupBy(getState as Quoted<(entity: Entity) => unknown>)
            .map(g => g.key)
            .toArray();
        return rows.filter(s => s != null);
    }

    /**
     * Signum's `OperationController.AnyReadonly` — "is any of these rows read-only for the current role?",
     * which the contextual menu uses to hide the operations that would fail anyway. A pluggable hook,
     * because altea core has no authorization: @altea/altea-auth installs one, and with none installed
     * every selection is writable (Signum's field is null by default).
     */
    export type AnyReadonlyHook = (lites: Lite<Entity>[]) => Promise<boolean>;
    const anyReadonlyHooks: AnyReadonlyHook[] = [];
    export function onAnyReadonly(fn: AnyReadonlyHook): void { anyReadonlyHooks.push(fn); }
    export async function anyReadonly(lites: Lite<Entity>[]): Promise<boolean> {
        for (const h of anyReadonlyHooks)
            if (await h(lites))
                return true;
        return false;
    }

    /**
     * Signum's `OperationLogic.SurroundOperation` — wrap every operation execution. A handler sees the
     * OperationLogEntity being built, the entity the operation runs on, and its args; it may return an
     * "after" callback that runs once the target is known (Signum returns an IDisposable, and the `using`
     * scope is what runs the second half). The first and only consumer is @altea/altea-diff-log, which
     * records the entity's dump before and after.
     *
     * A throwing handler FAILS the operation, as it does in Signum. It used to be logged and skipped, on
     * the theory that an auditing concern must not break what it observes — which in practice meant an
     * audit trail that stopped recording without telling anyone.
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
     *  - {@link OperationLogic.surroundOperation} observes: its "after" half runs at a precise point —
     *    after the target is known, before the log is saved — so what it writes onto the log persists.
     *  - `aroundOperation` scopes: it decides what the operation is allowed to see.
     * Both FAIL the operation when a handler throws.
     * Handlers compose, first-registered outermost.
     */
    export const aroundOperation: AroundOperationHandler[] = [];

    /**
     * Signum's `OperationLogic.LogOperation` (`Func<OperationLogEntity, bool>`, consulted by `SaveLog`):
     * whether this execution is worth a row at all. Everything is, by default.
     *
     * It is the only way to opt OUT now that a log that cannot be written fails the operation — an app
     * that does not want a row per read-like operation, and a suite that runs the operation layer with no
     * database behind it, both say so here instead of relying on the write failing quietly.
     */
    export let logOperation: (log: OperationLogEntity) => boolean = () => true;

    // Signum's OperationLogic.Start: wires the OperationSymbol table through SymbolLogic, seeding only the
    // RegisteredOperations, and includes the OperationLogEntity table + its query (Signum's
    // `sb.Include<OperationLogEntity>().WithQuery(...)`).
    //
    // MAY BE CALLED AT ANY POINT, and the modules' own `sb.include(X).with*` operation registrations may
    // come before OR after it — which is what lets an app start it with the rest of the framework instead
    // of remembering to put it last. The symbol list is read through a THUNK
    // (`() => registeredOperations()`), and SymbolLogic evaluates that only when the table is GENERATED /
    // SYNCHRONIZED / LOADED — every one of which happens after the whole schema is built. Nothing else
    // here reads the registry either: the `PreviousOperationLog` / system-valid registrations are deferred
    // to `schemaCompleted`, when the set of @systemVersioned tables is final.
    //
    // It used to be documented as "call AFTER the graphs have registered", which was never true of the
    // thunk and only ever true of the order it happened to be written in. What DOES still depend on this
    // call is anything DECORATING the operation log — @altea/altea-diff-log, @altea/altea-time-machine —
    // so those come after it.
    //
    // Idempotent (Signum's `sb.AlreadyDefined` guard), so a second call from a module that is not sure
    // the app made one is a no-op rather than a duplicate `schemaCompleted` handler.
    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        SymbolLogic.start(sb, OperationSymbol, () => registeredOperations());
        // Signum's `.WithIndex(a => a.Start)` — the operation log is browsed and swept by date.
        sb.include(OperationLogEntity).withIndex(a => a.start).withQuery();

        // Signum's `QueryLogic.Expressions.Register((Entity o) => o.OperationLogs(), …)`, verbatim: every
        // entity offers its own operation history as a sub-token. ONE registration, on the abstract root —
        // an extension token is resolved by walking the parent token's prototype chain, so every concrete
        // type finds it there (the call altea-sms makes for `SMSOwnerData` on its abstract base).
        QueryLogic.expressions.register(Entity, (e: Entity) => e.operationLogs!(),
            { key: "OperationLogs", niceName: () => OperationLogEntity.nicePluralName() });

        // Signum's `QueryLogic.Expressions.Register((OperationSymbol o) => o.Logs(), OperationMessage.Logs)`
        // — the same history read from the operation's end. The page it hangs off is the one SymbolLogic
        // just gave OperationSymbol above.
        QueryLogic.expressions.register(OperationSymbol, (o: OperationSymbol) => o.logs!(),
            OperationMessage.Logs);

        // Signum's `[ExpressionField("DurationExpression")] public double? Duration` — how long the
        // operation took, so the log's search page can sort and filter by it. Signum gets the token from
        // the property itself; altea registers it explicitly, because a `@quoted` METHOD is not a
        // PropertyRoute and so is not a column of the type.
        //
        // The caption is a MESSAGE, not `nicePropertyName(a => a.durationMilliseconds())`. That call would
        // compile and read fine, but it resolves under (declaring type, member) — and a `@quoted` method
        // has no <Member> entry, because `stub-translations` builds each type's member list from
        // `PropertyRoute.memberPaths`, i.e. from FIELDS. So it would silently humanise to "Duration
        // milliseconds" in every culture. `OperationMessage.Duration` is a real localizable member, the
        // same move `registerSystemValidTokens` below makes for its two tokens.
        QueryLogic.expressions.register(OperationLogEntity, (o: OperationLogEntity) => o.durationMilliseconds(),
            OperationMessage.Duration);

        // Signum's `ExceptionLogic.DeleteLogs += ExceptionLogic_DeleteLogs`. Two passes, because a log row
        // that recorded an EXCEPTION has its own (shorter) cut-off.
        ExceptionLogic.registerDeleteLogs(async (parameters, ctx) => {
            const typeEntity = OperationLogEntity.toTypeEntity();

            const dateLimit = parameters.getDateLimitDelete(typeEntity);
            if (dateLimit != null)
                await ExceptionLogic.deleteChunksLog(OperationLogEntity, table(OperationLogEntity)
                    .filter(o => Temporal.PlainDateTime.compare(o.start, dateLimit) < 0), parameters, ctx);

            const exceptionsDateLimit = parameters.getDateLimitDeleteWithExceptions(typeEntity);
            if (exceptionsDateLimit != null)
                await ExceptionLogic.deleteChunksLog(OperationLogEntity, table(OperationLogEntity)
                    .filter(o => Temporal.PlainDateTime.compare(o.start, exceptionsDateLimit) < 0 && o.exception != null),
                    parameters, ctx);
        });


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
        QueryLogic.expressions.register(type, (e: Entity) => e.systemValidFrom!(),
            OperationMessage.SystemValidFrom);
        QueryLogic.expressions.register(type, (e: Entity) => e.systemValidTo!(),
            OperationMessage.SystemValidTo);
    }

    export function registerPreviousLog<T extends Entity>(type: Type<T>): void {
        QueryLogic.expressions.register(type, (e: Entity) => e.previousOperationLog!(),
            OperationMessage.PreviousOperationLog);
    }
}

// The bodies of the five expressions DECLARED in data/operationLog (see there for why the two halves are
// split). The four on `Entity` are stamped ONCE on `Entity.prototype`, because none of them depends on the
// type: which types OFFER them as tokens is what the registrations above decide.
Entity.prototype.operationLogs = withQuoted(function (this: Entity): IQuery<OperationLogEntity> {
    return table(OperationLogEntity).filter(a => a.target!.is(this));
});

OperationSymbol.prototype.logs = withQuoted(function (this: OperationSymbol): IQuery<OperationLogEntity> {
    return table(OperationLogEntity).filter(a => a.operation.is(this));
});

Entity.prototype.systemValidFrom = withQuoted(function (this: Entity): Temporal.PlainDateTime | null {
    return this.systemPeriod().min;
});

Entity.prototype.systemValidTo = withQuoted(function (this: Entity): Temporal.PlainDateTime | null {
    return this.systemPeriod().max;
});

Entity.prototype.previousOperationLog = withQuoted(function (this: Entity): Promise<OperationLogEntity | null> {
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


// Signum wraps every operation execution in a transaction that also writes an OperationLogEntity
// (Graph.cs: `using (var tr = new Transaction()) { … log.SaveLog(); return tr.Commit(result); }`), and
// altea does the same — the operation runs, then the log row is persisted, and a failure to persist it
// FAILS THE OPERATION.
//
// It used to be a best-effort side write whose every failure went to console.error, on the reasoning that
// logging must never mask the operation's own result. What that reasoning missed is that an audit trail
// which quietly stops recording is worse than one that stops working: the log is evidence, and evidence
// that is sometimes absent for reasons nobody was told about is not evidence. It went unnoticed for
// exactly as long as it took someone to look for a row that was never there.
//
// The one thing altea does NOT yet share with Signum is the ambient transaction across the two halves: the
// operation commits in `doExecute`'s own transaction and the log in its own, so a log failure leaves the
// operation applied and reports the failure, where Signum rolls both back together.
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
        //
        // INSIDE the try, and filling a list the catch can see: now that a handler's failure propagates,
        // it is an operation failure like any other and deserves the same failed log row — and whichever
        // handlers already ran still get their "after" half, the way a `using` unwinds what it opened.
        // Signum has this for free: its OnSuroundOperation call sits inside the same try/catch.
        const afters: SurroundOperationAfter[] = [];

        try {
            await runSurroundBefore(afters, symbol, log, entity, args);
            const result = await run();
            log.setTarget(getTarget(result));
            log.end = Temporal.Now.plainDateTimeISO();
            // AFTER setTarget, so a handler reading `log.target` sees the operation's result (Signum's
            // `log.GetTemporalTarget()`), and BEFORE the save, so what a handler writes onto the log persists.
            await runSurroundAfter(afters);
            await persistLog(log, false);
            return result;
        } catch (error) {
            log.end = Temporal.Now.plainDateTimeISO();
            // Everything from here runs while an error is already on its way up, so a second failure would
            // REPLACE the first and hide what actually went wrong — the one place a catch earns its keep.
            // It is not silent: the secondary rides on the error being rethrown, so the exception log and
            // the API's error response both carry it.
            try {
                // The "after" half still runs on failure — Signum's `using` disposes either way — so a handler
                // that allocated state releases it, and a partial record is still written.
                await runSurroundAfter(afters);
                // Link the exception row (Signum's OperationLogEntity.Exception).
                const ex = await ExceptionLogic.logException(error);
                log.exception = ex.isNew ? null : ex.toLite();
                await persistLog(log, true);
            } catch (loggingError) {
                (error as { operationLoggingError?: unknown }).operationLoggingError = loggingError;
            }
            throw error;
        }
    }
}

// A handler's failure PROPAGATES, as it does in Signum (Disposable.Combine invokes them bare). These used
// to swallow into console.error, on the theory that a surrounding CONCERN must never break the operation
// it observes; what that actually bought was a DiffLog handler failing and leaving an operation log with
// empty dumps, indistinguishable from an operation that legitimately changed nothing.
async function runSurroundBefore(afters: SurroundOperationAfter[], symbol: OperationSymbol,
    log: OperationLogEntity, entity: Entity | null, args: unknown[]): Promise<void> {

    for (const handler of OperationLogic.surroundOperation) {
        const after = await handler({ operation: OperationLogic.findOperation(symbol), log, entity, args });
        if (after != undefined)
            afters.push(after);
    }
}

async function runSurroundAfter(afters: SurroundOperationAfter[]): Promise<void> {
    // Reverse order, like nested `using` scopes unwinding.
    for (const after of [...afters].reverse())
        await after();
}

// Signum's `OperationLogEntity.SaveLog()`: `using (ExecutionMode.Global()) log.Save();` — no catch, so a
// log that cannot be written FAILS THE OPERATION. It used to be swallowed here ("a best-effort side
// write"), which is how every operation log in the application went missing without a word the moment the
// DiffLog dumps became File-mode BigStrings.
//
// `ExecutionMode.global` is what makes throwing safe rather than a new way to break an operation: the row
// is the ENGINE's, so it must not be subject to the caller's write authorization — Signum wraps it for the
// same reason.
//
// `forceNew` on the FAILURE path is Signum's `tr2` (`Transaction.ForceNew()` in Graph.cs's catch block):
// the operation's own transaction is gone and the CALLER's is about to roll back, so a log joining it
// would vanish with it — which is exactly the failure worth recording.
async function persistLog(log: OperationLogEntity, failed: boolean): Promise<void> {
    if (!OperationLogic.logOperation(log))
        return;

    const save = (): Promise<void> => ExecutionMode.global(() => Saver.save([log]));
    await (failed ? Transaction.forceNew(save) : save());
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
