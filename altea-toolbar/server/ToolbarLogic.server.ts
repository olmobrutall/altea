import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import "@altea/altea/data/globals/arrayExtensions"; // groupWhen / notNull / firstOrNull / …
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { retrieve, deleteList } from "@altea/altea/server/Database";
import { DirectedGraph } from "@altea/altea/server/directedGraph";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { getNiceName, type QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import type { Entity, Type } from "@altea/altea/data/entity";
import { getTypeInfo, type TypeInfo } from "@altea/altea/data/reflection";
import { Lite } from "@altea/altea/data/lite";
import { Enum } from "@altea/altea/data/enum";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { PermissionSymbol, TypeAllowedBasic } from "@altea/altea-auth/data/Rules";
import type { TypeConditionSymbol } from "@altea/altea-auth/data/Rules";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { QueryAuthLogic } from "@altea/altea-auth/server/QueryAuthLogic";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import { UserAssetLogic } from "@altea/altea-user-assets/server/UserAssetLogic.server";
import { UserAssetOwnerAuth } from "@altea/altea-user-assets/server/UserAssetOwnerAuth.server";
import {
    ToolbarEntity, ToolbarMenuEntity, ToolbarSwitcherEntity, ToolbarEntity_Element, ToolbarOperation, ToolbarMenuOperation,
    ToolbarSwitcherOperation, ToolbarElementTypeEnum, ToolbarLocationEnum, ShowCountEnum, ToolbarMessage,
    type ToolbarLocation, type ToolbarElementType, type ShowCount, type IToolbarEntity,
    type ToolbarElementBaseEntity,
} from "../data/Toolbar";
import type { ToolbarResponse } from "../data/ToolbarResponse";
import { registerToolbarXml } from "./ToolbarXml.server";
import { ToolbarServer } from "./ToolbarServer.server";

// Port of Signum's ToolbarLogic (Signum.Toolbar/ToolbarLogic.cs). Registers the three toolbar entities +
// their Save/Delete operations + queries, their in-memory caches (Signum's ResetLazy GlobalLazys), the XML
// (de)serializers, the CONTENT CONFIG registry other modules extend, and — when a web host is present — the
// HTTP surface. Its heart is `toResponseList`: turning the stored elements into the authorization-filtered,
// label-resolved ToolbarResponse tree the renderers draw.
//
// altea divergences, documented inline:
//  - Signum runs its element checks + the recursion check from `sb.Schema.EntityEvents<T>().Saving`. altea's
//    `saving` event is SYNCHRONOUS (no sync DB access), and the recursion check must read the referenced
//    toolbars — so the element checks moved to owner-level `@fieldValidation`s (data/Toolbar.ts, they need no
//    DB) and the recursion check runs in the Save operation's `execute` (below). Every save goes through the
//    registered Save operation (the XML importer included), so the coverage is the same.
//  - Signum's `Schema.Current.GetInMemoryFilter<T>(userInterface: false)` → UserAssetOwnerAuth.filterVisible
//    (async — a condition may need DB-filling), applied by each lookup because the caches are filled in
//    ExecutionMode.global, where the row-level query filter never ran. Same pattern as dashboard/user-queries.
//  - `PropertyRouteTranslationLogic.TranslatedField` / `TranslatedMList` are dropped with the rest of
//    instance translation (the dashboard port's deferral): the raw stored name / label is returned.
//  - `RegisterDelete<T>`'s Signum implementation is a SQL-SYNC cascade (WithCascadeDeleteMListBy +
//    PreDeleteSqlSync + UnsafeDeletePreCommandMList). altea has no MList tables (an element is a `@part`
//    ROW) and no `Administrator.UnsafeDeletePreCommandMList`, so the port hangs off the `preUnsafeDelete`
//    event and deletes the orphaned element rows itself — see `registerDelete`.
//  - Signum's `AuthLogic.HasRuleOverridesEvent` hook (a role has toolbar overrides) has no altea analogue
//    yet; noted where it belongs.
//  - The response builder is ASYNC throughout (altea's authorization is async).

// ---- The content-config registry (Signum's ToolbarContentConfig<T> + ContentConfigDictionary) -----------

/** Signum's `ToolbarContentConfig<T>` (ToolbarLogic.cs): everything the response builder needs to know about
 *  ONE kind of element content — may this role use it, what does it show when the element names no label /
 *  icon of its own, which query does it ultimately run, and (for a permission) does it expand into a whole
 *  block of synthetic responses. Every callback is async here (altea's auth is).
 *
 *  A module registers the config for its own asset from its own `XxxLogic.start` (Signum did it inside
 *  `sb.Schema.WhenIncluded<ToolbarEntity>`) — see altea-user-queries / altea-chart / altea-dashboard. */
export interface ToolbarContentConfig<T extends Entity = Entity> {
    /** Signum's `Func<Lite<T>, bool> IsAuthorized` (required). */
    isAuthorized(lite: Lite<T>): Promise<boolean>;
    /** Signum's `Func<Lite<T>, string> DefaultLabel` (required). */
    defaultLabel(lite: Lite<T>): Promise<string> | string;
    defaultIconName?(lite: Lite<T>): Promise<string | null> | string | null;
    defaultIconColor?(lite: Lite<T>): Promise<string | null> | string | null;
    /** Signum's `CustomResponses`: replace this ONE element with a list of synthetic ones (used by
     *  `customPermissionResponse` — a permission that stands for a whole generated block). */
    customResponses?(lite: Lite<T>): Promise<ToolbarResponse[] | null> | ToolbarResponse[] | null;
    /** Signum's `GetRelatedQuery`: the query this content runs, for the client's per-entity filtering. */
    getRelatedQuery?(lite: Lite<T>): Promise<QueryEntity | null> | QueryEntity | null;
}

// Signum's `static Dictionary<Type, IToolbarContentConfig> ContentConfigDictionary` — keyed by the CONTENT
// entity ctor (altea's Lite carries the ctor in `entityType`, so no clean-name detour is needed).
const contentConfigs = new Map<Function, ToolbarContentConfig>();

export namespace ToolbarLogic {

    // Signum's three `ResetLazy<FrozenDictionary<Lite<X>, X>>` caches. Arrays here (the lookups are by id /
    // by predicate, and a Lite is not a value key in JS) — as in DashboardLogic.dashboardsLazy.
    export let toolbarsLazy: ResetLazy<ToolbarEntity[]> = null!;
    export let toolbarMenusLazy: ResetLazy<ToolbarMenuEntity[]> = null!;
    export let toolbarSwitchersLazy: ResetLazy<ToolbarSwitcherEntity[]> = null!;

    /** Signum's `CustomPermissionResponse`: a permission symbol whose element expands into a generated
     *  block of responses (the app registers the generator). Keyed by the permission KEY. */
    export const customPermissionResponse = new Map<string, () => Promise<ToolbarResponse[]> | ToolbarResponse[]>();

    /** Signum's `ToolbarContentConfig<T>.Register()` extension. */
    export function registerContentConfig<T extends Entity>(type: Type<T>, config: ToolbarContentConfig<T>): void {
        contentConfigs.set(type, config as unknown as ToolbarContentConfig);
    }

    /** Signum's `GetContentConfig<T>()`. */
    export function getContentConfig<T extends Entity>(type: Type<T>): ToolbarContentConfig<T> {
        const c = contentConfigs.get(type);
        if (c == null)
            throw new Error(`Toolbar: no content config registered for '${type.name}'`);
        return c as unknown as ToolbarContentConfig<T>;
    }

    function tryGetContentConfig(lite: Lite<Entity>): ToolbarContentConfig | undefined {
        return contentConfigs.get(lite.entityType);
    }

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Shared user-asset infrastructure (permission + import/export HTTP surface).
        UserAssetLogic.start(sb);

        // `withSave(op, body)` runs `body` and then saves implicitly (Graph.Execute.avoidImplicitSave is
        // false), so the recursion check Signum ran from the `Saving` event rides along here — see the
        // header note. Signum's `WithSave`/`WithDelete`/`WithQuery` shapes are otherwise untouched.
        sb.include(ToolbarEntity)
            .withSave(ToolbarOperation.Save, tb => ToolbarLogic.assertNoRecursion(tb))
            .withDelete(ToolbarOperation.Delete)
            .withQuery();

        sb.include(ToolbarMenuEntity)
            .withSave(ToolbarMenuOperation.Save, tm => ToolbarLogic.assertNoRecursion(tm))
            .withDelete(ToolbarMenuOperation.Delete)
            .withQuery();

        sb.include(ToolbarSwitcherEntity)
            .withSave(ToolbarSwitcherOperation.Save, ts => ToolbarLogic.assertNoRecursion(ts))
            .withDelete(ToolbarSwitcherOperation.Delete)
            .withQuery();

        // Signum: `sb.Schema.Settings.AssertImplementedBy(t => t.Elements.First().Content, typeof(X))` for
        // each of the five. altea declares that list ON the field (`@implementedBy` in data/Toolbar.ts) and
        // the app widens it, so there is nothing to assert here.
        //
        // Signum also registers `AuthLogic.HasRuleOverridesEvent` (does this role own any toolbar?) — altea's
        // AuthLogic has no such hook yet; when it lands, add the Toolbar/ToolbarMenu owner probe here.

        // How the three roots are (de)serialized to/from XML + which Save operation the importer runs
        // (Signum's `UserAssetsImporter.Register("Toolbar", ToolbarOperation.Save)` &c.).
        registerToolbarXml();

        // Signum's three GlobalLazys. Retrieved through `retrieve` (not a bare table read) so each root
        // arrives with its element / option rows — the caches back every response lookup.
        toolbarsLazy = sb.globalLazy(async () => {
            const rows = await table(ToolbarEntity).toArray() as ToolbarEntity[];
            return await Promise.all(rows.map(t => retrieve(ToolbarEntity, t.id)));
        }, { invalidateWith: [ToolbarEntity] });

        toolbarMenusLazy = sb.globalLazy(async () => {
            const rows = await table(ToolbarMenuEntity).toArray() as ToolbarMenuEntity[];
            return await Promise.all(rows.map(t => retrieve(ToolbarMenuEntity, t.id)));
        }, { invalidateWith: [ToolbarMenuEntity] });

        toolbarSwitchersLazy = sb.globalLazy(async () => {
            const rows = await table(ToolbarSwitcherEntity).toArray() as ToolbarSwitcherEntity[];
            return await Promise.all(rows.map(t => retrieve(ToolbarSwitcherEntity, t.id)));
        }, { invalidateWith: [ToolbarSwitcherEntity] });

        // Signum calls `RegisterDelete<T>` once per content type — four times here, plus once from every
        // module that adds a content type (`UserQueryLogic`, `UserChartLogic`, …, each inside its own
        // `WhenIncluded<ToolbarEntity>`). altea reads the CONTENT field's `@implementedBy` list instead, which
        // the app has already widened by the time any Logic.start runs (EntityOverrides.start precedes the
        // schema build) — so every content type is covered with no per-module call and no ordering hazard.
        for (const ti of contentTypeInfos())
            registerDelete(sb, ti.ctor as Type<Entity>);

        // ---- The content configs of the toolbar module's OWN five content types ------------------------

        registerContentConfig(ToolbarMenuEntity, {
            defaultLabel: async lite => (await getToolbarMenu(lite)).name,
            isAuthorized: async lite => {
                const entity = await getToolbarMenu(lite);
                // An entity-scoped menu is pointless when the role may not even read the type it scopes to.
                if (entity.entityType != null)
                    if (await TypeAuthLogic.maxTypeAllowedUI(entity.entityType.id) === TypeAllowedBasic.None)
                        return false;

                return await UserAssetOwnerAuth.isVisible(entity);
            },
        });

        registerContentConfig(ToolbarSwitcherEntity, {
            defaultLabel: async lite => (await getToolbarSwitcher(lite)).name,
            isAuthorized: async lite => await UserAssetOwnerAuth.isVisible(await getToolbarSwitcher(lite)),
        });

        registerContentConfig(ToolbarEntity, {
            defaultLabel: async lite => (await getToolbar(lite)).name,
            isAuthorized: async lite => await UserAssetOwnerAuth.isVisible(await getToolbar(lite)),
        });

        registerContentConfig(QueryEntity, {
            // The registered QueryName is resolved through the query CONTAINER (`withQuery` registers
            // there — QueryLogic.toQueryName reads a legacy name-only registry nothing populates).
            defaultLabel: lite => getNiceName(queryNameOf(lite)!),
            isAuthorized: lite => isQueryAllowed(lite),
            getRelatedQuery: lite => QueryLogic.tryGetQueryEntityByKey(queryKeyOf(lite)) ?? null,
        });

        registerContentConfig(PermissionSymbol, {
            defaultLabel: lite => SymbolLogic.toSymbol(PermissionSymbol, symbolKeyOf(lite)).niceToString(),
            isAuthorized: async lite =>
                await PermissionAuthLogic.isAuthorized(SymbolLogic.toSymbol(PermissionSymbol, symbolKeyOf(lite))),
            // Signum sets this as a separate `GetContentConfig<PermissionSymbol>().CustomResponses = …`
            // assignment; folded into the registration here (altea's config is a plain object).
            customResponses: async lite => {
                const action = customPermissionResponse.get(symbolKeyOf(lite));
                return action == null ? null : await action();
            },
        });

        if (sb.webBuilder)
            ToolbarServer.start(sb.webBuilder);
    }

    // ---- Owner scoping (Signum's RegisterUserTypeCondition / RegisterRoleTypeCondition) ---------------
    //
    // Signum's `RegisterTypeCondition(sb, tc, ownerType, isAllowed)` registers the SAME predicate on all
    // three roots; altea's shared helper does one entity type per call, so each wrapper loops the three.
    // Signum's `AssertImplementedBy(t => t.Owner, ownerType)` is dropped (the list is on the field).

    /** Signum's `ToolbarLogic.RegisterUserTypeCondition` — the toolbar belongs to the current USER. */
    export function registerUserTypeCondition(typeCondition: TypeConditionSymbol): void {
        UserAssetOwnerAuth.registerUserTypeCondition(ToolbarEntity, typeCondition);
        UserAssetOwnerAuth.registerUserTypeCondition(ToolbarMenuEntity, typeCondition);
        UserAssetOwnerAuth.registerUserTypeCondition(ToolbarSwitcherEntity, typeCondition);
    }

    /** Signum's `ToolbarLogic.RegisterRoleTypeCondition` — global (no owner), or owned by one of the current
     *  user's roles. */
    export function registerRoleTypeCondition(typeCondition: TypeConditionSymbol): void {
        UserAssetOwnerAuth.registerRoleTypeCondition(ToolbarEntity, typeCondition);
        UserAssetOwnerAuth.registerRoleTypeCondition(ToolbarMenuEntity, typeCondition);
        UserAssetOwnerAuth.registerRoleTypeCondition(ToolbarSwitcherEntity, typeCondition);
    }

    // Signum ALSO has `RegisterAllowedTypeTypeCondition` + the `AllowedTypes` dictionary (a toolbar owned by
    // a "role" that stands for an app-defined capability). It has no consumer in Southwind and no altea
    // analogue for `Type.ToTypeEntity()`-keyed capability sets — DEFERRED, noted here where it belongs.

    // ---- Lookups (Signum's GetCurrent / GetCurrentToolbarResponse / GetToolbarMenuResponse) ------------

    /** Signum's `GetCurrent(location)`: the highest-priority toolbar of that location the current role may
     *  read. `location` arrives as the enum MEMBER NAME (the wire form). */
    export async function getCurrent(location: ToolbarLocation): Promise<ToolbarEntity | undefined> {
        const value = Enum.toValue(ToolbarLocationEnum, location);
        const all = await toolbarsLazy.value();
        const candidates = all
            .filter(t => (t.location as number) === value)
            .sort((a, b) => ((b.priority ?? 0) as number) - ((a.priority ?? 0) as number));

        return (await UserAssetOwnerAuth.filterVisible(candidates))[0];
    }

    /** Signum's `GetCurrentToolbarResponse(location)`: the whole tree for the current toolbar, or null when
     *  there is none / nothing in it survives authorization. The root is a synthetic Header carrying the
     *  toolbar itself, exactly as in Signum. */
    export async function getCurrentToolbarResponse(location: ToolbarLocation): Promise<ToolbarResponse | null> {
        const curr = await getCurrent(location);
        if (curr == null)
            return null;

        const responses = await toResponseList(curr.elements ?? []);
        if (responses.length === 0)
            return null;

        return {
            type: "Header",
            content: curr.toLite() as Lite<Entity>,
            label: curr.name,
            elements: responses,
        };
    }

    /** Signum's `GetToolbarMenuResponse(lite)`: one menu's tree (the client fetches a menu on demand — a
     *  dashboard's ToolbarMenuPart, a switcher option opened later). */
    export async function getToolbarMenuResponse(id: string): Promise<ToolbarResponse | null> {
        const all = await toolbarMenusLazy.value();
        const menu = all.find(m => String(m.id) === String(id));
        if (menu == null || !(await UserAssetOwnerAuth.isVisible(menu)))
            return null;

        const responses = await toResponseList(menu.elements ?? []);
        if (responses.length === 0)
            return null;

        return {
            type: "Header",
            content: menu.toLite() as Lite<Entity>,
            label: menu.name,
            elements: responses,
        };
    }

    // ---- The response builder (Signum's ToResponseList / ToResponse / IsPureHeader) -------------------

    /** Signum's `ToResponseList`: group each element with the ExtraIcons that trail it, map each group to
     *  its response(s), then repeatedly drop the dividers and headers left dangling by whatever was filtered
     *  out for authorization. */
    export async function toResponseList(elements: ToolbarElementBaseEntity[]): Promise<ToolbarResponse[]> {

        // `groupWhen(isKey, includeKeyInGroup: false, beforeFirstKey: "skip")` == Signum's
        // `GroupWhen(a => a.Type != ExtraIcon, BeforeFirstKey.Skip)`: an ExtraIcon before any real element is
        // dropped (the data-layer validation forbids it anyway).
        const groups = elements.groupWhen(e => typeOf(e) !== "ExtraIcon", false, "skip");

        const nested = await Promise.all(groups.map(gr => toResponse(gr.key, gr.elements)));
        const result = nested.notNull().flat();

        for (;;) {
            // A divider is superfluous when it is first, follows another divider, or is LAST.
            //
            // DIVERGENCE (bug fix): Signum's third condition reads `i == result.Count`, which can never hold
            // for an in-range index — so a TRAILING divider survives on the server (its client twin,
            // `simplifyForEntity`, tests `i == result.length - 1`). The intent is plainly the client's, so
            // that is what is implemented.
            const extraDividers = result.filter((a, i) => a.type === "Divider" && (
                i === 0 ||
                result[i - 1].type === "Divider" ||
                i === result.length - 1
            ));

            // A header with nothing under it (last, or immediately followed by another header / a divider /
            // a menu header) says nothing.
            const extraHeaders = result.filter((a, i) => isPureHeader(a) && (
                i === result.length - 1 ||
                isPureHeader(result[i + 1]) ||
                result[i + 1].type === "Divider" ||
                (result[i + 1].type === "Header" && result[i + 1].content?.entityType === ToolbarMenuEntity)
            ));

            if (extraDividers.length === 0 && extraHeaders.length === 0)
                return result;

            for (const r of [...extraDividers, ...extraHeaders]) {
                const i = result.indexOf(r);
                if (i >= 0)
                    result.splice(i, 1);
            }
        }
    }

    /** Signum's `IsPureHeader`. */
    function isPureHeader(tr: ToolbarResponse): boolean {
        return tr.type === "Header" && tr.content == null && !tr.url;
    }

    /** Signum's `ToResponse(gr)`: one element (+ its trailing ExtraIcons) → zero, one or many responses.
     *  Null = the element is not authorized (or is an empty container), and is dropped. */
    async function toResponse(
        element: ToolbarElementBaseEntity,
        extras: ToolbarElementBaseEntity[],
    ): Promise<ToolbarResponse[] | null> {

        let config: ToolbarContentConfig | undefined;
        if (element.content != null) {
            config = tryGetContentConfig(element.content);
            if (config == null)
                throw new Error(`Toolbar: no content config registered for '${element.content.entityType.name}'`);

            if (!(await config.isAuthorized(element.content)))
                return null;

            const customResponse = await config.customResponses?.(element.content);
            if (customResponse != null)
                return customResponse;
        }

        // A nested Toolbar is INLINED (its elements are spliced in place of the element).
        if (element.content?.entityType === ToolbarEntity) {
            const tb = await getToolbar(element.content as Lite<ToolbarEntity>);
            const res = await toResponseList(tb.elements ?? []);
            return res.length === 0 ? null : res;
        }

        const result: ToolbarResponse = {
            guid: element.guid,
            type: typeOf(element),
            content: element.content ?? undefined,
            url: element.url ?? undefined,
            label: element.label || (config == null ? undefined : await config.defaultLabel(element.content!)),
            iconName: element.iconName || (await config?.defaultIconName?.(element.content!)) || undefined,
            iconColor: element.iconColor || (await config?.defaultIconColor?.(element.content!)) || undefined,
            queryKey: (await config?.getRelatedQuery?.(element.content!))?.key ?? undefined,
            showCount: showCountOf(element),
            autoRefreshPeriod: (element.autoRefreshPeriod as number | null) ?? undefined,
            openInPopup: element.openInPopup,
            // Only a ToolbarMenu element carries these two (Signum: `(element as ToolbarMenuElementEmbedded)?
            // .AutoSelect == true`); on a Toolbar element they are simply absent.
            autoSelect: (element as { autoSelect?: boolean }).autoSelect === true,
            withEntity: (element as { withEntity?: boolean }).withEntity === true,
            extraIcons: extras.length === 0 ? undefined : await toExtraIcons(extras),
        };

        if (element.content?.entityType === ToolbarMenuEntity) {
            const menu = await getToolbarMenu(element.content as Lite<ToolbarMenuEntity>);
            result.entityType = await entityTypeCleanNameOf(menu);
            result.elements = await toResponseList(menu.elements ?? []);
            if (result.elements.length === 0)
                return null;
        }

        if (element.content?.entityType === ToolbarSwitcherEntity) {
            const switcher = await getToolbarSwitcher(element.content as Lite<ToolbarSwitcherEntity>);

            const options = await Promise.all((switcher.options ?? []).map(async o => {
                const menu = await getToolbarMenu(o.toolbarMenu);
                const conf = tryGetContentConfig(o.toolbarMenu as Lite<Entity>);
                if (conf == null || !(await conf.isAuthorized(o.toolbarMenu as Lite<Entity>)))
                    return null;

                const subElements = await toResponseList(menu.elements ?? []);
                if (subElements.length === 0)
                    return null;

                return {
                    type: "Item",
                    content: o.toolbarMenu as Lite<Entity>,
                    entityType: await entityTypeCleanNameOf(menu),
                    elements: subElements,
                    iconColor: o.iconColor ?? undefined,
                    iconName: o.iconName ?? undefined,
                    label: menu.name,
                } satisfies ToolbarResponse;
            }));

            result.elements = options.notNull();
            if (result.elements.length === 0)
                return null;
        }

        return [result];
    }

    /** The ExtraIcons trailing one element (Signum's inline `gr.Select(extra => …)` block). An extra icon
     *  never nests, and one pointing at a nested Toolbar is dropped (Signum returns null for that case). */
    async function toExtraIcons(extras: ToolbarElementBaseEntity[]): Promise<ToolbarResponse[]> {
        const list = await Promise.all(extras.map(async extra => {
            let config: ToolbarContentConfig | undefined;
            if (extra.content != null) {
                config = tryGetContentConfig(extra.content);
                if (config == null)
                    throw new Error(`Toolbar: no content config registered for '${extra.content.entityType.name}'`);
                if (!(await config.isAuthorized(extra.content)))
                    return null;
            }

            if (extra.content?.entityType === ToolbarEntity)
                return null;

            return {
                guid: extra.guid,
                type: typeOf(extra),
                content: extra.content ?? undefined,
                url: extra.url ?? undefined,
                label: extra.label || (config == null ? undefined : await config.defaultLabel(extra.content!)),
                iconName: extra.iconName || (await config?.defaultIconName?.(extra.content!)) || undefined,
                iconColor: extra.iconColor || (await config?.defaultIconColor?.(extra.content!)) || undefined,
                queryKey: (await config?.getRelatedQuery?.(extra.content!))?.key ?? undefined,
                showCount: showCountOf(extra),
                autoRefreshPeriod: (extra.autoRefreshPeriod as number | null) ?? undefined,
                openInPopup: extra.openInPopup,
            } satisfies ToolbarResponse;
        }));

        return list.notNull();
    }

    /** Signum's `GetEntityType(Lite<ToolbarMenuEntity>)` — the menu's entity type as its CLEAN NAME (what
     *  the client's `tryGetTypeInfo` / `Finder` speak). */
    async function entityTypeCleanNameOf(menu: ToolbarMenuEntity): Promise<string | undefined> {
        if (menu.entityType == null)
            return undefined;

        // The TypeEntity lite's toStr IS the clean name (altea's TypeLogic stamps it), so no extra read.
        const cleanName = menu.entityType.toString();
        return cleanName || undefined;
    }

    // ---- Cache reads (Signum's `Toolbars.Value.GetOrThrow(lite)` &c.) --------------------------------

    export async function getToolbar(lite: Lite<ToolbarEntity>): Promise<ToolbarEntity> {
        return fromCache(await toolbarsLazy.value(), lite, "Toolbar");
    }

    export async function getToolbarMenu(lite: Lite<ToolbarMenuEntity>): Promise<ToolbarMenuEntity> {
        return fromCache(await toolbarMenusLazy.value(), lite, "ToolbarMenu");
    }

    export async function getToolbarSwitcher(lite: Lite<ToolbarSwitcherEntity>): Promise<ToolbarSwitcherEntity> {
        return fromCache(await toolbarSwitchersLazy.value(), lite, "ToolbarSwitcher");
    }

    function fromCache<T extends Entity>(all: T[], lite: Lite<T>, name: string): T {
        const found = all.find(e => String(e.id) === String(lite.id));
        if (found == null)
            throw new Error(`${name} '${String(lite.id)}' not found`);
        return found;
    }

    // ---- The recursion check (Signum's IToolbar_Saving second half) ----------------------------------

    /** Signum's `DirectedGraph<IToolbarEntity>.Generate(tool, t => t.GetSubToolbars().Retrieve())` +
     *  `FeedbackEdgeSet()`: a toolbar may not (transitively) contain itself. Only reachable-from-`tool`
     *  roots are walked, and every referenced root comes from the caches. */
    export async function assertNoRecursion(tool: IToolbarEntity): Promise<void> {
        if (tool.isNew)
            return;

        const nodes: IToolbarEntity[] = [];
        const seen = new Set<string>();

        async function explore(node: IToolbarEntity): Promise<void> {
            const key = `${node.constructor.name};${String(node.id)}`;
            if (seen.has(key))
                return;
            seen.add(key);
            nodes.push(node);

            for (const sub of node.getSubToolbars()) {
                const subEntity = await retrieveToolbarish(sub);
                if (subEntity != null)
                    await explore(subEntity);
            }
        }

        await explore(tool);

        // Build the graph over the SAME node instances so the edges match by identity, then ask for the
        // feedback edge set — the edges that would have to be cut to make the graph acyclic.
        const byKey = new Map(nodes.map(n => [`${n.constructor.name};${String(n.id)}`, n]));
        const graphOfToolbars = DirectedGraph.generate(nodes, n => n.getSubToolbars()
            .map(l => byKey.get(`${l.entityType.name};${String(l.id)}`))
            .filter((n): n is IToolbarEntity => n != null));

        const problems = graphOfToolbars.feedbackEdgeSet().edges;
        if (problems.length > 0)
            throw new Error(
                ToolbarMessage._0CyclesHaveBeenFoundInTheToolbarDueToTheRelationships.niceToString(problems.length) +
                "\n" + problems.map(e => `${e.from.toString()} -> ${e.to.toString()}`).join("\n"));
    }

    /** The cached root behind a sub-toolbar lite (the graph walk never touches the DB). `undefined` when the
     *  lite points at a root that no longer exists — a dangling reference is not a cycle. */
    async function retrieveToolbarish(lite: Lite<Entity>): Promise<IToolbarEntity | undefined> {
        const id = String(lite.id);
        if (lite.entityType === ToolbarEntity)
            return (await toolbarsLazy.value()).find(t => String(t.id) === id);
        if (lite.entityType === ToolbarMenuEntity)
            return (await toolbarMenusLazy.value()).find(t => String(t.id) === id);
        if (lite.entityType === ToolbarSwitcherEntity)
            return (await toolbarSwitchersLazy.value()).find(t => String(t.id) === id);
        return undefined;
    }

    // ---- RegisterDelete (Signum's ToolbarLogic.RegisterDelete<T>) ------------------------------------

    /** Signum's `RegisterDelete<T>`: when a T that toolbar elements may point at is deleted, the elements
     *  pointing at it must go too (Signum wrote SQL-sync cascades; see the header note).
     *
     *  altea: hangs off the `preUnsafeDelete` event of T — the one hook that fires before a set-based delete
     *  — and deletes the orphaned `@part` element / option ROWS. Registered for the four content types
     *  Signum registers; a module that adds a content type calls it too (see altea-user-queries). */
    /** The concrete types a toolbar element's `content` may point at — the `@implementedBy` list on
     *  ToolbarElementBaseEntity.content, which both element tables inherit and the app widens. */
    export function contentTypeInfos(): TypeInfo[] {
        const contentFi = getTypeInfo(ToolbarEntity_Element)?.fields["content"];
        return contentFi?.typeInfos() ?? [];
    }

    export function registerDelete<T extends Entity>(sb: SchemaBuilder, type: Type<T>): void {
        sb.schema.entityEvents(type).preUnsafeDelete.push(async query => {
            const doomed = (await query.map(e => e.id).toArray()) as unknown[];
            if (doomed.length === 0)
                return;

            const ids = new Set(doomed.map(id => String(id)));

            // The element rows of BOTH owners (a Toolbar element and a ToolbarMenu element), plus a
            // switcher option when the deleted type is a ToolbarMenu.
            await deleteElementsPointingAt(ids, type);
        });
    }

    async function deleteElementsPointingAt(ids: Set<string>, type: Type<Entity>): Promise<void> {
        const toolbars = await toolbarsLazy.value();
        const menus = await toolbarMenusLazy.value();
        const switchers = await toolbarSwitchersLazy.value();

        const points = (lite: Lite<Entity> | null): boolean =>
            lite != null && lite.entityType === type && ids.has(String(lite.id));

        const doomedElements: Entity[] = [
            ...toolbars.flatMap(t => (t.elements ?? []).filter(e => points(e.content))),
            ...menus.flatMap(m => (m.elements ?? []).filter(e => points(e.content))),
        ];

        if (type === ToolbarMenuEntity)
            doomedElements.push(...switchers.flatMap(s =>
                (s.options ?? []).filter(o => o.toolbarMenu != null && ids.has(String(o.toolbarMenu.id)))));

        if (doomedElements.length > 0)
            await deleteList(doomedElements);
    }

    // ---- Small helpers ------------------------------------------------------------------------------

    /** Signum's `IsQueryAllowed(lite)` — tolerant of a query row that no longer matches a registered query
     *  (Signum swallowed the mismatch into StartParameters.IgnoredDatabaseMismatches). */
    async function isQueryAllowed(lite: Lite<QueryEntity>): Promise<boolean> {
        const queryName = queryNameOf(lite);
        if (queryName == null)
            return false;

        return await QueryAuthLogic.isQueryAllowed(queryName, true);
    }

    /** Signum's `InMemoryFilter<T>(entity)` — kept for the modules that call it from their own content
     *  config (Signum's UserQueryLogic / UserChartLogic / DashboardLogic do). */
    export async function inMemoryFilter<T extends Entity>(entity: T): Promise<boolean> {
        return await UserAssetOwnerAuth.isVisible(entity);
    }
}

