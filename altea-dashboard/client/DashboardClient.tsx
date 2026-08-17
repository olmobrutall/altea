import * as React from "react";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { Operations, EntityOperationSettings } from "@altea/altea/client/Operations";
import * as AppContext from "@altea/altea/client/AppContext";
import { ajaxGet } from "@altea/altea/client/Services";
import { getTypeName } from "@altea/altea/client/Reflection";
import { cleanTypeName } from "@altea/altea/data/registration";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import { onEmbeddedWidgets, type EmbeddedWidget, type EmbeddedWidgetPosition } from "@altea/altea/client/Frames/Widgets";
import { useAPI } from "@altea/altea/client/Hooks";
import type { EntityFrame } from "@altea/altea/client/TypeContext";
import { Constructor } from "@altea/altea/client/Constructor";
import type { Entity, BaseEntity, Type } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Enum } from "@altea/altea/data/enum";
import { UserAssetClient } from "@altea/altea-user-assets/client/UserAssetClient";
import {
    DashboardEntity, DashboardLite, DashboardMessage, DashboardOperation, DashboardPermission,
    DashboardVariableMessage, DashboardEmbedededInEntityEnum, PanelPartEmbedded, type IPartEntity,
} from "../data/Dashboard";
import {
    TextPartEntity, ImagePartEntity, SeparatorPartEntity, HealthCheckPartEntity, CustomPartEntity,
} from "../data/Parts";
import { DashboardController } from "./View/DashboardFilterController";
import { parseIcon } from "./IconHelpers";

// Port of Signum's Signum.Dashboard/DashboardClient.tsx. Owns the PART RENDERER REGISTRY (which React
// component renders which part entity), registers the dashboard editor + the /dashboard/:id page, the
// quick-links (per entity type + "preview"), the embedded-dashboard widgets, and the `$Variable$` values
// text parts substitute.
//
// altea divergences, documented inline:
//  - Signum read the entity-scoped dashboards off the ENTITY PACK (`pack.dashboards` /
//    `pack.embeddedDashboards`, filled by an EntityPackTS.AddExtension on the server). altea's EntityPack
//    has no extension bag, so the widget/quick-link fetch them from `/api/dashboard/forEntityType` and
//    `/api/dashboard/embedded/:typeName`.
//  - CachedQuery is deferred (Signum.Files): there is no `cachedQueries` prop on a part — every part
//    queries live. Same for the Toolbar config and the Omnibox provider (those extensions are not ported).
//  - Signum's `AppContext.clearSettingsActions.push(clearDashboardPageActions)` has no altea analogue
//    (altea has no clearSettingsActions); `onDashboardPageActions` is simply module state.
//  - `translated(part, …)` (PropertyRouteTranslationLogic) is not ported: the raw stored text is shown.

export namespace DashboardClient {

    export interface IconColor {
        icon: IconProp;
        iconColor: string;
    }

    /** Signum's DashboardClient.PartRenderer<T> — everything the dashboard needs to know about a part type. */
    export interface PartRenderer<T extends IPartEntity> {
        component: () => Promise<React.ComponentType<PanelPartContentProps<T>>>;
        waitForInvalidation?: boolean;
        icon: () => IconColor;
        defaultTitle?: (element: T) => string;
        withPanel?: (element: T, entity: Lite<Entity> | undefined) => boolean;
        /** The queries a part reads — the token-equivalence editor offers them (Signum's getQueryNames). */
        getQueryNames?: (element: T) => string[];
        handleTitleClick?: (content: T, entity: Lite<Entity> | undefined, customDataRef: React.RefObject<any>, e: React.MouseEvent<any>) => void;
        handleEditClick?: (content: T, entity: Lite<Entity> | undefined, customDataRef: React.RefObject<any>, e: React.MouseEvent<any>) => Promise<boolean>;
        customTitleButtons?: (content: T, entity: Lite<Entity> | undefined, customDataRef: React.RefObject<any>) => React.ReactNode;
    }

    export const partRenderers: { [typeName: string]: PartRenderer<IPartEntity> } = {};

    /** Signum's DashboardClient.GlobalVariables — `$Name$` placeholders a TextPart substitutes. */
    export const GlobalVariables: Map<string, () => string> = new Map<string, () => string>();

