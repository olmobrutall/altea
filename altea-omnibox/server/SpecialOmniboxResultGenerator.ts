import type { HelpOmniboxResult, OmniboxResult, SpecialOmniboxResult } from "../data/OmniboxResults";
import { OmniboxResultTypeName } from "../data/OmniboxResults";
import {
    helpResult, type OmniboxContext, type OmniboxResultGenerator, type OmniboxToken,
} from "./OmniboxParser";
import { isPascalCasePattern, matches } from "./OmniboxUtils";

// Port of Signum.Omnibox's SpecialOmniboxResultGenerator.cs + ReactSpecialOmniboxGenerator.cs — see
// port/Omnibox.md.
//
// The "!Command" shape — `!` followed by an optional identifier — matched against the client's registered
// special actions ("!SwitchUser", "!Profiler", …).
//
// The action CATALOGUE lives in the BROWSER (each is a client-side onClick), so the client posts the keys
// it has registered and considers allowed, and the server only fuzzy-matches. ONE class rather than two:
// the per-request dictionary is built from `ctx.specialActions` instead of swapped into ambient state.
//
// The filter below is UNCONDITIONAL by design — the actions are filtered client-side to avoid duplication,
// and each action is server-side checked when it actually runs.
const REGEX = /^!I?$/;

export class SpecialOmniboxGenerator implements OmniboxResultGenerator {

    getResults(_rawQuery: string, tokens: OmniboxToken[], tokenPattern: string, ctx: OmniboxContext): Promise<OmniboxResult[]> {
        if (!REGEX.test(tokenPattern))
            return Promise.resolve([]);

        const ident = tokens.length === 1 ? "" : tokens[1].value;

        const isPascalCase = isPascalCasePattern(ident);

        // Keyed by the action key VERBATIM, not the omnibox-pascal form: action keys are already
        // PascalCase identifiers.
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
