import { Dic } from "@altea/altea/data/globals";
import * as AppContext from "@altea/altea/client/AppContext";

// Port of Signum's `OmniboxSpecialAction` (Signum/React/OmniboxSpecialAction.ts): the registry of
// "!Command" actions — client-side commands the omnibox can fire ("!SwitchUser", "!ClearCache", …).
//
// ALTEA DIVERGENCE: Signum kept this in the FRAMEWORK (`@framework/OmniboxSpecialAction`) so extension
// clients could register actions without depending on Signum.Omnibox — the extension was assumed present.
// altea keeps the registry inside this module: no altea package currently registers a special action, and
// putting it in the core would give the framework a concept it otherwise has no use for. A module that
// wants one takes a dependency on @altea/altea-omnibox (the same way it would on any other extension).
//
// `allowed` is evaluated CLIENT-side before the keys are posted (the server can only fuzzy-match what it
// is told); the action itself is expected to be authorized again wherever its onClick lands.
// In `AppContext.clientState` rather than a module-level dictionary — see the note on Navigator's
// entitySettings. This registry is the one that REFUSES a duplicate rather than overwriting it, so it was
// also the one that surfaced: with the registry module-global, the second run of a host's registration
// bundle died with "Action 'PrintPanel' already registered".
declare module "@altea/altea/client/AppContext" {
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
