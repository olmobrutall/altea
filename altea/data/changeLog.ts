import { init } from "./reflection";
import { Entity } from "./entity";
import { Lite } from "./lite";
import { entity, implementedBy, uniqueIndex, quoted } from "./decorators";
import { Temporal } from "./basics";
import { msg } from "./utils/localization";
import type { IUserEntity } from "./security";
import type { DeleteSymbol } from "./operations";

// Port of Signum's Basics/ChangeLog.cs — the CHANGE LOG: the "what changed in this deployment" list a user
// can open from the navbar, with a badge counting the entries they have not seen.
//
// The stored part is deliberately tiny, and it is the only stored part: ONE row per user, holding when that
// user last looked. Everything else — the entries themselves — is SOURCE, a `Changelog.ts` dictionary per
// module that ships with the code (see client/Basics/ChangeLogClient). That is the whole design: a change
// log entry is written by whoever wrote the change, in the same commit, and a database migration is never
// needed to publish one.
//
// NOTE this is NOT altea-whats-new, which looks similar and answers a different question. WhatsNew is
// CONTENT: rows an author writes in the app, per culture, published on a date, for END USERS. The change log
// is the DEVELOPERS' list, compiled into the client, and it is per MODULE — which is what lets the app's own
// "Update Altea" line pull the framework's entries into the app's deployment timeline (`getChangeLogs`).

@entity("System", "Transactional")
export class ChangeLogViewLogEntity extends Entity {

    /**
     * ONE row per user, hence Signum's `[UniqueIndex]`.
     *
     * altea divergence: `user` declares NO implementations (`@implementedBy(() => [])`) so core needn't
     * reference altea-auth; the app widens it to the concrete user type in its EntityOverrides — the same
     * accommodation `VisualTipConsumedEntity.user` and `ExceptionEntity.user` already make.
     */
    @uniqueIndex
    @implementedBy(() => [])
    user: Lite<IUserEntity>;

    lastDate: Temporal.PlainDateTime;

    @quoted
    override toString(): string {
        return this.user.toString();
    }
}

export namespace ChangeLogViewLogOperation {
    export const Delete: DeleteSymbol<ChangeLogViewLogEntity> = init();
}

export const ChangeLogMessage = {
    ThereIsNotAnyNewChangesFrom0: msg("There is not any new changes from {0}"),
    SeeMore: msg("See more…"),
    SeeMoreChangeLogEntries: msg("See more change log entries"),
    ChangeLogs: msg("Change logs"),
    DeployedOn0: msg("Deployed on {0}"),
    _0ImplementedOn1WithFollowingChanges2: msg("{0}, implemented on {1} with following changes: {2}"),
    ChangeLogEntries: msg("Change log entries"),
};
