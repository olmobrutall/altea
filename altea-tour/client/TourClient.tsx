import * as React from "react";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { ajaxGet } from "@altea/altea/client/Services";
import { onWidgets } from "@altea/altea/client/Frames/Widgets";
import { TourButtonOptions } from "@altea/altea/client/TourButton";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import type { TypeEntity } from "@altea/altea/data/typeEntity";
import { UserAssetClient } from "@altea/altea-user-assets/client/UserAssetClient";
import { DashboardClient } from "@altea/altea-dashboard/client/DashboardClient";
import "@altea/altea-user-queries/client/UserQueriesClient"; // augments SearchControlLoaded with getCurrentUserQuery
import { TourEntity, TourStepEntity } from "../data/Tour";
import { TourButton } from "./TourComponent";

// Port of Signum.Tour's TourClient.tsx — the module's client registration.
//
// Where the tour button appears, all four from Signum:
//   • on any ENTITY frame, as a widget (the tour of that entity's TYPE);
//   • on a DASHBOARD page, in its action bar;
//   • in a SearchControl's toolbar, when a USER QUERY is applied;
//   • …except on a full-PAGE search control, where it goes in the title instead.
//
// altea divergences:
//  - `Navigator.addSettings(new EntitySettings(…))` → `cb.configure(…).withView(…)`.
//  - the widget's fast path reads `frame.pack.extension?.hasTour`, core's new entity-pack extension bag
//    (Signum's `EntityPackTS.AddExtension`, added for this module — see server/TourLogic).
//  - `getCurrentUserQuery` is altea-user-queries' own augmentation of SearchControlLoaded, derived from
//    `extraUrlParams.userQuery` (Signum keeps a dedicated field).
export namespace TourClient {

    // Signum keys the two title-rendering search pages by tag. Same tags in altea.
    const titlePageTags = ["SearchPage", "UserQueryPage"];

    export function start(cb: ClientBuilder): void {

        // Implement core's framework-level extension point: from here on, every `<TourButton>` a module
        // renders resolves to the real one. Without this module started they all render nothing.
        TourButtonOptions.renderer = (trigger, className) => <TourButton trigger={trigger} className={className} />;

        cb.configure(TourEntity).withView(() => import("./Templates/Tour"));
        cb.configure(TourStepEntity).withView(() => import("./Templates/TourStep"));

        onWidgets().push(wc => {
            if (!Navigator.isViewable(TourEntity))
                return undefined;

            // No tour for this type AND the user cannot author one → nothing to offer.
            if (wc.frame.pack?.extension?.["hasTour"] === false && Navigator.isReadOnly(TourEntity))
                return undefined;

            return <TourButton trigger={wc.ctx.value.constructor as never} />;
        });

        UserAssetClient.start(cb.routes);
        UserAssetClient.registerExportAssertLink(TourEntity);

        DashboardClient.onDashboardPageActions().push(dashboard =>
            dashboard.id != null ? <TourButton trigger={dashboard.toLite()} /> : undefined);

        Finder.ButtonBarQuery.onButtonBarElements().push(ctx => {
            const uq = ctx.searchControl.getCurrentUserQuery?.();
            if (uq == null)
                return undefined;

            // On a full-page search control the button belongs in the title (see below), not the toolbar.
            if (titlePageTags.includes(ctx.searchControl.props.tag as string))
                return undefined;

            return {
                button: (
                    <span className="d-inline-flex align-items-center mx-2">
                        <TourButton trigger={uq} />
                    </span>
                ),
            };
        });

        Finder.Options.onSearchPageTitleElements().push(scl => {
            const uq = scl.getCurrentUserQuery?.();
            return uq != null ? <TourButton trigger={uq} /> : null;
        });
    }

    export namespace API {
        export function getTourByEntity(typeName: string): Promise<TourDTO | null> {
            return ajaxGet({ url: `/api/tour/byEntity/${typeName}` });
        }

        export function getTourBySymbol(symbolKey: string): Promise<TourDTO | null> {
            return ajaxGet({ url: `/api/tour/bySymbol/${encodeURIComponent(symbolKey)}` });
        }

        export function getTourByLite(lite: Lite<Entity>): Promise<TourDTO | null> {
            return ajaxGet({ url: `/api/tour/byLite?liteKey=${encodeURIComponent(lite.key())}` });
        }

        /**
         * The entity type a `TourTriggerSymbol` trigger stands for, as a CLEAN NAME — so the editor can
         * offer that type's property routes as "Property" CSS steps. Signum returns a `Lite<TypeEntity>`;
         * the client only ever needs the name (see server/TourServer).
         */
        export function getTriggerType(lite: Lite<Entity>): Promise<string | null> {
            return ajaxGet({ url: `/api/tour/triggerType?liteKey=${encodeURIComponent(lite.key())}` });
        }

        /** The TypeEntity lite for a clean name — what "create a tour for this type" needs to store. */
        export function typeLite(typeName: string): Promise<Lite<TypeEntity> | null> {
            return ajaxGet<TypeEntity | null>({ url: `/api/reflection/typeEntity/${typeName}` })
                .then(te => te == null ? null : te.toLite());
        }
    }
}

/** Signum's TourDTO, client side — the flattened, selector-resolved tour the player consumes. */
export interface TourDTO {
    tour: Lite<TourEntity>;
    forEntity: Lite<Entity>;
    steps: TourStepDTO[];
    showProgress: boolean;
    animate: boolean;
    showCloseButton: boolean;
}

export interface TourStepDTO {
    cssSelector: string | null;
    title: string;
    description: string;
    side: string | null;
    align: string | null;
    /** The ClickTrigger member NAME ("OnLoad" / "OnNext") — the server sends `Enum.toName`. */
    click: string | null;
}
