import { cleanTypeName } from "@altea/altea/data/registration";
import type { HelpOmniboxResult, OmniboxResult } from "@altea/altea-omnibox/data/OmniboxResults";
import { OmniboxMessage } from "@altea/altea-omnibox/data/OmniboxMessages";
import {
    OmniboxParser, OmniboxTokenType, helpResult,
    type OmniboxContext, type OmniboxResultGenerator, type OmniboxToken,
} from "@altea/altea-omnibox/server/OmniboxParser";
import { contains, isPascalCasePattern, matches } from "@altea/altea-omnibox/server/OmniboxUtils";
import { allowedTypeFilter } from "@altea/altea-omnibox/server/OmniboxAuth";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import {
    HelpMessage, HelpPermissions, HelpModuleOmniboxResultTypeName, type HelpModuleOmniboxResult,
} from "../data/Help";

// Port of Signum.Help's HelpModuleOmniboxResult.cs — three shapes: "help" alone (the index), "help Order"
// (that type's page) and "help 'some text'" (the search page).
//
// altea divergences: the result DTO is declared once in data/Help.ts; the type filter is
// altea-omnibox's async-resolved `allowedTypeFilter`; and the third shape now actually goes somewhere (see
// HelpSearch on Signum's dead search).

/** `^I` = the keyword alone; `^II` = keyword + type; `^IS` = keyword + a quoted search string. */
const REGEX = /^I[IS]?$/;

export class HelpOmniboxResultGenerator implements OmniboxResultGenerator {

    async getResults(_rawQuery: string, tokens: OmniboxToken[], tokenPattern: string, _ctx: OmniboxContext): Promise<OmniboxResult[]> {
        if (tokens.length === 0 || !REGEX.test(tokenPattern))
            return [];

        if (!await PermissionAuthLogic.isAuthorized(HelpPermissions.ViewHelp))
            return [];

        const niceName = OmniboxMessage.Omnibox_Help.niceToString();

        // Signum matches the localised word first, then the literal "help" — so an English keyword works
        // in any culture.
        const keywordMatch = contains(niceName, niceName, tokens[0].value) ?? contains("help", "help", tokens[0].value);
        if (keywordMatch == undefined)
            return [];

        if (tokenPattern === "I") {
            const indexOnly: HelpModuleOmniboxResult = {
                resultTypeName: HelpModuleOmniboxResultTypeName,
                distance: keywordMatch.match.distance,
                keywordMatch: keywordMatch.match,
            };
            return [indexOnly];
        }

        if (tokens.length !== 2)
            return [];

        if (tokens[1].type === OmniboxTokenType.String) {
            const searchOnly: HelpModuleOmniboxResult = {
                resultTypeName: HelpModuleOmniboxResultTypeName,
                distance: keywordMatch.match.distance,
                keywordMatch: keywordMatch.match,
                searchString: tokens[1].value.replace(/^['"]|['"]$/g, ""),
            };
            return [searchOnly];
        }

        const pattern = tokens[1].value;
        const isPascalCase = isPascalCasePattern(pattern);
        const types = OmniboxParser.manager.types();
        const isAllowed = await allowedTypeFilter([...types.values()]);

        return [...matches(types, isAllowed, pattern, isPascalCase)]
            .sort((a, b) => a.match.distance - b.match.distance)
            .map((m): HelpModuleOmniboxResult => ({
                resultTypeName: HelpModuleOmniboxResultTypeName,
                distance: keywordMatch.match.distance + m.match.distance,
                keywordMatch: keywordMatch.match,
                typeName: cleanTypeName(m.value),
                secondMatch: m.match,
            }));
    }

    getHelp(_ctx: OmniboxContext): HelpOmniboxResult[] {
        const niceName = OmniboxMessage.Omnibox_Help.niceToString();

        return [
            helpResult(`${niceName} ${OmniboxMessage.Omnibox_Type.niceToString()}`, HelpModuleOmniboxResultTypeName),
            helpResult(`${niceName} '${HelpMessage.SearchText.niceToString()}'`, HelpModuleOmniboxResultTypeName),
        ];
    }
}
