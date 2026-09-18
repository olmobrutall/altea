import { Entity } from "./entity";
import type { IQuery } from "./iquery";
import { Lite } from "./lite";
import { column, entity, format, implementedBy, implementedByAll, legacyPropertyRoute, quoted, serialize, ticksColumn } from "./decorators";
import { reflect, setDatabaseSchema } from "./reflection";
import { Temporal } from "./basics";
import { OperationSymbol } from "./operations";
import { ExceptionEntity } from "./exception";
import type { IUserEntity } from "./security";

// Port of Signum's OperationLogEntity (old/Framework/Signum/Operations/OperationLog.cs). A "System" /
// "Transactional" entity: the engine's persisted record of every operation execution (who ran what, on
// which entity, when, and — on failure — the linked ExceptionEntity). Written by OperationLogic during
// execute, never by a user save (like ExceptionEntity).
//
// altea divergences from Signum, documented inline:
//  - `target` / `origin` are @implementedByAll `Lite<Entity>` (Signum's `[ImplementedByAll] Lite<IEntity>`),
//    so the log can point at any entity type. altea has no IEntity interface reference — a plain Lite<Entity>
//    with @implementedByAll is the altea equivalent (the schema emits one id column per PK type).
//  - `User: Lite<IUserEntity>` — who ran the operation. @implementedByAll (like target/origin) so core
//    needn't reference altea-auth's UserEntity; set in OperationLogic.logOperation from UserHolder (null
//    until an auth module scopes the request). ToString includes it when present.
//  - `Duration` (Signum's [ExpressionField] computed from End - Start) IS here — the `@quoted`
//    `durationMilliseconds()` below, plus the `Duration` token OperationLogic registers over it. The note
//    that used to stand here said altea had "no ExpressionField-over-Temporal-difference support yet";
//    it does — `end.since(start).total({ unit })` is lowered by DbExpressionNominator to
//    CAST(DATEDIFF_BIG(millisecond, start, end) AS float) on SQL Server and EXTRACT(EPOCH FROM end - start) / 0.001 on
//    Postgres. What altea has no counterpart for is Signum's `[Unit("ms")]` (a registered expression
//    carries no unit), so the unit lives in the member NAME, as @altea/altea-rest and -view-log spell it.
//  - TicksColumn(false) has no altea decorator yet; left as the schema default (as ExceptionEntity does).
@reflect
@entity("System", "Transactional")
// Signum's [TicksColumn(false)] — the engine writes these rows, never a person editing one, so there is
// nothing for a concurrency stamp to protect.
@ticksColumn(false)
export class OperationLogEntity extends Entity {
    // Signum's [ImplementedByAll] Lite<IEntity>? Target — the entity the operation ran on.
    @implementedByAll
    target: Lite<Entity> | null = null;

    // Signum's [ImplementedByAll] Lite<IEntity>? Origin.
    @implementedByAll
    origin: Lite<Entity> | null = null;

    // The operation that ran (FK to the single OperationSymbol table).
    operation: OperationSymbol;

    // Signum's `[ImplementedBy(typeof(UserEntity))] Lite<IUserEntity> User`. Core declares NO
    // implementations (`@implementedBy(() => [])`) so it needn't reference altea-auth; the app overrides it
    // to the concrete user type via `overrideImplementedBy(OperationLogEntity, o => o.user, () => [UserEntity])`
    // in its EntityOverrides. Set in OperationLogic.logOperation from UserHolder.
    @implementedBy(() => [])
    user: Lite<IUserEntity> | null = null;

    @format("G")
    start: Temporal.PlainDateTime;

    @format("G")
    end: Temporal.PlainDateTime | null = null;

    // Set on failure to the ExceptionEntity logged for the throwing execute (Signum's Exception FK).
    exception: Lite<ExceptionEntity> | null = null;