    export function start(cb: ClientBuilder): void {

        // Shared user-asset infrastructure: the import route + the "Export to XML" quick-link on Dashboard.
        UserAssetClient.start(cb.routes);
        UserAssetClient.registerExportAssertLink(DashboardEntity);

        // A new dashboard belongs to whoever creates it (Signum's registerConstructor).
        Constructor.registerConstructor(DashboardEntity, () => {
            const db = new DashboardEntity();
            db.owner = AppContext.currentUser?.toLite() ?? null;
            return db;
        });

        cb.configure(DashboardEntity)
            .withView(() => import("./Admin/Dashboard"))
            .withQuerySettings(token => ({
                defaultOrders: [{ token: token(d => d.dashboardPriority), orderType: "Descending" }],
            }));

        // The part editors (each part entity's own view — rendered inside the grid cell and in the modal).
        cb.configure(TextPartEntity).withView(() => import("./Admin/TextPart"));
        cb.configure(ImagePartEntity).withView(() => import("./Admin/ImagePart"));
        cb.configure(SeparatorPartEntity).withView(() => import("./Admin/SeparatorPart"));
        cb.configure(HealthCheckPartEntity).withView(() => import("./Admin/HealthCheckPart"));
        cb.configure(CustomPartEntity).withView(() => import("./Admin/CustomPart"));

        // The dashboard page.
        cb.routes.push({
            path: "/dashboard/:dashboardId",
            element: <ImportComponent onImport={() => import("./View/DashboardPage")} />,
        });

        // The part VIEW renderers (Signum registers the same five here).
        registerRenderer(TextPartEntity, {
            component: () => import("./View/TextPart").then(a => a.default),
            icon: () => ({ icon: "code", iconColor: "#000000" }),
            withPanel: () => false,
        });

        registerRenderer(ImagePartEntity, {
            component: () => import("./View/ImagePartView").then(a => a.default),
            icon: () => ({ icon: "image", iconColor: "forestgreen" }),
            withPanel: () => false,
        });

        registerRenderer(SeparatorPartEntity, {
            component: () => import("./View/SeparatorPartView").then(a => a.default),
            icon: () => ({ icon: "rectangle-list", iconColor: "forestgreen" }),
            withPanel: () => false,
        });

        registerRenderer(HealthCheckPartEntity, {
            component: () => import("./View/HealthCheckPart").then(a => a.default),
            icon: () => ({ icon: "heart-pulse", iconColor: "forestgreen" }),
            withPanel: () => false,
        });

        registerRenderer(CustomPartEntity, {
            component: () => import("./View/CustomPart").then(a => a.default),
            icon: () => ({ icon: "cube", iconColor: "forestgreen" }),
            withPanel: (cp, e) => Options.customPartRenderers[e == null ? "NONE" : getTypeName(e)]?.[cp.customPartName]?.withPanel ?? true,
        });

        // Clone shows up as a normal constructor button; the Save/Delete ones are the framework defaults.
        Operations.addSettings(new EntityOperationSettings(DashboardOperation.Clone, {
            icon: "clone",
            color: "info",
        }));

        // Signum's onEmbeddedWidgets: an entity-scoped dashboard renders INSIDE the entity's view (Top /
        // Bottom / Tab). Signum read them off the entity PACK, so the server decided per entity whether to
        // attach any at all. altea's EntityPack has no extension bag, so instead the client learns ONCE at
        // startup which entity types have an embedded dashboard (`/embeddedTypes`) and registers a widget only
        // for those — a widget registered for a type with none would show up as an empty "Dashboards" tab on
        // every entity view. The dashboards themselves are then fetched per type by the widget.
        API.embeddedTypes().then(types => { embeddedTypeNames = new Set(types); }, () => { embeddedTypeNames = new Set(); });

        onEmbeddedWidgets.push(wc => {
            const entity = wc.frame.pack.entity as Entity | undefined;
            if (entity == null || entity.isNew)
                return undefined;

            if (embeddedTypeNames == null || !embeddedTypeNames.has(getTypeName(entity)))
                return undefined;

            return (["Top", "Bottom", "Tab"] as EmbeddedWidgetPosition[]).map(position => ({
                position,
                embeddedWidget: <EmbeddedDashboards entity={entity} frame={wc.frame} position={position} />,
                eventKey: "embeddedDashboards_" + position,
                title: DashboardEntity.nicePluralName(),
            } as EmbeddedWidget));
        });

        // Global quick-link: on any entity, offer the dashboards scoped to that entity type — each opens the
        // dashboard page filtered by the current entity (Signum's registerGlobalQuickLink). Server-gated by
        // ViewDashboard (altea has no client permission primitive — the route enforces it).
        QuickLinkClient.registerGlobalQuickLink(entityType =>
            API.forEntityType(entityType).then(ds => ds.map(d =>
                new QuickLinkAction(d.key(), () => d.toString(), (ctx, e) =>
                    AppContext.pushOrOpenInTab(dashboardUrl(d, ctx.lite), e), {
                    order: 0,
                    icon: "gauge",
                    iconColor: "darkslateblue",
                    color: "success",
                    onlyForToken: (d as DashboardLite).hideQuickLink,
                }),
            )));

        // Preview quick-link on a Dashboard itself (Signum's "preview").
        QuickLinkClient.registerQuickLink(DashboardEntity, new QuickLinkAction(
            "preview", () => DashboardMessage.Preview.niceToString(), async (ctx, e) => {
                const db = await Navigator.API.fetch(ctx.lite as Lite<DashboardEntity>);
                if (db == null)
                    return;
                if (db.entityType == null)
                    AppContext.pushOrOpenInTab(dashboardUrl(ctx.lite as Lite<DashboardEntity>), e);
                else {
                    // Entity-scoped: pick the entity to preview it over (Signum used Finder.find + the type).
                    const entity = await Finder.find({ queryName: db.entityType.toString() });
                    if (entity)
                        AppContext.pushOrOpenInTab(dashboardUrl(ctx.lite as Lite<DashboardEntity>, entity), e);
                }
            },
            { group: null, icon: "eye", iconColor: "blue", color: "info" },
        ));

        GlobalVariables.set("UserName", () => AppContext.currentUser?.toString() ?? "");
        GlobalVariables.set("UserGreeting", () => {
            const hour = new Date().getHours();
            if (hour < 5) return DashboardVariableMessage.GoodNight.niceToString();
            if (hour < 12) return DashboardVariableMessage.GoodMorning.niceToString();
            if (hour < 17) return DashboardVariableMessage.GoodAfternoon.niceToString();
            if (hour < 21) return DashboardVariableMessage.GoodEvening.niceToString();
            return DashboardVariableMessage.GoodNight.niceToString();
        });
    }

