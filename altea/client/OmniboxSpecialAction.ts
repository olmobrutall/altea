import { Dic } from "../data/globals";
import * as AppContext from "./AppContext";

// Port of Signum's `OmniboxSpecialAction` (Signum/React/OmniboxSpecialAction.ts): the registry of
// "!Command" actions — client-side commands the omnibox offers ("!ProcessPanel", "!SchedulerPanel", …).
//
// Lives in the FRAMEWORK, exactly as Signum's does, so a module can contribute an omnibox entry WITHOUT
// depending on @altea/altea-omnibox — the same renderer-slot shape core already keeps for altea-tour's
// TourButton. It had briefly lived inside altea-omnibox on the reasoning that core should not carry a
// concept it has no use for; that cost each of the eleven contributing modules a dependency on an
// OPTIONAL extension, and made one of them impossible: altea-omnibox itself depends on @altea/altea-auth
// (PermissionSymbol, the auth logics), so AuthAdminClient's "!DownloadAuthRules" would have closed a
// package cycle. A registry with no consumer is inert — nothing reads it unless altea-omnibox is
// installed — so hosting it here costs nothing and is what Signum does.
//
// `allowed` is evaluated CLIENT-side before the keys are posted (the server can only fuzzy-match what it
// is told); the action itself is expected to be authorized again wherever its onClick lands.
// In `AppContext.clientState` rather than a module-level dictionary — see the note on Navigator's
// entitySettings. This registry is the one that REFUSES a duplicate rather than overwriting it, so it was
// also the one that surfaced: with the registry module-global, the second run of a host's registration
// bundle died with "Action 'PrintPanel' already registered".
declare module "./AppContext" {
    interface IClientState {
        omniboxSpecialActions?: { [actionKey: string]: SpecialOmniboxAction };
    }
}

export function specialActions(): { [actionKey: string]: SpecialOmniboxAction } {
    return AppContext.clientState.omniboxSpecialActions ??= {};
}

export function clearSpecialActions(): void {
    AppContext.clientState.omniboxSpecialActions = undefined;
}

export function registerSpecialAction(action: SpecialOmniboxAction): void {
    const actions = specialActions();
    if (actions[action.key])
        throw new Error(`Action '${action.key}' already registered`);

    actions[action.key] = action;
}

/** The keys the omnibox should offer right now (Signum's client-side `allowed` filter). */
export function allowedSpecialActionKeys(): string[] {
    const actions = specialActions();
    return Dic.getKeys(actions).filter(a => actions[a].allowed == null || actions[a].allowed());
}

export interface SpecialOmniboxAction {
    key: string;
    allowed: () => boolean;
    /** Resolves to the URL to navigate to, or undefined when the action handled itself (a modal, a reload). */
    onClick: () => Promise<string | undefined>;
}
