import { cleanTypeName } from "@altea/altea/data/registration";
import type { HelpOmniboxResult, OmniboxResult } from "@altea/altea-omnibox/data/OmniboxResults";
import {
    OmniboxParser, helpResult,
    type OmniboxContext, type OmniboxResultGenerator, type OmniboxToken,
} from "@altea/altea-omnibox/server/OmniboxParser";
import { isPascalCasePattern, matches } from "@altea/altea-omnibox/server/OmniboxUtils";
import { allowedTypeFilter } from "@altea/altea-omnibox/server/OmniboxAuth";
import { TreeEntity, TreeMessage, TreeOmniboxResultTypeName, type TreeOmniboxResult } from "../data/Tree";

// Port of Signum.Tree's TreeOmniboxResultGenertor.cs [sic] — typing a tree type's name offers its TREE
// page, ranked slightly above the plain search suggestion for the same type (Signum's `Distance - 0.1f`).
//
// altea divergences: the result DTO is declared once in data/Tree.ts (Signum needs a JsonConverter to turn
// its `Type` into a query key); the allowed-type filter is altea-omnibox's async-resolved
// `allowedTypeFilter`, the adaptation every altea omnibox generator makes.
export class TreeOmniboxResultGenerator implements OmniboxResultGenerator {

    async getResults(_rawQuery: string, tokens: OmniboxToken[], tokenPattern: string, _ctx: OmniboxContext): Promise<OmniboxResult[]> {
        if (tokenPattern !== "I")
            return [];

        const pattern = tokens[0].value;
        const isPascalCase = isPascalCasePattern(pattern);

        const treeTypes = new Map(
            [...OmniboxParser.manager.types().entries()]
                .filter(([, ctor]) => ctor !== TreeEntity && ctor.prototype instanceof TreeEntity));

        if (treeTypes.size === 0)
            return [];

        const isAllowed = await allowedTypeFilter([...treeTypes.values()]);

        return [...matches(treeTypes, isAllowed, pattern, isPascalCase)]
            .sort((a, b) => a.match.distance - b.match.distance)
            .map((m): TreeOmniboxResult => ({
                resultTypeName: TreeOmniboxResultTypeName,
                // Signum's `- 0.1f`: with both a tree page and a search page on offer for the same type,
                // the tree is the more specific answer.
                distance: m.match.distance - 0.1,
                type: cleanTypeName(m.value),
                typeMatch: m.match,
            }));
    }

    getHelp(_ctx: OmniboxContext): HelpOmniboxResult[] {
        return [helpResult(TreeMessage.TreeType.niceToString(), TreeOmniboxResultTypeName)];
    }
}
