import * as React from "react";
import * as AppContext from "@altea/altea/client/AppContext";
import { addContextHeaders } from "@altea/altea/client/Services";
import { ajaxGet } from "@altea/altea/client/Services";
import { onWidgets, type WidgetContext } from "@altea/altea/client/Frames/Widgets";
import type { BaseEntity } from "@altea/altea/data/entity";
import { cleanTypeName } from "@altea/altea/data/registration";
import { Metadata } from "@altea/altea/data/metadata";
import { Lite } from "@altea/altea/data/lite";
import { registerColorProviders } from "@altea/altea-map/client/Schema/ClientColorProvider";
import { IsolationEntity } from "../data/Isolation";
import { IsolationWidget } from "./IsolationWidget";

// Port of Signum.Isolation's IsolationClient.tsx — the browser half: remember which isolation the user is
// working in, send it on every call, show it on an open entity, and colour the schema map by strategy.
//
// altea divergences:
//  - the picked isolation still lives in `sessionStorage` under Signum's own key, so a second tab can work
//    in a different tenant — that is deliberate in Signum and kept.
//  - the header name is Signum's `Signum_Isolation` verbatim: it is a wire contract, and a database moved
//    from a Signum app keeps working against the same client.
//  - `IsolationEntity.tryTypeInfo()` (the guard that hides the widget when the module is not installed
//    server-side) becomes a check for registered metadata — altea's client learns which types exist from
//    the reflection blob.
export namespace IsolationClient {

    export function start(): void {

        onWidgets().push(getIsolationWidget);

        addContextHeaders().push(options => {
            const overriden = getOverridenIsolation();
            if (overriden != undefined) {
                options.headers = {
                    ...options.headers,
                    "Signum_Isolation": overriden.key(),
                };
            }
        });

        registerColorProviders(() => import("./IsolationColorProvider").then(c => c.default()));
    }

    export const Options = {
        /**
         * Signum's `Options.onIsolationChange` — a host hook that can take over the change (e.g. to warn
         * about unsaved work). Return true to say "handled, do nothing more".
         */
        onIsolationChange: null as ((e: React.MouseEvent, isolation: Lite<IsolationEntity> | undefined) => boolean) | null,
    };

    /**
     * Signum's `changeOverridenIsolation` — remember the pick and RELOAD the UI. `resetUI` is what makes
     * every open search page and every cached entity re-fetch under the new isolation; nothing is valid
     * across the switch.
     */
    export function changeOverridenIsolation(e: React.MouseEvent, isolation: Lite<IsolationEntity> | undefined): void {
        if (Options.onIsolationChange && Options.onIsolationChange(e, isolation))
            return;

        if (isolation)
            sessionStorage.setItem(sessionKey, isolation.key());
        else
            sessionStorage.removeItem(sessionKey);

        AppContext.resetUI();
    }

    /** Signum's `'Curr_Isolation'` sessionStorage key. */
    const sessionKey = "Curr_Isolation";

    /**
     * ALTEA: Signum stores the whole Lite as JSON and parses it back. A Lite's `entityType` is a
     * CONSTRUCTOR here, which `JSON.stringify` silently drops — the same trap the NDJSON operation routes
     * hit — so the stored form is the lite KEY (`Isolation;3`) and `Lite.parse` rebuilds it. That is also
     * exactly what the request header carries, so there is one representation rather than two.
     */
    export function getOverridenIsolation(): Lite<IsolationEntity> | undefined {
        const value = sessionStorage.getItem(sessionKey);
        if (value == null || !isInstalled())
            return undefined;
        try {
            return Lite.parse(value) as Lite<IsolationEntity>;
        } catch {
            sessionStorage.removeItem(sessionKey); // a stale key from a database that no longer has it
            return undefined;
        }
    }

    /** False when the server does not have the module installed — the widget and the picker stand down. */
    export function isInstalled(): boolean {
        return Metadata.tryType(cleanTypeName(IsolationEntity)) != undefined;
    }

    export function getIsolationWidget(ctx: WidgetContext<BaseEntity>): React.ReactElement | undefined {
        return isInstalled() ? <IsolationWidget wc={ctx} /> : undefined;
    }

    export namespace API {
        export function isolations(): Promise<Lite<IsolationEntity>[]> {
            return ajaxGet({ url: "/api/isolations" });
        }
    }
}
