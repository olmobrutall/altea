import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import {
    QueryRequest, Column, Order, OrderType, FilterCondition, FilterOperation, Pagination,
} from "@altea/altea/server/dynamicQuery/requests";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { resolveCleanType } from "@altea/altea/data/registration";
import { getKey } from "@altea/altea/data/dynamicQuery/queryUtils";
import type { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { SkillCode, Schema as S } from "../SkillCode";

// Port of Signum.Agent's Skills/AutocompleteSkill.cs — "find me the entity called X", so a filter can use a
// real `Lite<T>` instead of a name.
//
// THE divergence: Signum calls `AutocompleteUtils.FindLiteLikeAsync(Implementations.By(types), subString,
// 5)`, a server helper altea does not have — altea's autocomplete is built CLIENT-side, by
// `Lines/AutoCompleteConfig.getLitesWithSubStr` composing an ordinary query request. So the same request is
// composed here, with the same shape that helper uses: filter `ToString` Contains each word, order by
// `ToString.length` then `ToString`, take the first N. One query per requested type, as
// `Implementations.By(types)` implies.
export class AutocompleteSkill extends SkillCode {

    constructor() {
        super();

        this.shortDescription = "Finds entities by name";
        this.isAllowed = () => true;

        this.registerTool({
            name: "AutoCompleteLite",
            description: "Returns the lites (entities) of some type that contain subString",
            returnType: "Lite<Entity>[]",
            parameters: S.args({
                typeName: S.string("One clean type name, or several separated by commas"),
                subString: S.string("Words that must all appear in the entity's ToString, in any order"),
            }),
            invoke: async args => {
                const typeNames = String(args["typeName"]).split(",").map(t => t.trim()).filter(t => t !== "");
                const subString = String(args["subString"] ?? "");

                const result: Lite<Entity>[] = [];
                for (const typeName of typeNames)
                    result.push(...await findLiteLike(typeName, subString, 5));

                return result;
            },
        });
    }
}

/** One type's worth of "ToString contains every word", newest-shortest first. */
export async function findLiteLike(typeName: string, subString: string, count: number): Promise<Lite<Entity>[]> {
    const ctor = resolveCleanType(typeName);
    if (ctor == undefined) {
        // Signum's AddTypeNameHint, inline: name the near misses rather than just failing.
        const similar = QueryLogic.queries.getQueryNames().map(qn => getKey(qn))
            .filter(k => k.toLowerCase().includes(typeName.toLowerCase()))
            .slice(0, 5);
        throw new Error(`Type '${typeName}' not found.`
            + (similar.length > 0 ? ` Similar type names: ${similar.join(", ")}` : ""));
    }

    const queryName = ctor as unknown as Parameters<typeof QueryLogic.getToken>[0];
    const token = (s: string): ReturnType<typeof QueryLogic.getToken> => QueryLogic.getToken(queryName, s, SubTokensOptionsAll);

    const toString = token("ToString");
    const words = subString.split(/\s+/).filter(w => w !== "");

    const request = new QueryRequest(
        queryName,
        words.map(w => new FilterCondition(toString, FilterOperation.Contains, w)),
        [new Order(token("ToString.length"), OrderType.Ascending), new Order(toString, OrderType.Ascending)],
        [new Column(token("id"), undefined)],
        new Pagination.Firsts(count),
        false,
    );

    const rt = await QueryLogic.queries.executeQueryAsync(request);
    return rt.rows.map(r => r.entity).filter((e): e is Lite<Entity> => e != undefined);
}
