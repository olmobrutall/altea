import * as React from "react";
import { OmniboxProvider } from "@altea/altea-omnibox/client/OmniboxProvider";
import { MapOmniboxResultTypeName, type MapOmniboxResult } from "../data/Map";

// Port of Signum.Map's MapOmniboxProvider.tsx — renders the "Map" / "Map <Type>" suggestion.
//
// altea divergences:
//  - The result SHAPE comes from the DATA layer rather than being re-declared by hand here (Signum
//    declares it a third time, at the bottom of this file) — the same call altea-omnibox makes.
//  - `MapOmniboxResultTypeName` is the shared constant, so neither tier spells the discriminator inline.
//  - The route is `/map`, lower-case — Signum navigates to `/Map`, which its own registration
//    (`path: "/map"`) only matches because react-router's default is case-insensitive.
export default class MapOmniboxProvider extends OmniboxProvider<MapOmniboxResult> {

    getProviderName(): string {
        return MapOmniboxResultTypeName;
    }

    icon(): React.ReactElement {
        return this.coloredIcon("map", "green");
    }

    renderItem(result: MapOmniboxResult): React.ReactNode[] {

        const array: React.ReactNode[] = [];

        array.push(this.icon());

        this.renderMatch(result.keywordMatch, array);
        array.push(" ");

        if (result.typeMatch != undefined)
            this.renderMatch(result.typeMatch, array);

        return array;
    }

    navigateTo(result: MapOmniboxResult): Promise<string> | undefined {

        if (result.keywordMatch == undefined)
            return undefined;

        return Promise.resolve("/map" + (result.typeName ? "/" + result.typeName : ""));
    }

    toString(result: MapOmniboxResult): string {
        if (result.typeMatch == undefined)
            return result.keywordMatch.text;

        return `${result.keywordMatch.text} ${result.typeMatch.text}`;
    }
}
