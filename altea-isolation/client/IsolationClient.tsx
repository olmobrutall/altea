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

// The browser half: remember which isolation the user is working in, send it on every call, show it on an
// open entity, and colour the schema map by strategy.
//
// The picked isolation lives in `sessionStorage`, so a second tab can work in a different tenant. The
// header name is a WIRE CONTRACT and is kept verbatim.
//
// See docs/port/Isolation.md.
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
         * A host hook that can take over the change (e.g. to warn
         * about unsaved work). Return true to say "handled, do nothing more".
         */
        onIsolationChange: null as ((e: React.MouseEvent, isolation: Lite<IsolationEntity> | undefined) => boolean) | null,
    };

    /**
     * Remember the pick and RELOAD the UI. `resetUI` is what makes
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

    /** The sessionStorage key — a WIRE CONTRACT, kept verbatim. */
    const sessionKey = "Curr_Isolation";

    /**
     * The lite is stored as its KEY, not as JSON: a Lite's `entityType` is a
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
