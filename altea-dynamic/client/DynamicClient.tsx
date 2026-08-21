import { ajaxGet } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { DynamicCSSOverrideEntity } from "../data/DynamicCSSOverride";
import { DynamicSqlMigrationEntity } from "../data/DynamicSqlMigration";

// Port of Signum.Dynamic's DynamicCSSOverrideClient.tsx + the client half of its SqlMigrations, plus the one
// piece Signum does in `Index.cshtml`: injecting the stored stylesheet into the page.
//
// altea divergences, documented inline:
//  - Signum interpolates `DynamicCSSOverrideLogic.Cached` into its server-rendered page. altea has no such
//    page, so `applyCSSOverrides` fetches the concatenated text from an ANONYMOUS endpoint and appends one
//    <style> element. The app calls it at boot (before or after login — the endpoint is anonymous precisely
//    so the login screen is styled too, which is the timing Signum's HTML had).
//  - `EvalClient.Options.registerDynamicPanelSearch` — the registry behind the dynamic panel's search box —
//    is re-homed here, because Signum.Eval does not port. It is kept as a plain registry rather than dropped
//    so the panel (and anything else that wants to search across dynamic definitions) has one place to read.
export namespace DynamicClient {

    export function start(cb: ClientBuilder): void {

        cb.configure(DynamicCSSOverrideEntity)
            .withView(() => import("./CSS/DynamicCSSOverride"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.name),
                    token(a => a.isDisabled),
                ],
            }));

        cb.configure(DynamicSqlMigrationEntity)
            .withView(() => import("./SqlMigrations/DynamicSqlMigration"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.creationDate),
                    token(a => a.createdBy),
                    token(a => a.executionDate),
                    token(a => a.executedBy),
                    token(a => a.comment),
                ],
            }));

        registerDynamicPanelSearch(DynamicCSSOverrideEntity.typeName, [
            { token: "name", type: "Text" },
            { token: "script", type: "Code" },
        ]);

        registerDynamicPanelSearch(DynamicSqlMigrationEntity.typeName, [
            { token: "comment", type: "Text" },
            { token: "script", type: "Code" },
        ]);
    }

    // ---- the panel search registry (Signum's EvalClient.Options.registerDynamicPanelSearch) -------------

    export type DynamicPanelSearchType = "Text" | "Code" | "JSon";

    export interface DynamicPanelSearchColumn {
        token: string;
        type: DynamicPanelSearchType;
    }

    export const registeredPanelSearches: { [typeName: string]: DynamicPanelSearchColumn[] } = {};

    export function registerDynamicPanelSearch(typeName: string, columns: DynamicPanelSearchColumn[]): void {
        registeredPanelSearches[typeName] = columns;
    }

    // ---- the CSS overrides (Signum's Index.cshtml interpolation) ----------------------------------------

    const styleElementId = "sf-dynamic-css-overrides";

    /**
     * Fetch the concatenated stylesheet and append it as ONE <style> element, replacing any previous one.
     * Idempotent, so it can also be called again after a CSS override is saved.
     */
    export async function applyCSSOverrides(): Promise<void> {
        const css = await API.getCSSOverrides();

        document.getElementById(styleElementId)?.remove();

        if (!css)
            return;

        const style = document.createElement("style");
        style.id = styleElementId;
        style.appendChild(document.createTextNode(css));
        document.head.appendChild(style);
    }

    export namespace API {
        export function getCSSOverrides(): Promise<string> {
            return ajaxGet({ url: "/api/dynamic/cssOverrides" });
        }
    }
}
