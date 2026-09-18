import { reflect, init, MAX_SIZE } from "@altea/altea/data/reflection";
import type { IUserEntity } from "@altea/altea/data/security";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, implementedBy, quoted } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import type { ConstructSymbol, ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { UserEntity } from "@altea/altea-auth/data/User";

// Port of Signum.Dynamic's SqlMigrations/DynamicSqlMigration.cs — a schema-synchronization script generated,
// reviewed and executed from the ADMIN UI rather than from the terminal, with a record of who ran it and
// when. No compiler is involved: the script is SQL text.
//
// altea divergences:
//  - `DynamicRenameEntity` is ported and `Create` uses it, but nothing WRITES a rename row automatically:
//    in Signum the dynamic-TYPE editor does, and that editor needs Roslyn (see DynamicLogic.server.ts), so
//    here a rename is recorded by hand or through `DynamicSqlMigrationLogic.addDynamicRename`. The overlap with @altea/altea-migrations is deliberate and narrow: that package OWNS the
//    versioned migration history and the runners; this one is "see and apply the pending schema diff from
//    the browser", and it records its executions here rather than there.
//  - `DynamicSqlMigrationMessage.PreventingGenerationNewScript…` is kept but can no longer trigger: it
//    guarded against generating a script while the dynamic C# failed to compile.
@reflect
@entity("Main", "Transactional")
export class DynamicSqlMigrationEntity extends Entity {

    creationDate: Temporal.PlainDateTime = Clock.now;

    // Signum's `[ImplementedBy(typeof(UserEntity))] Lite<IUserEntity>`. No implementations are named
    // here, so this module needs no reference to altea-auth; the app widens it in its EntityOverrides
    // (the same accommodation ExceptionEntity.user and OperationLogEntity.user make).
    @implementedBy(() => [])
    createdBy: Lite<IUserEntity>;

    executionDate: Temporal.PlainDateTime | null;

    // Signum's `[ImplementedBy(typeof(UserEntity))] Lite<IUserEntity>`. No implementations are named
    // here, so this module needs no reference to altea-auth; the app widens it in its EntityOverrides
    // (the same accommodation ExceptionEntity.user and OperationLogEntity.user make).
    @implementedBy(() => [])
    executedBy: Lite<IUserEntity> | null;

    @stringLengthValidator({ min: 3, max: 200 })
    comment: string;

    // Signum's `Max = int.MaxValue`: this is a whole SQL migration. Without the max it takes the
    // 200-character default a sizeless string column now has.
    @stringLengthValidator({ multiLine: true, max: MAX_SIZE })
    script: string;

    @quoted
    override toString(): string {
        return this.comment;
    }
}

// Signum's DynamicRenameEntity (same file there). One recorded rename — "under THIS replacement key,
// `oldName` became `newName`" — which the next generated migration uses to ANSWER the synchronizer's
// rename questions instead of asking them (see DynamicSqlMigrationLogic.autoReplacement).
//
// In Signum the rows are written by the dynamic-TYPE editor, which needs Roslyn and does not port; here
// they are written by hand (or by `DynamicSqlMigrationLogic.addDynamicRename`) — which is the point, since
// a rename recorded once is then applied by every later `sync` of that database without a prompt.
@reflect
@entity("Main", "Transactional")
export class DynamicRenameEntity extends Entity {

    creationDate: Temporal.PlainDateTime = Clock.now;

    /** The synchronizer bucket the rename belongs to: `Tables`, `Columns:<table>`, `Enums:<table>`. */
    @stringLengthValidator({ max: 200 })
    replacementKey: string;

    @stringLengthValidator({ max: 200 })
    oldName: string;

    @stringLengthValidator({ max: 200 })
    newName: string;

    @quoted
    override toString(): string {
        return this.replacementKey + ": " + this.oldName + " -> " + this.newName;
    }
}

export namespace DynamicSqlMigrationOperation {
    export const Create: ConstructSymbol<DynamicSqlMigrationEntity> = init();
    export const Save: ExecuteSymbol<DynamicSqlMigrationEntity> = init();
    export const Execute: ExecuteSymbol<DynamicSqlMigrationEntity> = init();
    export const Delete: DeleteSymbol<DynamicSqlMigrationEntity> = init();
}

export const DynamicSqlMigrationMessage = {
    TheMigrationIsAlreadyExecuted: msg("The migration is already executed"),
    PreventingGenerationNewScriptBecauseOfErrorsInDynamicCodeFixErrorsAndRestartServer:
        msg("Preventing the generation of a new Script because of errors in dynamic code."
            + " Fix the errors and restart the server."),
    TheSchemaIsAlreadyUpToDate: msg("The schema is already up to date"),
};
