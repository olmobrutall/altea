import { init } from "@altea/altea/data/reflection";
import { msg } from "@altea/altea/data/utils/localization";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";

// Port of Signum.TimeMachine's TimeMachine.cs — the messages the Time Machine UI reads and the one
// permission that gates it.
//
// The module has no entities of its own: everything it shows already exists in the database as the
// HISTORY of system-versioned tables (`sb.include(X).withSystemVersioned()`), which core already
// queries through `SystemTime` (server/systemTime.ts) and already exposes in the SearchControl's
// "Time Machine" system-time dropdown. This module is the READER: a page that lists a row's versions,
// a diff between two of them, and the restore helpers.

export namespace TimeMachinePermission {
    /** Gates the quick link, the search control's system-time button, and the page. */
    export const ShowTimeMachine: PermissionSymbol = init();
}

export const TimeMachineMessage = {
    TimeMachine: msg("Time Machine"),
    EntityDeleted: msg("[Entity deleted]"),
    CompareVersions: msg("Compare versions"),
    AllVersions: msg("All versions"),
    SelectedVersions: msg("Selected versions"),
    UIDifferences: msg("UI differences"),
    DataDifferences: msg("Data differences"),
    UISnapshot: msg("UI snapshot"),
    DataSnapshot: msg("Data snapshot"),
    ShowDiffs: msg("Show diffs"),
    YouCanNotSelectMoreThanTwoVersionToCompare: msg("You can not select more than two versions to compare"),
    BetweenThisTimeRange: msg("(between this time range)"),
    ThisVersionWasCreated: msg("This version was CREATED"),
    ThisVersionWasDeleted: msg("This version was DELETED"),
    ThisVersionWasCreatedAndDeleted: msg("This version was CREATED and DELETED"),
    ThisVersionDidNotChange: msg("This version DID NOT CHANGE"),
};
