import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Finder } from "@altea/altea/client/Finder";
import { QuickLinkClient, QuickLinkExplore } from "@altea/altea/client/QuickLinkClient";
import { getQueryKey, getTypeInfo } from "@altea/altea/client/Reflection";
import { ViewLogEntity } from "../data/ViewLog";

// One global quick link: on any entity, "who has looked at this?", opening the ViewLog query filtered to
// it. The default columns are registered here because `withQuery()` is parameterless — the client owns the
// column list.
//
// Port of Signum.ViewLog's ViewLogClient.tsx — see port/ViewLog.md.
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

        // The findability guard is INSIDE `isVisible`, evaluated per type: `start` runs before the metadata
        // blob has been applied, so asking at registration time would answer for the wrong role (the same
        // reason core's operation-log quick link puts its `isFindable` check in `isVisible`).
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
