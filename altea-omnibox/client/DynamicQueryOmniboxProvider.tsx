import * as React from "react";
import { Finder } from "@altea/altea/client/Finder";
import type { FindOptions } from "@altea/altea/client/FindOptions";
import type { DynamicQueryOmniboxResult } from "../data/OmniboxResults";
import { OmniboxResultTypeName, UnknownOmniboxValue } from "../data/OmniboxResults";
import { OmniboxMessage } from "../data/OmniboxMessages";
import { OmniboxProvider } from "./OmniboxProvider";

// Port of Signum's `DynamicQueryOmniboxProvider` (Signum.Omnibox/DynamicQueryOmniboxProvider.tsx):
// renders "<Query> <Token><op><Value> …" rows and, on Enter, opens the search page with those filters
// already applied.
//
// ALTEA: `f.queryToken` is the token's fullKey STRING (Signum shipped a whole QueryTokenTS DTO and read
// only `.fullKey`) — see data/OmniboxResults.
export default class DynamicQueryOmniboxProvider extends OmniboxProvider<DynamicQueryOmniboxResult> {

    getProviderName(): string {
        return OmniboxResultTypeName.DynamicQuery;
    }

    icon(): React.ReactElement {
        return this.coloredIcon("search", "orange");
    }

    renderItem(result: DynamicQueryOmniboxResult): React.ReactNode[] {

        const array: React.ReactNode[] = [];

        array.push(this.icon());

        this.renderMatch(result.queryNameMatch, array);

        result.filters.forEach(f => {
            array.push(<span> </span>);

            if (f.queryTokenMatches)
                f.queryTokenMatches.forEach((m, i) => {
                    if (i != 0)
                        array.push(<span>.</span>);
                    this.renderMatch(m, array);
                });

            const shown = f.queryTokenMatches?.map(a => a.text).join(".");

            // The suggestion goes DEEPER than what the user typed (a sub-token was offered): render the
            // extra segment in gray so the completion is visible.
            if (shown == null || (shown != f.queryTokenOmniboxPascal && shown != f.queryTokenOmniboxPascal.tryAfterLast("."))) {
                if (f.queryTokenMatches && f.queryTokenMatches.length > 0)
                    array.push(<span>.</span>);

                array.push(this.coloredSpan(f.queryTokenOmniboxPascal.tryAfterLast(".") ?? f.queryTokenOmniboxPascal, "gray"));
            }

            if (f.canFilter && f.canFilter.length)
                array.push(this.coloredSpan(f.canFilter, "red"));
            else if (f.operation != undefined) {

                array.push(<strong>{f.operationToString}</strong>);

                if (f.value == UnknownOmniboxValue)
                    array.push(this.coloredSpan(OmniboxMessage.Unknown.niceToString(), "red"));
                else if (f.valueMatch != undefined)
                    this.renderMatch(f.valueMatch, array);
                else if (f.syntax != undefined && f.syntax.completion == "Complete")
                    array.push(<b>{f.valueToString}</b>);
                else
                    array.push(this.coloredSpan(f.valueToString, "gray"));
            }
        });

        return array;
    }

    navigateTo(result: DynamicQueryOmniboxResult): Promise<string> {

        const fo: FindOptions = {
            queryName: result.queryName,
            filterOptions: [],
        };

        result.filters.forEach(f => {
            fo.filterOptions!.push({
                token: f.queryToken,
                operation: f.operation,
                value: f.value,
            });
        });

        return Promise.resolve(Finder.findOptionsPath(fo));
    }

    toString(result: DynamicQueryOmniboxResult): string {
        const queryName = result.queryNameMatch.text;

        const filters = result.filters.map(f => {

            const token = f.queryTokenOmniboxPascal;

            if (f.syntax == undefined || f.syntax.completion == "Token" || (f.canFilter && f.canFilter.length > 1))
                return token;

            const oper = f.operationToString;

            if ((f.syntax.completion == "Operation" && f.value == undefined) || f.value == UnknownOmniboxValue)
                return token + oper;

            return token + oper + f.valueToString;
        }).join(" ");

        return filters.length ? queryName + " " + filters : queryName;
    }
}
