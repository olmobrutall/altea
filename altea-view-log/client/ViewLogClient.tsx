import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Finder } from "@altea/altea/client/Finder";
import { QuickLinkClient, QuickLinkExplore } from "@altea/altea/client/QuickLinkClient";
import { getQueryKey, getTypeInfo } from "@altea/altea/client/Reflection";
import { ViewLogEntity } from "../data/ViewLog";

// Port of Signum.ViewLog's ViewLogClient.tsx — one global quick link: on any entity, "who has looked at
// this?", opening the ViewLog query filtered to it.
//
// altea divergences:
//  - `registerChangeLogModule` has no counterpart (altea has no per-module changelog registry), so
//    Signum's `Changelog.ts` — an empty dictionary in the source — is not ported.
//  - the query's default columns are registered here, which Signum gets from its `WithQuery` projection on
//    the server; altea's `withQuery()` is parameterless and the client owns the column list.
export namespace ViewLogClient {

    export function start(cb: ClientBuilder, options?: { showQuickLink?: (typeName: string) => boolean }): void {

        cb.configure(ViewLogEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.target),
                    token(a => a.viewAction),
                    token(a => a.user),
                    token(a => a.startDate),
                    token(a => a.endDate),
                ],
            }));

        // Signum guards the whole registration on `Finder.isFindable(ViewLogEntity, false)`. Here the guard
        // is INSIDE `isVisible`, evaluated per type: `start` runs before the metadata blob has been applied,
        // so asking about findability at registration time would answer for the wrong role (the same reason
        // core's operation-log quick link puts its `isFindable` check in `isVisible`).
        QuickLinkClient.registerGlobalQuickLink(entityType => Promise.resolve([
            new QuickLinkExplore(ViewLogEntity, ctx => ViewLogEntity.findOptions(token => ({
                filterOptions: [token(e => e.target).filter("EqualTo", ctx.lite)],
            })), {
                key: getQueryKey(ViewLogEntity),
                text: () => getTypeInfo(ViewLogEntity).getNicePluralName(),
                isVisible: (options?.showQuickLink?.(entityType) ?? true) && Finder.isFindable(ViewLogEntity, false),
                icon: "eye",
                iconColor: "#2E86C1",
            }),
        ]));
    }
}
