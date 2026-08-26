import * as React from "react";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { QuickLinkClient, QuickLinkLink } from "@altea/altea/client/QuickLinkClient";
import type { Lite } from "@altea/altea/data/lite";
import * as AppContext from "@altea/altea/client/AppContext";

// altea-whats-new's slice of the per-user client state — see the note on Navigator's entitySettings.
declare module "@altea/altea/client/AppContext" {
    interface IClientState {
        whatsNewConfigs?: { [typeName: string]: any[] };
    }
}
import {
    WhatsNewEntity, WhatsNewLogEntity, WhatsNewMessage,
    type NumWhatsNews, type WhatsNewFull, type WhatsNewShort,
} from "../data/WhatsNew";

// Port of Signum.WhatsNew's WhatsNewClient.tsx — the two pages, the entity view, the "Preview" quick link
// and the typed HTTP client.
//
// altea divergences:
//  - `Navigator.addSettings(new EntitySettings(T, view, { modalSize: "xl" }))` → `cb.configure(T).withView(…)`.
//    altea's EntityClientBuilder has no `modalSize`, and the news item is edited on its own page anyway.
//  - `ChangeLogClient.registerChangeLogModule` is not ported (altea has no per-module changelog registry),
//    so Signum's `Changelog.ts` — two lines about fixing this very dropdown — goes with it.
//  - Signum's `replacePlaceHolders` / `getPropertyValue` helpers are declared INSIDE `start` and never
//    called by anything, so they are not ported either.
//  - `WhatsNewConfig` / `registerConfig` ARE ported: the entity view reads them for the icon of a `Related`
//    type an app has taught it about.
export namespace WhatsNewClient {

    export function start(cb: ClientBuilder): void {

        cb.routes.push(
            { path: "/news", element: <ImportComponent onImport={() => import("./Templates/AllNewsPage")} /> },
            { path: "/newspage/:newsId", element: <ImportComponent onImport={() => import("./Templates/NewsPage")} /> },
        );

        cb.configure(WhatsNewEntity)
            .withView(() => import("./Templates/WhatsNew"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(w => w.id),
                    token(w => w.status),
                    token(w => w.name),
                    token(w => w.creationDate),
                    token(w => w.related),
                ],
            }));

        cb.configure(WhatsNewLogEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(l => l.id),
                    token(l => l.readOn),
                    token(l => l.user),
                    token(l => l.whatsNew),
                ],
            }));

        QuickLinkClient.registerQuickLink(WhatsNewEntity, new QuickLinkLink("Preview",
            () => WhatsNewMessage.Preview.niceToString(),
            ctx => "/newspage/" + ctx.lite.id,
            { icon: "newspaper", iconColor: "purple" }));
    }

    export namespace API {
        export function myNews(): Promise<WhatsNewShort[]> {
            return ajaxGet({ url: "/api/whatsnew/myNews", avoidNotifyPendingRequests: true });
        }

        export function myNewsCount(): Promise<NumWhatsNews> {
            return ajaxGet({ url: "/api/whatsnew/myNewsCount", avoidNotifyPendingRequests: true });
        }

        export function getAllNews(): Promise<WhatsNewFull[]> {
            return ajaxGet({ url: "/api/whatsnew/all" });
        }

        export function newsPage(id: number | string): Promise<WhatsNewFull> {
            return ajaxGet({ url: "/api/whatsnew/" + id });
        }

        export function setNewsLogRead(lites: Lite<WhatsNewEntity>[]): Promise<void> {
            return ajaxPost({ url: "/api/whatsnew/setNewsLog" }, lites);
        }
    }

    export interface IconColor {
        icon: string | [string, string];
        iconColor: string;
    }

    /**
     * Signum's `WhatsNewConfig<T>` — how a `Related` type of an app's own shows up in the type picker. The
     * four framework types (Type / Query / Operation / Permission) have hard-coded icons in the view; this is
     * how an app adds its own.
     */
    export abstract class WhatsNewConfig<T> {
        constructor(public readonly typeName: string) { }
        abstract getDefaultIcon(): IconColor;
    }

    // In `AppContext.clientState` rather than a module-level dictionary (see the note on Navigator's
    // entitySettings): the values are ARRAYS that `registerConfig` pushes onto from a module's `start()`.
    export function configs(): { [typeName: string]: WhatsNewConfig<unknown>[] } {
        return AppContext.clientState.whatsNewConfigs ??= {};
    }

    export function registerConfig(config: WhatsNewConfig<unknown>): void {
        const cs = configs();
        (cs[config.typeName] ??= []).push(config);
    }
}
