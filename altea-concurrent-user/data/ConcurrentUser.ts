import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, implementedByAll, quoted, stringLengthValidator } from "@altea/altea/data/decorators";
import { Temporal } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import type { DeleteSymbol } from "@altea/altea/data/operations";
import { UserEntity } from "@altea/altea-auth/data/User";

// Port of Signum.ConcurrentUser's ConcurrentUser.cs — the presence row: "user U, on connection C, has
// entity E open since T (and has unsaved changes)". One row per (connection, user, entity); the hub
// inserts on enter, updates `isModified` on a heartbeat, and deletes on exit or disconnect.
//
// altea divergences, documented inline:
//  - `SignalRConnectionID` → `connectionID`. altea has no SignalR (see altea/server/webSocketHub.ts):
//    the column holds the id of a WebSocket hub connection, so naming it after the transport Signum
//    happens to use would be actively misleading. The client DTO already calls it `connectionID`.
//  - `DateTime StartTime` → `Temporal.PlainDateTime` (server-local wall clock, as everywhere in altea).
//  - `Lite<UserEntity>` is used directly rather than core's `@implementedBy(() => [])` + app override:
//    this module already references altea-auth, exactly as Signum.ConcurrentUser references
//    Signum.Authorization.
@reflect
@entity("System", "Transactional")
export class ConcurrentUserEntity extends Entity {

    /** The entity being watched. @implementedByAll — ANY type can be opened (Signum's [ImplementedByAll]). */
    @implementedByAll
    targetEntity: Lite<Entity>;

    startTime: Temporal.PlainDateTime;

    user: Lite<UserEntity>;

    /** The WebSocket hub connection this row belongs to (see the header note on the rename). */
    @stringLengthValidator({ max: 100 })
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
