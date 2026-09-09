import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { MixinEntity, type Type } from "@altea/altea/data/entity";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { OperationLogEntity } from "@altea/altea/data/operationLog";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { msg } from "@altea/altea/data/utils/localization";
import type { TypeConditionSymbol } from "@altea/altea-auth/data/Rules";

// The two dumps an operation brackets, stored on the operation log itself, plus the messages the
// OperationLog view reads.
//
// A mixin's fields are INLINED onto the owner (`entity.mixin(X)` is a typed cast returning `this`), so
// `initialState` / `finalState` / `cleaned` become OperationLogEntity's own fields and their columns are
// FLATTENED (`initial_state_text`, …). Reading them through `log.mixin(DiffLogMixin)` still works.
//
// Port of Signum.DiffLog's DiffLogMixin.cs — see docs/port/DiffLog.md.
@reflect
export class DiffLogMixin extends MixinEntity {

    /** The entity's dump BEFORE the operation ran. */
    initialState: BigStringEmbedded = new BigStringEmbedded();

    /** The dump AFTER it ran (empty for a Delete — there is nothing left to dump). */
    finalState: BigStringEmbedded = new BigStringEmbedded();

    /** Set when a log-cleaning process has discarded the dumps to reclaim space. */
    cleaned: boolean = false;
}

export namespace DiffLogMixin {
    let declared = false;

    /**
     * Declare the mixin on OperationLogEntity. Idempotent, and it must run on BOTH TIERS before anything is
     * (de)serialized or the schema is built — it is what tells the serializer and the schema builder that
     * the three fields exist. Put the call in the module the client and the server both load, next to the
     * app's other entity overrides.
     */
    export function declare(): void {
        if (declared)
            return;
        declared = true;

        MixinDeclarations.register(
            OperationLogEntity,
            DiffLogMixin);
    }

    export function isDeclared(): boolean {
        return declared;
    }
}

export const DiffLogMessage = {
    PreviousLog: msg("Previous log"),
    NextLog: msg("Next log"),
    CurrentEntity: msg("Current entity"),

    NavigatesToThePreviousOperationLog: msg("Navigates to the previous operation log"),
    DifferenceBetweenFinalStateOfPreviousLogAndTheInitialState:
        msg("Difference between final state of previous log and the initial state"),
    StateWhenTheOperationStarted: msg("State when the operation started"),
    DifferenceBetweenInitialStateAndFinalState: msg("Difference between initial state and final state"),
    StateWhenTheOperationFinished: msg("State when the operation finished"),
    DifferenceBetweenFinalStateAndTheInitialStateOfNextLog:
        msg("Difference between final state and the initial state of next log"),
    NavigatesToTheNextOperationLog: msg("Navigates to the next operation log"),
    DifferenceBetweenFinalStateAndTheCurrentStateOfTheEntity:
        msg("Difference between final state and the current state of the entity"),
    NavigatesToTheCurrentEntity: msg("Navigates to the current entity"),

    // The two controls Signum labels with hardcoded English. They are UI text like everything else here,
    // so they get message keys.
    SimplifyChanges: msg("Simplify changes"),
    ShowOnly0LinesAroundEachChange: msg("Show only {0} lines around each change"),
    TheTwoStringsAreTooBig01AndCouldFreezeYourBrowser:
        msg("The two strings are too big ({0} and {1}) and could freeze your browser..."),
    TryAnyway: msg("Try anyway!"),
    _0LinesRemoved: msg("----- {0} lines removed -----"),
};

/**
 * The row-level condition that lets a user see an OperationLog when they are already filtering by a target
 * they may read — "you asked for the logs of ONE entity that you are allowed to read".
 *
 * REGISTERED, in DiffLogLogic.start, through `TypeConditionLogic.registerWhenAlreadyFilteringBy`. Grant it
 * in a role's rules to use it.
 */
export namespace OperationLogTypeCondition {
    export const FilteringByTarget: TypeConditionSymbol = init();
}

setDefaultDatabaseSchema("diffLog");