// A QueryEntity lite's toStr is its `key` (see data/queryEntity.ts); a Symbol lite's toStr is its `key`
// (data/symbol.ts) — Signum read both the same way (`lite.ToString()!`).
/** The registered QueryName behind a `Lite<QueryEntity>`, or undefined when this database has a query row
 *  no longer matching a registered query (Signum swallowed that mismatch into IgnoredDatabaseMismatches).
 *  Resolved through the query CONTAINER — `withQuery` registers there, not in QueryLogic's legacy
 *  name-only `queryNamesByKey` (which is what `toQueryName` reads). */
function queryNameOf(lite: Lite<QueryEntity>): QueryName | undefined {
    return QueryLogic.tryGetQueryNameByKey(queryKeyOf(lite));
}

function queryKeyOf(lite: Lite<QueryEntity>): string {
    return lite.toString();
}

function symbolKeyOf(lite: Lite<Entity>): string {
    return lite.toString();
}

/** An element's type as its wire NAME (the stored value is the ordinal). */
function typeOf(e: ToolbarElementBaseEntity): ToolbarElementType {
    return Enum.toName(ToolbarElementTypeEnum, e.type);
}

function showCountOf(e: ToolbarElementBaseEntity): ShowCount | undefined {
    return e.showCount == null ? undefined : Enum.toName(ShowCountEnum, e.showCount);
}
