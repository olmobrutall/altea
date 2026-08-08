import { Entity } from "./entity";
import { Lite } from "./lite";
import { entity, implementedByAll, format } from "./decorators";
import { reflect } from "./reflection";
import { Temporal } from "./basics";
import { OperationSymbol } from "./operations";
import { ExceptionEntity } from "./exception";

// Port of Signum's OperationLogEntity (old/Framework/Signum/Operations/OperationLog.cs). A "System" /
// "Transactional" entity: the engine's persisted record of every operation execution (who ran what, on
// which entity, when, and — on failure — the linked ExceptionEntity). Written by OperationLogic during
// execute, never by a user save (like ExceptionEntity).
//
// altea divergences from Signum, documented inline:
//  - `target` / `origin` are @implementedByAll `Lite<Entity>` (Signum's `[ImplementedByAll] Lite<IEntity>`),
//    so the log can point at any entity type. altea has no IEntity interface reference — a plain Lite<Entity>
//    with @implementedByAll is the altea equivalent (the schema emits one id column per PK type).
//  - `User: Lite<IUserEntity>` is omitted — eastwind has no auth/user context wired yet (same call as
//    ExceptionEntity). Signum's ToString uses it; altea's drops it.
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

    @format("G")
    start: Temporal.PlainDateTime;

    @format("G")
    end: Temporal.PlainDateTime | null = null;

    // Set on failure to the ExceptionEntity logged for the throwing execute (Signum's Exception FK).
    exception: Lite<ExceptionEntity> | null = null;

    // Signum sets Target from an entity in SetTarget (null when the entity is new / unsaved).
    setTarget(target: Entity | null): void {
        this.target = target == null || target.isNew ? null : target.toLite();
    }

    // Signum's ToString(): "{Operation} {User} {Start:d}"; altea drops User (no auth wired).
    toString(): string {
        return `${this.operation?.toString() ?? ""} ${this.start ?? ""}`.trim();
    }
}
