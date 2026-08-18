import * as React from "react";
import type { SpecialOmniboxResult } from "../data/OmniboxResults";
import { OmniboxResultTypeName } from "../data/OmniboxResults";
import { OmniboxProvider } from "./OmniboxProvider";
import { specialActions } from "./OmniboxSpecialAction";

// Port of Signum's `SpecialOmniboxProvider` (Signum.Omnibox/SpecialOmniboxProvider.tsx): the "!Command"
// rows. Navigation runs the registered action's own onClick — the "url" it resolves to (if any) is then
// pushed by the autocomplete.
export default class SpecialOmniboxProvider extends OmniboxProvider<SpecialOmniboxResult> {

    getProviderName(): string {
        return OmniboxResultTypeName.Special;
    }

    icon(): React.ReactElement {
        return this.coloredIcon("cog", "limegreen");
    }

    renderItem(result: SpecialOmniboxResult): React.ReactNode[] {

        const array: React.ReactNode[] = [];

        array.push(this.icon());

        array.push("!");

        this.renderMatch(result.match, array);

        return array;
    }

    navigateTo(result: SpecialOmniboxResult): Promise<string | undefined> {
        return specialActions[result.key].onClick();
    }

    toString(result: SpecialOmniboxResult): string {
        return "!" + result.key;
    }
}
