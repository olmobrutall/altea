import { Dic } from "@altea/altea/data/globals";
import { cleanTypeName } from "@altea/altea/data/registration";
import { ajaxGet } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Finder } from "@altea/altea/client/Finder";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { UserAssetClient } from "@altea/altea-user-assets/client/UserAssetClient";
import {
    ToolbarEntity, ToolbarMenuEntity, ToolbarSwitcherEntity, ToolbarEntity_Elements, ToolbarMenuEntity_Elements,
    ToolbarSwitcherEntity_Options, type ToolbarLocation,
} from "../data/Toolbar";
import type { ToolbarResponse } from "../data/ToolbarResponse";
import QueryToolbarConfig from "./QueryToolbarConfig";
import type { ToolbarConfig } from "./ToolbarConfig";

// Port of Signum's ToolbarClient.tsx (Signum.Toolbar/ToolbarClient.tsx): the entity views, the per-content
// CONFIG REGISTRY the renderers dispatch through, and the two API calls.
//
// altea divergences:
//  - `start(cb)` takes a ClientBuilder like every other altea client module (Signum's took `{ routes }`), and
//    registers views through `cb.configure(X).withView(…)` instead of `Navigator.addSettings(new
//    EntitySettings(…))`.
//  - The registry is keyed by the content type's CLEAN NAME ("Query", "UserQuery", …), because that is what a
//    Lite's `entityType` resolves to and what the ToolbarResponse carries — the same clean-name keying the
//    dashboard part registries use. Signum keyed by `config.type.typeName`, which IS the clean name there.
//  - Signum's `ChangeLogClient.registerChangeLogModule` and `AppContext.clearSettingsActions.push(
//    cleanConfigs)` are dropped (altea has neither; module state resets via AppContext.newClientState).
//    `cleanConfigs` stays exported.
//  - `ToolbarResponse<T>` is declared ONCE in the isomorphic data layer (data/ToolbarResponse.ts), not
//    re-declared here as Signum's TS twin of the C# DTO.

export namespace ToolbarClient {

    export function start(cb: ClientBuilder): void {

        // Shared user-asset infrastructure: the import route + the "Export to XML" quick-link.
        UserAssetClient.start(cb.routes);
        UserAssetClient.registerExportAssertLink(ToolbarEntity);
        UserAssetClient.registerExportAssertLink(ToolbarMenuEntity);
        UserAssetClient.registerExportAssertLink(ToolbarSwitcherEntity);

        cb.configure(ToolbarEntity).withView(() => import("./Templates/Toolbar"));
        cb.configure(ToolbarMenuEntity).withView(() => import("./Templates/ToolbarMenu"));
        cb.configure(ToolbarEntity_Elements).withView(() => import("./Templates/ToolbarElement"));
        cb.configure(ToolbarMenuEntity_Elements).withView(() => import("./Templates/ToolbarElement"));
        cb.configure(ToolbarSwitcherEntity).withView(() => import("./Templates/ToolbarSwitcher"));
        cb.configure(ToolbarSwitcherEntity_Options).withView(() => import("./Templates/ToolbarSwitcherOption"));

        registerConfig(new QueryToolbarConfig());

        // Signum: `Finder.addSettings({ queryName: ToolbarEntity, defaultOrders: [priority desc] })`.
        cb.configure(ToolbarEntity).withQuerySettings(token => ({
            defaultOrders: [{ token: token(a => a.priority), orderType: "Descending" }],
        }));
    }

    export function cleanConfigs(): void {
        Dic.clear(configs);
    }

    /** Signum's `configs` — clean type name → the configs registered for it. */
    export const configs: { [type: string]: ToolbarConfig<any>[] } = {};

    export function registerConfig<T extends Entity>(config: ToolbarConfig<T>): void {
        (configs[cleanTypeName(config.type)] ??= []).push(config);
    }

    export function getConfig(res: ToolbarResponse<any>): ToolbarConfig<any> | null {
        return configs[cleanTypeName(res.content!.entityType)]?.filter(c => c.isApplicableTo(res)).singleOrNull();
    }

    /**
     * Per-EntityType filter for entity-scoped toolbar menus (menus with EntityType set).
     * Returns the set of toolbar-element Guid strings that should be hidden for the given entity,
     * or `null` to apply no filtering. Called when the user picks an entity in
     * `ToolbarMenuItemsEntityType`; elements whose `guid` is in the returned set are dropped.
     */
    export type EntityElementFilter = (entity: Lite<Entity>) => Promise<Set<string> | null> | Set<string> | null;

    export const entityElementFilters: { [entityType: string]: EntityElementFilter } = {};

    export function registerEntityElementFilter(entityType: string, filter: EntityElementFilter): void {
        entityElementFilters[entityType] = filter;
    }

    export namespace API {
        export function getCurrentToolbar(location: ToolbarLocation): Promise<ToolbarResponse<any> | null> {
            return ajaxGet({ url: `/api/toolbar/current/${location}` });
        }

        export function getToolbarMenu(menu: Lite<ToolbarMenuEntity>): Promise<ToolbarResponse<any> | null> {
            return ajaxGet({ url: `/api/toolbarMenu/${menu.id}` });
        }
    }
}
