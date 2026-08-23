import * as React from "react";
import { OmniboxProvider } from "@altea/altea-omnibox/client/OmniboxProvider";
import { TreeOmniboxResultTypeName, type TreeOmniboxResult } from "../data/Tree";

// Port of Signum.Tree's TreeOmniboxProvider.tsx.
// ALTEA: the result SHAPE is declared once in `data/Tree.ts` (Signum declares it a second time here, at the
// bottom of the file, so its two copies can drift).
export default class TreeOmniboxProvider extends OmniboxProvider<TreeOmniboxResult> {

    override getProviderName(): string {
        return TreeOmniboxResultTypeName;
    }

    override icon(): React.ReactElement {
        return this.coloredIcon("sitemap", "gold");
    }

    override renderItem(result: TreeOmniboxResult): React.ReactNode[] {
        const array: React.ReactNode[] = [this.icon()];
        this.renderMatch(result.typeMatch, array);
        return array;
    }

    override navigateTo(result: TreeOmniboxResult): Promise<string> {
        return Promise.resolve("/tree/" + result.type);
    }

    override toString(result: TreeOmniboxResult): string {
        return result.typeMatch.text;
    }
}