    /** Signum's DashboardClient.home: the highest-priority dashboard to show as the app home page. */
    export function home(): Promise<Lite<DashboardEntity> | null> {
        if (!Navigator.isViewable(DashboardEntity))
            return Promise.resolve(null);

        return API.home();
    }

    export function hasWaitForInvalidation(part: IPartEntity): boolean | undefined {
        return partRenderers[getTypeName(part)]?.waitForInvalidation;
    }

    export function icon(typeName: string): IconColor {
        return partRenderers[typeName].icon();
    }

    export function getQueryNames(part: IPartEntity): string[] {
        return partRenderers[getTypeName(part)]?.getQueryNames?.(part) ?? [];
    }

    export function dashboardUrl(lite: Lite<DashboardEntity>, entity?: Lite<Entity>): string {
        return "/dashboard/" + lite.id + (!entity ? "" : "?entity=" + entity.key());
    }

    /** Signum's registerRenderer — a module registers how ITS part type renders (altea keys the registry
     *  by the entity ctor NAME, which is what a live part instance carries). */
    export function registerRenderer<T extends IPartEntity>(type: Type<T>, renderer: PartRenderer<T>): void {
        partRenderers[cleanTypeName(type)] = renderer as PartRenderer<any> as PartRenderer<IPartEntity>;
    }

    export namespace API {
        export function forEntityType(type: string): Promise<Lite<DashboardEntity>[]> {
            return ajaxGet({ url: "/api/dashboard/forEntityType/" + type });
        }

        export function embedded(type: string): Promise<DashboardEntity[]> {
            return ajaxGet({ url: "/api/dashboard/embedded/" + type });
        }

        /** The entity types that have an embedded dashboard (altea-only — see the widget registration). */
        export function embeddedTypes(): Promise<string[]> {
            return ajaxGet({ url: "/api/dashboard/embeddedTypes" });
        }

        export function home(): Promise<Lite<DashboardEntity> | null> {
            return ajaxGet({ url: "/api/dashboard/home" });
        }

        export function get(dashboard: Lite<DashboardEntity>): Promise<DashboardEntity> {
            return ajaxGet({ url: "/api/dashboard/" + dashboard.id });
        }
    }

    export const onDashboardPageActions: Array<(dashboard: DashboardEntity) => React.ReactElement | undefined> = [];

    export function clearDashboardPageActions(): void {
        onDashboardPageActions.clear();
    }

    export namespace Options {

        export const customTitle: (dashboard: DashboardEntity) => React.ReactNode = d => <DashboardTitle dashboard={d} />;

        export const customPartRenderers: Record<string /*typeName*/, Record<string /*customPartName*/, CustomPartRenderer>> = {};

        export function getCustomPartRenderer(typeName: string | undefined): Record<string, CustomPartRenderer> | undefined {
            return customPartRenderers[typeName ?? "global"];
        }

