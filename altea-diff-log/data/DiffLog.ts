import { reflect, init } from "@altea/altea/data/reflection";
import { MixinEntity, type Type } from "@altea/altea/data/entity";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { OperationLogEntity } from "@altea/altea/data/operationLog";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { msg } from "@altea/altea/data/utils/localization";
import type { TypeConditionSymbol } from "@altea/altea-auth/data/Rules";

// Port of Signum.DiffLog's DiffLogMixin.cs — the two dumps an operation brackets, stored on the operation
// log itself, plus the messages the OperationLog view reads.
//
// altea divergences, documented inline:
//  - `[BindParent]` is implicit: an embedded belongs to its owner in altea.
//  - altea INLINES a mixin's fields onto the owner (`entity.mixin(X)` is a typed cast returning `this`), so
//    `initialState` / `finalState` / `cleaned` become OperationLogEntity's own fields and their columns are
//    FLATTENED (`initial_state_text`, …). Reading them through `log.mixin(DiffLogMixin)` still works and is
//    what the port does, so the call sites read like Signum's.
@reflect
export class DiffLogMixin extends MixinEntity {

    /** The entity's dump BEFORE the operation ran. */
    initialState: BigStringEmbedded = new BigStringEmbedded();

    /** The dump AFTER it ran (empty for a Delete — there is nothing left to dump). */
    finalState: BigStringEmbedded = new BigStringEmbedded();

    /** Signum's `Cleaned` — set when a log-cleaning process has discarded the dumps to reclaim space. */
    cleaned: boolean = false;
}

export namespace DiffLogMixin {
    let declared = false;

    /**
     * Declare the mixin on OperationLogEntity (Signum's `MixinDeclarations.Register<OperationLogEntity,
     * DiffLogMixin>()`, which Southwind calls in its Starter and DiffLogLogic merely asserts). Idempotent,
     * and it must run on BOTH TIERS before anything is (de)serialized or the schema is built — it is what
     * tells the serializer and the schema builder that the three fields exist. Put the call in the module
     * the client and the server both load, next to the app's other entity overrides.
     */
    export function declare(): void {
        if (declared)
            return;
        declared = true;

        MixinDeclarations.register(
            OperationLogEntity as unknown as Type<OperationLogEntity>,
            DiffLogMixin as unknown as Type<DiffLogMixin>);
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

    // altea additions — the two controls Signum labels with hardcoded English in DiffDocument /
    // OperationLog. They are UI text like everything else here, so they get message keys.
    SimplifyChanges: msg("Simplify changes"),
    ShowOnly0LinesAroundEachChange: msg("Show only {0} lines around each change"),
    TheTwoStringsAreTooBig01AndCouldFreezeYourBrowser:
        msg("The two strings are too big ({0} and {1}) and could freeze your browser..."),
    TryAnyway: msg("Try anyway!"),
    _0LinesRemoved: msg("----- {0} lines removed -----"),
};

/**
 * Signum's `OperationLogTypeCondition.FilteringByTarget` — the row-level condition that lets a user see an
 * OperationLog when they are already filtering by a target they may read.
 *
 * DECLARED but NOT registered: `TypeConditionLogic.registerWhenAlreadyFilteringBy` (whose whole point is
 * "this condition holds only when the query already constrains `target`") has no altea counterpart, so
 * nothing installs a predicate for it. The symbol stays so an application can grant it in the role rules and
 * a later port can fill it in; until then an OperationLog is governed by the plain type rules.
 */
export namespace OperationLogTypeCondition {
    export const FilteringByTarget: TypeConditionSymbol = init();
}
