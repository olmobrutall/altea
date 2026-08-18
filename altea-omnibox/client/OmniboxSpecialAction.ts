import { Dic } from "@altea/altea/data/globals";

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
export const specialActions: { [actionKey: string]: SpecialOmniboxAction } = {};

export function clearSpecialActions(): void {
    Dic.clear(specialActions);
}

export function registerSpecialAction(action: SpecialOmniboxAction): void {
    if (specialActions[action.key])
        throw new Error(`Action '${action.key}' already registered`);

    specialActions[action.key] = action;
}

/** The keys the omnibox should offer right now (Signum's client-side `allowed` filter). */
export function allowedSpecialActionKeys(): string[] {
    return Dic.getKeys(specialActions).filter(a => specialActions[a].allowed == null || specialActions[a].allowed());
}

export interface SpecialOmniboxAction {
    key: string;
    allowed: () => boolean;
    /** Resolves to the URL to navigate to, or undefined when the action handled itself (a modal, a reload). */
    onClick: () => Promise<string | undefined>;
}
