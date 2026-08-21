import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, stringLengthValidator, implementedBy, quoted } from "@altea/altea/data/decorators";
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
//  - Signum's `Create` runs the synchronizer with AUTO-REPLACEMENTS derived from `DynamicRenameEntity` rows,
//    which the dynamic-TYPE editor writes when a type or property is renamed. That editor needs Roslyn and
//    does not port (see DynamicLogic.server.ts), so nothing would ever write a rename row — hence
//    `DynamicRenameEntity` is NOT ported and `Create` simply generates the script the terminal's `sync`
//    would. The overlap with @altea/altea-migrations is deliberate and narrow: that package OWNS the
//    versioned migration history and the runners; this one is "see and apply the pending schema diff from
//    the browser", and it records its executions here rather than there.
//  - `DynamicSqlMigrationMessage.PreventingGenerationNewScript…` is kept but can no longer trigger: it
//    guarded against generating a script while the dynamic C# failed to compile.
@reflect
@entity("Main", "Transactional")
export class DynamicSqlMigrationEntity extends Entity {

    creationDate: Temporal.PlainDateTime = Clock.now;

    @implementedBy(() => [UserEntity])
    createdBy: Lite<UserEntity>;

    executionDate: Temporal.PlainDateTime | null;

    @implementedBy(() => [UserEntity])
    executedBy: Lite<UserEntity> | null;

    @stringLengthValidator({ min: 3, max: 200 })
    comment: string;

    @stringLengthValidator({ multiLine: true })
    script: string;

    @quoted
    override toString(): string {
        return this.comment;
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
