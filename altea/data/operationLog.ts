import { Entity } from "./entity";
import { Lite } from "./lite";
import { column, entity, format, implementedBy, implementedByAll, serialize } from "./decorators";
import { reflect } from "./reflection";
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
//  - `Duration` (Signum's [ExpressionField] computed from End - Start) is omitted — a Temporal
//    subtraction lowered to SQL is not needed by the OperationLog query's default columns, and altea has
//    no ExpressionField-over-Temporal-difference support yet. TODO(port) if a duration column is wanted.
//  - TicksColumn(false) has no altea decorator yet; left as the schema default (as ExceptionEntity does).
@reflect
@entity("System", "Transactional")
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
    // to the concrete user type via `overrideImplementedBy(OperationLogEntity, "user", () => [UserEntity])`
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

    // Signum's ToString(): "{Operation} {User} {Start:d}".
    toString(): string {
        return `${this.operation?.toString() ?? ""} ${this.user?.toString() ?? ""} ${this.start ?? ""}`
            .replace(/\s+/g, " ").trim();
    }
}
