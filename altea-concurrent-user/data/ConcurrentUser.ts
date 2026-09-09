import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, implementedByAll, legacyColumnName, quoted } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { Temporal } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import type { DeleteSymbol } from "@altea/altea/data/operations";
import { UserEntity } from "@altea/altea-auth/data/User";

// The presence row: "user U, on connection C, has entity E open since T (and has unsaved changes)". One row
// per (connection, user, entity); the hub inserts on enter, updates `isModified` on a heartbeat, and
// deletes on exit or disconnect.
//
// Port of Signum.ConcurrentUser's ConcurrentUser.cs — see docs/port/ConcurrentUser.md.
@reflect
@entity("System", "Transactional")
export class ConcurrentUserEntity extends Entity {

    /** The entity being watched. `@implementedByAll` — ANY type can be opened. */
    @implementedByAll
    targetEntity: Lite<Entity>;

    startTime: Temporal.PlainDateTime;

    user: Lite<UserEntity>;

    /** The WebSocket hub connection this row belongs to. The COLUMN keeps Signum's name (@legacyColumnName). */
    @stringLengthValidator({ max: 100 })
    @legacyColumnName("SignalRConnectionID")
    connectionID: string;

    /** True while that tab holds unsaved changes — the hub is told on a 1s client heartbeat. */
    isModified: boolean;

    @quoted
    toString(): string {
        return `${this.user} - ${this.startTime}`;
    }
}

export namespace ConcurrentUserOperation {
    export const Delete: DeleteSymbol<ConcurrentUserEntity> = init();
}

export const ConcurrentUserMessage = {
    ConcurrentUsers: msg("Concurrent users"),
    CurrentlyEditing: msg("Currently editing"),
    DatabaseChangesDetected: msg("Database changes detected!"),
    LooksLikeSomeoneJustSaved0ToTheDatabase: msg("Looks like someone just saved {0} in the database."),
    DoYouWantToReloadIt: msg("Do you want to reload it?"),
    YouHaveLocalChangesIn0ThatIsCurrentlyOpenByOtherUsersSoFarNoOneElseHasMadeModifications:
        msg("You have local changes in {0} which is currently open by other users. So far no one else has made modifications. "),
    LooksLikeYouAreNotTheOnlyOneCurrentlyModifiying0OnlyTheFirstOneWillBeAbleToSaveChanges:
        msg("Looks like you are not the only one currently modifying {0}... only the first one will be able to save changes!"),
    YouHaveLocalChangesBut0HasAlreadyBeenSavedInTheDatabaseYouWillNotBeAbleToSaveChanges:
        msg("You have local changes but {0} has already been saved in the database... you will not be able to save changes :("),
    ThisIsNotTheLatestVersionOf0: msg("This is not the latest version of {0}"),
    ReloadIt: msg("Reload it!"),
    WarningYouWillLostYourCurrentChanges: msg("WARNING: You will lost your current changes."),
    ConsiderOpening0InANewTabAndApplyYourChangesManually: msg("Consider opening {0} in a new tab and apply your changes manually"),
};

setDefaultDatabaseSchema("concurrentUser");
