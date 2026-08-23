import * as React from "react";
import { OmniboxProvider } from "@altea/altea-omnibox/client/OmniboxProvider";
import { HelpModuleOmniboxResultTypeName, type HelpModuleOmniboxResult } from "../data/Help";
import { HelpClient } from "./HelpClient";

// Port of Signum.Help's HelpOmniboxProvider.tsx — renders "help", "help <Type>" and "help 'text'".
//
// altea divergences: the result SHAPE comes from the DATA layer (Signum re-declares it at the bottom of
// this file), and the search suggestion now navigates to a page that EXISTS — see server/HelpSearch.
export default class HelpOmniboxProvider extends OmniboxProvider<HelpModuleOmniboxResult> {

    getProviderName(): string {
        return HelpModuleOmniboxResultTypeName;
    }

    icon(): React.ReactElement {
        return this.coloredIcon("book", "darkviolet");
    }

    renderItem(result: HelpModuleOmniboxResult): React.ReactNode[] {
        const array: React.ReactNode[] = [];

        array.push(this.icon());

        this.renderMatch(result.keywordMatch, array);
        array.push(" ");

        if (result.secondMatch != undefined)
            this.renderMatch(result.secondMatch, array);

        if (result.searchString)
            array.push(`'${result.searchString}'`);

        return array;
    }

    navigateTo(result: HelpModuleOmniboxResult): Promise<string> | undefined {
        if (result.typeName != undefined)
            return Promise.resolve(HelpClient.Urls.typeUrl(result.typeName));

        if (result.searchString != undefined)
            return Promise.resolve(HelpClient.Urls.searchUrl(result.searchString));

        if (result.keywordMatch == undefined)
            return undefined;

        return Promise.resolve(HelpClient.Urls.indexUrl());
    }

    toString(result: HelpModuleOmniboxResult): string {
        if (result.secondMatch)
            return `${result.keywordMatch.text} ${result.secondMatch.text}`;

        if (result.searchString)
            return `${result.keywordMatch.text} "${result.searchString}"`;

        return result.keywordMatch.text;
    }
}