    /**
     * Signum's `temporalTarget` (an `[Ignore]` field): the ACTUAL entity `setTarget` was given, kept for the
     * rest of the request. `target` is a thin lite, so a consumer that needs the object itself — an audit
     * hook wanting to dump the post-operation state (@altea/altea-diff-log) — cannot get it from there.
     * `@column(false) @serialize(false)`: never a column, never on the wire.
     */
    @column(false) @serialize(false)
    temporalTarget: Entity | null = null;

    // Signum sets Target from an entity in SetTarget (null when the entity is new / unsaved).
    setTarget(target: Entity | null): void {
        this.temporalTarget = target;
        this.target = target == null || target.isNew ? null : target.toLite();
    }

    /** Signum's `GetTemporalTarget()`. */
    getTemporalTarget(): Entity | null {
        return this.temporalTarget;
    }

    /**
     * Signum's `Duration` — how long the operation took, in milliseconds; null while `end` is unset (an
     * execution still running, or one that threw before `end` was stamped). `@quoted`, so it is a real
     * SQL column the OperationLog search page can order and filter by rather than an in-memory read off
     * an already-loaded row.
     *
     * The nullable guard is load-bearing: `end` is nullable, and a difference taken against NULL would
     * report a wrong number instead of "unknown". The ternary is what the provider lowers to a CASE WHEN,
     * and `since().total({ unit })` is the only Temporal shape the nominator turns into a real DATEDIFF.
     *
     * `@legacyPropertyRoute("Duration")` because Signum's member is the C# PROPERTY `Duration`, so a
     * Signum database holds a `basics.property_route` row under exactly that name and a legacy sync must
     * not offer it as a rename and drop it.
     */
    @legacyPropertyRoute("Duration")
    @quoted durationMilliseconds(): number | null {
        return this.end != null ? this.end.since(this.start).total({ unit: "milliseconds" }) : null;
    }

    // Signum's ToString(): "{Operation} {User} {Start:d}".
    toString(): string {
        return `${this.operation?.toString() ?? ""} ${this.user?.toString() ?? ""} ${this.start ?? ""}`
            .replace(/\s+/g, " ").trim();
    }
}

// `Signum.Operations` → the `operations` schema, as for OperationSymbol beside it.
setDatabaseSchema("operations", OperationLogEntity);

// ---- the query expressions OperationLogic registers (see server/operationLogic) --------------------------
//
// DECLARED here, in data/, and IMPLEMENTED in server/: the body needs `table(...)`, which is server-only,
// but the DECLARATION has to be visible to the client program too or `token(a => a.operationLogs())` — the
// typed builder every `defaultColumns` and `findOptions` goes through — cannot be written. See the model-
// rules bullet in CLAUDE.md.
//
// On `Entity`, where Signum declares them (extension methods on Entity, plus its built-in SystemValidFrom /
// SystemValidTo tokens). OPTIONAL, because a member is only a TOKEN on the types the registration names:
// `operationLogs` is registered once for Entity and inherited down the prototype chain, while the other
// three are registered per @systemVersioned type — `systemPeriod()` throws on any other.
declare module "./entity" {
    interface Entity {
        /** Signum's `OperationLogs()` — every operation ever run on this entity. */
        operationLogs?(): IQuery<OperationLogEntity>;
        /** Signum's `PreviousOperationLog()` — the operation that produced THIS row version. */
        previousOperationLog?(): Promise<OperationLogEntity | null>;
        /** Signum's `SystemValidFrom` — when this row version became current. */
        systemValidFrom?(): Temporal.PlainDateTime | null;
        /** Signum's `SystemValidTo` — when it stopped being current, or null for the live row. */
        systemValidTo?(): Temporal.PlainDateTime | null;
    }
}

// The mirror of `Entity.operationLogs` seen from the other end: every execution of one OPERATION rather
// than every operation on one entity. Its surface is the OperationSymbol search page, which SymbolLogic
// gives every symbol type (`sb.include(ctor).withQuery()`).
declare module "./operationSymbol" {
    interface OperationSymbol {
        /** Signum's `Logs()` — every operation log written for this operation. */
        logs?(): IQuery<OperationLogEntity>;
    }
}
