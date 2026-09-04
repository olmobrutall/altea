import { cleanTypeName } from "@altea/altea/data/registration";
import type { HelpOmniboxResult, OmniboxResult } from "@altea/altea-omnibox/data/OmniboxResults";
import {
    OmniboxParser, helpResult,
    type OmniboxContext, type OmniboxResultGenerator, type OmniboxToken,
} from "@altea/altea-omnibox/server/OmniboxParser";
import { contains, isPascalCasePattern, matches } from "@altea/altea-omnibox/server/OmniboxUtils";
import { allowedTypeFilter } from "@altea/altea-omnibox/server/OmniboxAuth";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { OmniboxMessage } from "@altea/altea-omnibox/data/OmniboxMessages";
import { MapMessage, MapPermission, MapOmniboxResultTypeName, type MapOmniboxResult } from "../data/Map";

// Port of Signum.Map's MapOmniboxResultGenerator.cs — "Map" alone opens the schema map, "Map Order" the
// operation map of a type that has operations.
//
// altea divergences:
//  - The result DTO is declared HERE rather than twice (C# class + hand-written TS interface): the
//    discriminator string is the class name Signum used, so the ported client provider is unchanged.
//  - `TypeAuthLogic.GetAllowed(t).MinUI() > None` becomes altea-omnibox's `allowedTypeFilter`, which is
//    async and therefore pre-resolved to a Set — the adaptation every altea omnibox generator makes.
//  - `TypeEntity.NiceName()` in the help line becomes the literal message, since the help row is about
//    "a type", not about the TypeEntity table.

// `^I` = the "Map" keyword alone; `^II` = the keyword plus a type name.
const REGEX = /^II?$/;

export class MapOmniboxResultGenerator implements OmniboxResultGenerator {

    /**
     * Signum passes `type => OperationLogic.TypeOperations(type).Any()` from MapLogic — the module owning
     * the predicate rather than the generator, so a host can narrow which types are offered.
     */
    constructor(public hasOperations: (type: Function) => boolean) { }

    async getResults(_rawQuery: string, tokens: OmniboxToken[], tokenPattern: string, _ctx: OmniboxContext): Promise<OmniboxResult[]> {
        if (!REGEX.test(tokenPattern))
            return [];

        if (!await PermissionAuthLogic.isAuthorized(MapPermission.ViewMap))
            return [];

        const niceName = MapMessage.Map.niceToString();
        const keywordMatch = contains(niceName, niceName, tokens[0].value);

        if (keywordMatch == undefined)
            return [];

        if (tokens.length === 1) {
            const keywordOnly: MapOmniboxResult = {
                resultTypeName: MapOmniboxResultTypeName,
                distance: keywordMatch.match.distance,
                keywordMatch: keywordMatch.match,
            };
            return [keywordOnly];
        }

        const pattern = tokens[1].value;
        const isPascalCase = isPascalCasePattern(pattern);

        const withOperations = new Map(
            [...OmniboxParser.manager.types().entries()].filter(([, ctor]) => this.hasOperations(ctor)));

        const isAllowed = await allowedTypeFilter([...withOperations.values()]);

        return [...matches(withOperations, isAllowed, pattern, isPascalCase)]
            .sort((a, b) => a.match.distance - b.match.distance)
            .map((m): MapOmniboxResult => ({
                resultTypeName: MapOmniboxResultTypeName,
                distance: keywordMatch.match.distance + m.match.distance,
                keywordMatch: keywordMatch.match,
                typeName: cleanTypeName(m.value),
                typeMatch: m.match,
            }));
    }

    getHelp(_ctx: OmniboxContext): HelpOmniboxResult[] {
        return [helpResult(`${MapMessage.Map.niceToString()} ${OmniboxMessage.Omnibox_Type.niceToString()}`, MapOmniboxResultTypeName)];
    }
}
