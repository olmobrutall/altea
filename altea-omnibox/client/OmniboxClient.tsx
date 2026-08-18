import * as React from "react";
import { Dic } from "@altea/altea/data/globals";
import { ajaxPost } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import type { HelpOmniboxResult, OmniboxResult } from "../data/OmniboxResults";
import { OmniboxResultTypeName } from "../data/OmniboxResults";
import DynamicQueryOmniboxProvider from "./DynamicQueryOmniboxProvider";
import EntityOmniboxProvider from "./EntityOmniboxProvider";
import SpecialOmniboxProvider from "./SpecialOmniboxProvider";
import { OmniboxProvider } from "./OmniboxProvider";
import { allowedSpecialActionKeys } from "./OmniboxSpecialAction";

// Port of Signum's `OmniboxClient` (Signum.Omnibox/OmniboxClient.tsx): the PROVIDER REGISTRY (result-type
// name → renderer) plus the one API call. The omnibox itself is the <OmniboxAutocomplete/> component.
//
// altea divergences:
//  - `start()` takes a ClientBuilder, like every other altea client module (Signum's took no argument).
//    It registers no routes — the omnibox is a navbar widget, not a page — so `cb` is only there for
//    symmetry and future use.
//  - Signum's `ChangeLogClient.registerChangeLogModule` and `AppContext.clearSettingsActions.push(
//    clearProviders)` are dropped: altea has neither (module state resets via AppContext.newClientState;
//    see the notes in Finder/Navigator/QuickLinkClient). `clearProviders` stays exported.
export namespace OmniboxClient {

    export function start(_cb: ClientBuilder): void {
        registerProvider(new EntityOmniboxProvider());
        registerProvider(new DynamicQueryOmniboxProvider());
        registerProvider(new SpecialOmniboxProvider());
    }

    export const providers: { [resultTypeName: string]: OmniboxProvider<OmniboxResult> } = {};

    export function clearProviders(): void {
        Dic.clear(providers);
    }

    export function registerProvider(prov: OmniboxProvider<any>): void {
        if (providers[prov.getProviderName()])
            throw new Error(`Provider '${prov.getProviderName()}' already registered`);

        providers[prov.getProviderName()] = prov;
    }

    export function renderItem(result: OmniboxResult): React.ReactNode {
        const items = result.resultTypeName == OmniboxResultTypeName.Help ?
            renderHelpItem(result as HelpOmniboxResult) :
            getProvider(result.resultTypeName).renderItem(result);
        // The providers build bare (key-less) element arrays, exactly as in Signum; wrapping each in a
        // keyed Fragment keeps React quiet without touching the DOM they render.
        return <span>{items.map((n, i) => <React.Fragment key={i}>{n}</React.Fragment>)}</span>;
    }

    // The syntax-guide rows returned for an empty query. `(…)` marks the characters a pattern would
    // match, so they are rendered bold — Signum did the same with a `dangerouslySetInnerHTML` replace;
    // altea splits the text instead, so no HTML from the server is ever injected.
    function renderHelpItem(help: HelpOmniboxResult): React.ReactNode[] {

        const result: React.ReactNode[] = [];

        if (help.referencedTypeName)
            result.push(getProvider(help.referencedTypeName).icon());

        const parts = help.text.split(/[()]/).map((s, i) => i % 2 == 1 ? <strong key={i}>{s}</strong> : <React.Fragment key={i}>{s}</React.Fragment>);

        result.push(<span style={help.isMainTitle ? { fontWeight: "bold" } : { fontStyle: "italic" }}>{parts}</span>);

        return result;
    }

    export function navigateTo(result: OmniboxResult): Promise<string | undefined> | undefined {

        if (result.resultTypeName == OmniboxResultTypeName.Help)
            return undefined;

        return getProvider(result.resultTypeName).navigateTo(result);
    }

    export function toString(result: OmniboxResult): string {
        return getProvider(result.resultTypeName).toString(result);
    }

    function getProvider(resultTypeName: string): OmniboxProvider<OmniboxResult> {
        const prov = providers[resultTypeName];

        if (!prov)
            throw new Error(`No provider for '${resultTypeName}'`);

        return prov;
    }

    export namespace API {

        export function getResults(query: string, signal: AbortSignal): Promise<OmniboxResult[]> {
            return ajaxPost({ url: "/api/omnibox", signal }, {
                query: query ?? "",
                // The special actions are CLIENT-side commands; the server can only match what we send.
                specialActions: allowedSpecialActionKeys(),
            });
        }
    }
}
