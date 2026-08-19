import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import {
    FilterCondition, FilterGroup, FilterOperation, FilterGroupOperation, type Filter,
} from "@altea/altea/server/dynamicQuery/requests";
import { SubTokensOptionsAll, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { Enum } from "@altea/altea/data/enum";
import { FilterOperationEnum, FilterGroupOperationEnum } from "@altea/altea/data/dynamicQueries";
import { Entity } from "@altea/altea/data/entity";
import type { QueryFilterBaseEntity } from "../data/Queries";
import { parseFilterValue } from "../data/FilterValueString";

// Port of Signum's UserAssets `QueryFilterUtils.ToFilterList` (Signum.UserAssets/Queries/QueryFilterUtils.cs)
// — turn the FLAT, indentation-encoded rows of a stored filter tree into the engine's nested Filter list.
//
// altea divergences, documented inline:
//  - The rows are the shared `QueryFilterBaseEntity` (see @altea/altea-user-assets), so this works for ANY
//    owner's filter rows — a template's, a user query's, a chart's.
//  - A stored enum field is an ORDINAL in memory and a member NAME on the wire; the engine's FilterOperation
//    / FilterGroupOperation are string enums, so each is converted through `Enum.toName`.
//  - `valueString` → a typed value with the client-side `parseFilterValue` (the same converter the
//    SearchControl uses), keyed off the token's FilterType.
//  - Lives in altea-user-assets, matching Signum (Signum.UserAssets/Queries/QueryFilterUtils.cs). It was
//    parked in altea-email while that was the only server consumer; @altea/altea-office-template is the
//    second, so it moved here — every owner of QueryFilterBaseEntity rows shares one converter.

export namespace QueryFilterUtils {

    /** Signum's ToFilterList — the stored rows, nested by `indentation`. */
    export function toFilterList(queryName: QueryName, rows: readonly QueryFilterBaseEntity[]): Filter[] {
        const ordered = [...rows].sort((a, b) => (a.order as number) - (b.order as number));
        const [filters] = build(queryName, ordered, 0, 0);
        return filters;
    }

    /** Consume every row at `indentation` (and its deeper children) starting at `index`. */
    function build(queryName: QueryName, rows: readonly QueryFilterBaseEntity[], index: number, indentation: number): [Filter[], number] {
        const result: Filter[] = [];

        let i = index;
        while (i < rows.length && (rows[i].indentation as number) >= indentation) {
            const row = rows[i];

            // A row nested DEEPER than expected without a group header above it is malformed; treat it as
            // belonging to this level rather than losing it.
            if (row.isGroup) {
                const [children, next] = build(queryName, rows, i + 1, (row.indentation as number) + 1);
                result.push(new FilterGroup(
                    groupOperation(row.groupOperation),
                    row.token == null ? undefined : token(queryName, row.token.tokenString),
                    children));
                i = next;
                continue;
            }

            if (row.token != null && row.operation != null) {
                const t = token(queryName, row.token.tokenString);
                const op = operation(row.operation);
                result.push(new FilterCondition(t, op, value(t, op, row.valueString)));
            }
            i++;
        }

        return [result, i];
    }

    function token(queryName: QueryName, tokenString: string): QueryToken {
        return QueryLogic.getToken(queryName, tokenString, SubTokensOptionsAll);
    }

    function operation(ordinal: FilterOperationEnum): FilterOperation {
        return Enum.toName(FilterOperationEnum, ordinal) as FilterOperation;
    }

    function groupOperation(ordinal: FilterGroupOperationEnum | null): FilterGroupOperation {
        return (ordinal == null ? "And" : Enum.toName(FilterGroupOperationEnum, ordinal)) as FilterGroupOperation;
    }

    /** The stored `valueString` as the token's own type. A list operation splits on `|` (Signum's convention). */
    function value(t: QueryToken, op: FilterOperation, valueString: string | null): unknown {
        if (valueString == null || valueString === "")
            return null;

        if (op === FilterOperation.IsIn || op === FilterOperation.IsNotIn)
            return valueString.split("|").map(v => parseFilterValue(v.trim(), t.filterType));

        return parseFilterValue(valueString, t.filterType);
    }

    /** The "this row's entity" filter every single-entity render starts from (Signum's
     *  `new FilterCondition(QueryUtils.Parse("Entity", qd, 0), EqualTo, entity.ToLite())`). */
    export function entityFilter(queryName: QueryName, entity: Entity): Filter {
        return new FilterCondition(token(queryName, ""), FilterOperation.EqualTo, entity.toLite());
    }
}