        export function registerCustomPartRenderer<T extends Entity = Entity>(
            type: Type<T> | null, customPartName: string,
            renderer: () => Promise<{ default: React.ComponentType<CustomPartProps<T>> }>,
            opts?: { withPanel?: boolean },
        ): void {
            const dic = customPartRenderers[type == null ? "global" : cleanTypeName(type)] ??= {};
            dic[customPartName] = {
                renderer: renderer as () => Promise<{ default: React.ComponentType<CustomPartProps<Entity>> }>,
                withPanel: opts?.withPanel ?? true,
            };
        }
    }
}

interface CustomPartRenderer {
    renderer: () => Promise<{ default: React.ComponentType<CustomPartProps<Entity>> }>;
    withPanel: boolean;
}

export interface CustomPartProps<T extends Entity> {
    partEmbedded: PanelPartEmbedded;
    content: CustomPartEntity;
    entity?: Lite<T>;
    dashboardController: DashboardController;
}

/** Signum's PanelPartContentProps — what every part VIEW component receives (minus `cachedQueries`,
 *  deferred with CachedQuery). */
export interface PanelPartContentProps<T extends IPartEntity> {
    partEmbedded: PanelPartEmbedded;
    content: T;
    entity?: Lite<Entity>;
    deps?: React.DependencyList;
    dashboardController: DashboardController;
    customDataRef: React.RefObject<any>;
}

/** Signum's DashboardClient.DashboardTitle — the dashboard's icon + display name. */
export function DashboardTitle(p: { dashboard: DashboardEntity }): React.JSX.Element | undefined {

    const icon = parseIcon(p.dashboard.iconName);
    const title = p.dashboard.hideDisplayName ? undefined :
        <span style={{ color: p.dashboard.titleColor ?? undefined }}>
            {p.dashboard.displayName}
        </span>;

    if (icon == null)
        return title as React.JSX.Element | undefined;

    return (
        <div className="dashboard-title">
            <FontAwesomeIcon aria-hidden={true} icon={icon} color={p.dashboard.iconColor ?? undefined} />
            &nbsp;{title}
        </div>
    );
}

/** Signum's DashboardClient.DashboardWidget, adapted: altea fetches the entity type's embedded dashboards
 *  (Signum shipped them on the entity pack) and renders the ones configured for `position`. The fetch is
 *  cached per type name so the three position widgets share ONE request. */
function EmbeddedDashboards(p: { entity: Entity; frame: EntityFrame; position: EmbeddedWidgetPosition }): React.JSX.Element | null {

    const typeName = getTypeName(p.entity);
    const dashboards = useAPI(() => embeddedDashboardsCached(typeName), [typeName]);
    const component = useAPI(() => import("./View/DashboardView").then(mod => mod.default), []);

    const mine = dashboards?.filter(d => embeddedPosition(d) === p.position) ?? [];

    if (mine.length == 0 || !component)
        return null;

    return (
        <>
            {mine.map(d => (
                <React.Fragment key={String(d.id)}>
                    {React.createElement(component, {
                        dashboard: d,
                        entity: p.entity,
                        reload: () => p.frame.onReload(),
                        embedded: true,
                    })}
                </React.Fragment>
            ))}
        </>
    );
}

// The entity types that have an embedded dashboard, learned once at startup (see the widget registration).
// `undefined` until the fetch resolves — a widget is registered only for a type that is in the set.
let embeddedTypeNames: Set<string> | undefined = undefined;

const embeddedCache = new Map<string, Promise<DashboardEntity[]>>();

function embeddedDashboardsCached(typeName: string): Promise<DashboardEntity[]> {
    let promise = embeddedCache.get(typeName);
    if (promise == null) {
        // A missing ViewDashboard permission / an unregistered type answers with an error: treat it as "none"
        // (Signum simply omitted the pack extension in that case).
        promise = DashboardClient.API.embedded(typeName).catch(() => [] as DashboardEntity[]);
        embeddedCache.set(typeName, promise);
    }
    return promise;
}

/** Where an embedded dashboard wants to render (Signum's `d.embeddedInEntity` cast). altea enums are
 *  ordinals, so the widget position comes from the member NAME. */
export function embeddedPosition(dashboard: DashboardEntity): EmbeddedWidgetPosition {
    const name = dashboard.embeddedInEntity == null ? "Bottom"
        : Enum.toName(DashboardEmbedededInEntityEnum, dashboard.embeddedInEntity);
    return name === "None" ? "Bottom" : name as EmbeddedWidgetPosition;
}

export { DashboardTooltipIcon } from "./View/DashboardTooltipIcon";
