import { getTypeInfo } from "@altea/altea/data/reflection";
import { Implementations } from "@altea/altea/data/implementations";
import type { PrimaryKey } from "@altea/altea/data/entity";
import type {
    EntityOmniboxResult, HelpOmniboxResult, OmniboxResult,
} from "../data/OmniboxResults";
import { OmniboxResultTypeName } from "../data/OmniboxResults";
import { OmniboxMessage } from "../data/OmniboxMessages";
import {
    OmniboxParser, OmniboxTokenType, helpResult,
    type OmniboxContext, type OmniboxResultGenerator, type OmniboxToken,
} from "./OmniboxParser";
import { contains, cleanCommas, isPascalCasePattern, matches, toOmniboxPascal } from "./OmniboxUtils";
import { allowedTypeFilter } from "./OmniboxAuth";

// Port of Signum's `EntityOmniboxResultGenenerator` (Signum.Omnibox/EntityOmniboxResultGenerator.cs):
// jump straight to ONE entity, either by id (`Order 5`, `Customer 0f8f…`) or by ToString
// (`Customer "Maria"`). The bare type name alone yields nothing — that shape belongs to the dynamic-query
// generator, which offers the SEARCH for the type instead.

// `^I` + optionally a number/guid (an id) or a string (a ToString pattern). ALTEA: C#'s duplicate `id`
// capture group (`(?<id>N)|(?<id>G)`) is illegal in JS — merged into one `[NG]` class.
const REGEX = /^I(?:(?<id>[NG])|(?<toStr>S))?$/;

export class EntityOmniboxResultGenerator implements OmniboxResultGenerator {

    autoCompleteLimit = 5;

    async getResults(rawQuery: string, tokens: OmniboxToken[], tokenPattern: string, _ctx: OmniboxContext): Promise<OmniboxResult[]> {
        if (!REGEX.test(tokenPattern))
            return [];

        // A lone type name is ambiguous with "open the search for this type" — the dynamic-query
        // generator owns that, so bail before touching the database.
        if (tokens.length === 1)
            return [];

        const ident = tokens[0].value;
        const isPascalCase = isPascalCasePattern(ident);

        // Signum filtered inline with `Schema.Current.IsAllowed(type, inUserInterface: true) == null`;
        // altea's type authorization is async, so the allowed set is resolved UP FRONT and the (sync)
        // matcher filters against it.
        const isAllowed = await allowedTypeFilter([...OmniboxParser.manager.types().values()]);

        const typeMatches = [...matches(OmniboxParser.manager.types(), isAllowed, ident, isPascalCase)]
            .sort((a, b) => a.match.distance - b.match.distance);

        const result: EntityOmniboxResult[] = [];

        if (tokens[1].type === OmniboxTokenType.Number || tokens[1].type === OmniboxTokenType.Guid) {
            for (const m of typeMatches) {
                const type = m.value;
                const id = tryParsePrimaryKey(type, tokens[1].value);
                if (id == undefined)
                    continue;

                const lite = await OmniboxParser.manager.tryRetrieveLite(type, id);

                result.push({
                    resultTypeName: OmniboxResultTypeName.Entity,
                    distance: m.match.distance,
                    typeMatch: m.match,
                    id,
                    lite,
                });
            }
        } else if (tokens[1].type === OmniboxTokenType.String) {
            const pattern = cleanCommas(tokens[1].value);

            for (const m of typeMatches) {
                const type = m.value;
                const autoComplete = await OmniboxParser.manager.autocomplete(Implementations.by(type), pattern, this.autoCompleteLimit);

                if (autoComplete.length > 0) {
                    for (const lite of autoComplete) {
                        const distance = contains(lite, lite.toString() ?? "", pattern);

                        if (distance != undefined)
                            result.push({
                                resultTypeName: OmniboxResultTypeName.Entity,
                                distance: m.match.distance + distance.match.distance,
                                typeMatch: m.match,
                                toStr: pattern,
                                toStrMatch: distance.match,
                                lite,
                            });
                    }
                } else {
                    // Nothing found: still offer the row (+100 so it sinks) so the user sees "[Not found]"
                    // rather than the suggestion silently vanishing.
                    result.push({
                        resultTypeName: OmniboxResultTypeName.Entity,
                        distance: m.match.distance + 100,
                        typeMatch: m.match,
                        toStr: pattern,
                    });
                }
            }
        }

        return result;
    }

    getHelp(_ctx: OmniboxContext): HelpOmniboxResult[] {
        const entityTypeName = OmniboxMessage.Omnibox_Type.niceToString();

        return [
            helpResult(`${entityTypeName} Id`, OmniboxResultTypeName.Entity),
            helpResult(`${entityTypeName} 'ToStr'`, OmniboxResultTypeName.Entity),
        ];
    }
}

// Signum's `PrimaryKey.TryParse(value, type, out id)`: coerce the raw token to the type's PK form, or
// undefined when it can't possibly be one (a guid typed at an int-keyed table, and vice versa).
export function tryParsePrimaryKey(type: Function, value: string): PrimaryKey | undefined {
    const pk = getTypeInfo(type)?.fields["id"]?.columnOptions?.primaryKey ?? "int";

    if (pk === "uuid" || pk === "uuid7")
        return /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/i.test(value) ? value : undefined;

    return /^-?\d+$/.test(value) ? Number(value) : undefined;
}

// Signum's `Type.NicePluralName().ToOmniboxPascal()` — the display form the client echoes back into the
// input on [Tab] (see EntityOmniboxProvider.toString). Exported for the dynamic-query generator too.
export function niceOmniboxPluralName(type: Function): string {
    return toOmniboxPascal(type.nicePluralName());
}
