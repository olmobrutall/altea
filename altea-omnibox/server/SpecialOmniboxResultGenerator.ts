import type { HelpOmniboxResult, OmniboxResult, SpecialOmniboxResult } from "../data/OmniboxResults";
import { OmniboxResultTypeName } from "../data/OmniboxResults";
import {
    helpResult, type OmniboxContext, type OmniboxResultGenerator, type OmniboxToken,
} from "./OmniboxParser";
import { isPascalCasePattern, matches } from "./OmniboxUtils";

// Port of Signum's `SpecialOmniboxGenerator<T>` + `ReactSpecialOmniboxGenerator`
// (Signum.Omnibox/SpecialOmniboxResultGenerator.cs / ReactSpecialOmniboxGenerator.cs): the "!Command"
// shape — `!` followed by an optional identifier — matched against the client's registered special
// actions ("!SwitchUser", "!Profiler", …).
//
// The action CATALOGUE lives in the browser (each is a client-side onClick), so the client posts the keys
// it has registered and considers allowed, and the server only fuzzy-matches. Signum merged its two
// classes precisely because of that split — a generic generator over a dictionary, plus a thin
// AsyncThreadVariable-backed wrapper that swapped in a per-request dictionary. altea passes the
// per-request `OmniboxContext` to every generator instead, so the wrapper (and its ambient state) is
// gone: this ONE class builds its dictionary from `ctx.specialActions`.
//
// Signum's `ReactSpecialOmniboxAction.Allowed` was hardcoded `() => true` with the comment "filtered
// client-side to avoid duplication, at the end the action itself is server-side checked" — kept: the
// filter below is unconditional.
const REGEX = /^!I?$/;

export class SpecialOmniboxGenerator implements OmniboxResultGenerator {

    getResults(_rawQuery: string, tokens: OmniboxToken[], tokenPattern: string, ctx: OmniboxContext): Promise<OmniboxResult[]> {
        if (!REGEX.test(tokenPattern))
            return Promise.resolve([]);

        const ident = tokens.length === 1 ? "" : tokens[1].value;

        const isPascalCase = isPascalCasePattern(ident);

        // Signum keyed the dictionary by the action key VERBATIM (not the omnibox-pascal form) — action
        // keys are already PascalCase identifiers.
        const actions = new Map<string, string>(ctx.specialActions.map(a => [a, a]));

        const result: SpecialOmniboxResult[] = [...matches(actions, () => true, ident, isPascalCase)]
            .map(m => ({
                resultTypeName: OmniboxResultTypeName.Special,
                distance: m.match.distance,
                match: m.match,
                key: m.value,
            }));

        return Promise.resolve(result);
    }

    getHelp(_ctx: OmniboxContext): HelpOmniboxResult[] {
        return [helpResult("!SpecialFunction", OmniboxResultTypeName.Special)];
    }
}
