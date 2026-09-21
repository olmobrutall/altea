import { Entity, EmbeddedEntity } from "./entity";
import { reflect } from "./reflection";
import { Lite } from "./lite";
import { part, backReference, implementedBy, rowOrder, legacyColumnName, unit } from "./decorators";
import { ComparisonType, numberIsValidator, validate, ValidationMessage } from "./validators";
import { Temporal, type int } from "./basics";
import { Clock } from "./utils/clock";
import { TypeEntity } from "./typeEntity";

// Port of the DeleteLogs half of Signum's Exception.cs: HOW MUCH of every log table to keep, and how
// gently to remove the rest. The engine half — the registry of log tables and the runner that walks it —
// is ExceptionLogic (server/exceptionLogic.ts).
//
// Neither type is included by core: they become tables only through the ENTITY that owns the parameters,
// which in altea is @altea/altea-scheduler's DeleteLogsTaskEntity (core cannot depend on the scheduler,
// and Signum leaves the owner to the application in the same way).

/**
 * One log type's exception to the global policy: keep THIS type's rows for a different number of days.
 *
 * Signum's `MList<DeleteLogsTypeOverridesEmbedded>` element. altea has no MList, so it is a `@part` row —
 * and a collection inside an EMBEDDED has no owner it can point at (an embedded is flattened, so it has
 * no id), which is why the back reference names the entity HOLDING the parameters. That entity lives in
 * a downstream package, so the list is widened there (altea-scheduler's data/DeleteLogsTask.ts), the
 * accommodation altea-auth's RoleMappingEntity already uses.
 */
@part
export class DeleteLogsTypeOverridesEmbedded extends Entity {
    // Signum's [PreserveOrder] on the collection.
    @legacyColumnName("Order")
    @rowOrder
    rowOrder: int;

    @backReference @implementedBy(() => [])
    parameters: Lite<Entity>;

    type: Lite<TypeEntity>;

    /** Days to keep an ordinary row of this type. Null = never delete it. */
    @unit("Days")
    @numberIsValidator(ComparisonType.GreaterThanOrEqualTo, 0)
    // Signum's PropertyValidation: a row that recorded an EXCEPTION is the more valuable one, so it
    // cannot be kept longer than an ordinary row — the runner would delete it under the ordinary pass.
    @validate<DeleteLogsTypeOverridesEmbedded>(o =>
        o.deleteLogsOlderThan != null && o.deleteLogsWithExceptionsOlderThan != null
            && o.deleteLogsOlderThan < o.deleteLogsWithExceptionsOlderThan
            ? ValidationMessage._0ShouldBeGreaterThan1.niceToString(
                DeleteLogsTypeOverridesEmbedded.nicePropertyName(a => a.deleteLogsOlderThan),
                DeleteLogsTypeOverridesEmbedded.nicePropertyName(a => a.deleteLogsWithExceptionsOlderThan))
            : null)
    deleteLogsOlderThan: int | null = (30 * 6) as int;

    /** Days to keep a row of this type that recorded an exception. Null = never delete it. */
    @unit("Days")
    @numberIsValidator(ComparisonType.GreaterThanOrEqualTo, 0)
    deleteLogsWithExceptionsOlderThan: int | null = (30 * 2) as int;

    toString(): string {
        return `${this.type?.toString() ?? ""}: ${this.deleteLogsOlderThan ?? "-"} / ${this.deleteLogsWithExceptionsOlderThan ?? "-"}`;
    }
}

/** What one run of the log cleanup is allowed to do: which types to trim, and in how small a bite. */
@reflect
export class DeleteLogParametersEmbedded extends EmbeddedEntity {
    // Signum's [NoRepeatValidator] compares the MList's ELEMENTS, which for an embedded is reference
    // equality — so it never fires. The rule it MEANT is spelled out: one override per type, since
    // getDateLimit* reads a single match.
    @validate<DeleteLogParametersEmbedded>(p => {
        const repeated = p.deleteLogs?.filter((o, i) =>
            o.type != null && p.deleteLogs.findIndex(other => other.type?.is(o.type)) !== i) ?? [];
        return repeated.length === 0 ? null
            : ValidationMessage._0HasSomeRepeatedElements1.niceToString(
                DeleteLogParametersEmbedded.nicePropertyName(a => a.deleteLogs),
                repeated.map(o => o.type.toString()).join(", "));
    })
    deleteLogs: DeleteLogsTypeOverridesEmbedded[];

    /** Rows per DELETE statement. */
    chunkSize: int = 1000 as int;

    /** How many chunks one type gets per run — the budget that keeps a run bounded even when the
     *  backlog is not. Whatever is left over goes in the next run. */
    maxChunks: int = 20 as int;

    /** Breathing room between chunks, so the cleanup never holds the log tables for long. */
    @unit("ms")
    pauseTime: int | null = 5000 as int;

    /** The cut-off for an ordinary row of `type`, or null when this type has no override (= keep it all). */
    getDateLimitDelete(type: TypeEntity): Temporal.PlainDateTime | null {
        return dateLimit(this.override(type)?.deleteLogsOlderThan);
    }

    /** The cut-off for a row of `type` that recorded an exception. */
    getDateLimitDeleteWithExceptions(type: TypeEntity): Temporal.PlainDateTime | null {
        return dateLimit(this.override(type)?.deleteLogsWithExceptionsOlderThan);
    }

    private override(type: TypeEntity): DeleteLogsTypeOverridesEmbedded | undefined {
        return this.deleteLogs?.find(o => o.type?.is(type));
    }
}

// Signum's `moreThan == 0 ? Clock.Now.TruncHours() : Clock.Now.Date.AddDays(-moreThan)`. Zero days means
// "this hour", not "this instant": the cut-off has to be STABLE across the chunks of one run, or rows
// would drift in and out of the window between statements.
function dateLimit(days: int | null | undefined): Temporal.PlainDateTime | null {
    if (days == null)
        return null;

    return days === 0
        ? Clock.now.with({ minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })
        : Clock.now.toPlainDate().toPlainDateTime().add({ days: -days });
}
