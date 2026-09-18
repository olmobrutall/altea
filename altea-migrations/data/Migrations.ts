import { reflect, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, uniqueIndex, quoted, ticksColumn, legacyClassName, legacyPropertyRoute } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { Temporal } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { ExceptionEntity } from "@altea/altea/data/exception";

// Three System/Transactional tables, none with a Ticks column — history rows nobody concurrently edits:
//  • SqlMigrationEntity     — one row per APPLIED .sql migration file, keyed by its version stamp.
//  • TypeScriptMigrationEntity — one row per executed code migration, keyed by its unique name.
//    (Signum calls it CSharpMigration, and so does a database it generated — see useLegacyCSharpMigrationNames.)
//  • LoadMethodLogEntity    — one row per `executeLoadProcess` run: what ran, how long, and what it threw.
//
// Port of Signum.Migrations' entity model — see port/Migrations.md.

@reflect
@entity("System", "Transactional")
// The engine writes these rows, never a person editing one, so there is
// nothing for a concurrency stamp to protect.
@ticksColumn(false)
export class SqlMigrationEntity extends Entity {
    @uniqueIndex
    @stringLengthValidator({ max: 200 })
    versionNumber: string;

    @stringLengthValidator({ min: 0, max: 400 })
    comment: string | null;

    @quoted toString(): string { return this.versionNumber; }
}

@reflect
@entity("System", "Transactional")
// The engine writes these rows, never a person editing one, so there is
// nothing for a concurrency stamp to protect.
@ticksColumn(false)
// LEGACY MODE: Signum calls this class `CSharpMigrationEntity` — the steps are C# there. Only the NAMES
// differ; the two columns are the same, so an application pointed at a Signum database reads and writes
// the rows it already has, and `basics.type` keeps the class name a Signum application synchronizes back.
// The clean name (`CSharpMigration`) and the table (`c_sharp_migration`) follow from it.
@legacyClassName("CSharpMigrationEntity")
export class TypeScriptMigrationEntity extends Entity {
    @uniqueIndex
    @stringLengthValidator({ max: 200 })
    uniqueName: string;

    executionDate: Temporal.PlainDateTime;

    @quoted toString(): string { return this.uniqueName; }
}

@reflect
@entity("System", "Transactional")
// The engine writes these rows, never a person editing one, so there is
// nothing for a concurrency stamp to protect.
@ticksColumn(false)
export class LoadMethodLogEntity extends Entity {
    @stringLengthValidator({ min: 3, max: 400 })
    methodName: string | null;

    @stringLengthValidator({ min: 3, max: 400 })
    className: string | null;

    @stringLengthValidator({ min: 3, max: 400 })
    description: string | null;

    start: Temporal.PlainDateTime;

    end: Temporal.PlainDateTime | null;

    exception: Lite<ExceptionEntity> | null;

    /**
     * Signum's `[ExpressionField("DurationExpression"), Unit("ms")] public double? Duration` — how long the
     * load method ran, in milliseconds, null while `end` is unset (a run still going, or one that threw).
     * `@quoted`, so it is a real SQL column the log's search page can order and filter by: Signum's own
     * `MigrationLogic` puts `e.Duration` in this query's default columns.
     *
     * The guard is load-bearing — a difference taken against a NULL `end` would report a wrong number
     * rather than "unknown". The ternary lowers to a CASE WHEN and `since().total({ unit })` to a real
     * DATEDIFF; it was described here as impossible, which it is not.
     *
     * The guard is written VALUE-FIRST (`end != null ? … : null`, never `end == null ? null : …`):
     * `ConditionalExpression.calculateType` is `whenTrue.type || whenFalse.type`, and the `null` literal
     * HAS a type, so a null-first ternary types the whole expression as null and the registration then
     * rejects it as "neither @quoted nor @resultType". Same spelling as SessionLogEntity.durationSeconds.
     *
     * Renamed from `duration()` so the unit is in the name, as every other altea log spells it;
     * `@legacyPropertyRoute("Duration")` keeps the `basics.property_route` row a Signum database has
     * under the C# property's name.
     */
    @legacyPropertyRoute("Duration")
    @quoted durationMilliseconds(): number | null {
        return this.end != null ? this.end.since(this.start).total({ unit: "milliseconds" }) : null;
    }

    @quoted toString(): string { return this.methodName ?? ""; }
}

// Only the strings the runners actually print are declared; the console UI is otherwise plain.
export const MigrationMessage = {
    // The caption of the `Duration` token over LoadMethodLogEntity.durationMilliseconds() (registered in
    // MigrationLogic). Signum translates it as that entity's `Duration` PROPERTY; a `@quoted` method is
    // not a PropertyRoute, so it has no <Member> entry of its own to hold a translation and the caption
    // has to be a message.
    Duration: msg(),
    // Explicit text: the humaniser would make "Reading type script migrations" of the member name.
    ReadingTypeScriptMigrations: msg("Reading TypeScript migrations"),
    AllMigrationsAreExecuted: msg(),
    RunMigrations0: msg(),
    ReadingMigrationsFrom0: msg(),
    CreateNewMigration: msg(),
    NoChangesFound: msg(),
    SomeChangesFoundHereIsTheScript: msg(),
    CommentForTheNewMigration: msg(),
    Run0Migrations: msg(),
    ThereAreFreshExecutedMigrationsThatAreNotInTheFolderGetLatestVersion: msg(),
    PossibleMergeConflictThereAreOldMigrationsInTheFolderThatHaveNotBeenExecuted: msg(),
    Table0AutoGenerated: msg(),
    Directory0AutoGenerated: msg(),
};

setDefaultDatabaseSchema("migrations");
