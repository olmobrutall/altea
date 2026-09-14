import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/fluentOperations"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import "@altea/altea/data/globals/arrayExtensions"; // groupWhen / notNull / firstOrNull / …
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { deleteList } from "@altea/altea/server/Database";
import { DirectedGraph } from "@altea/altea/server/directedGraph";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { getNiceName, type QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import type { ResetLazy } from "@altea/altea/server/resetLazy";
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
import { UserAssetLogic } from "@altea/altea-user-assets/server/UserAssetLogic";
import { UserAssetOwnerAuth } from "@altea/altea-user-assets/server/UserAssetOwnerAuth";
import {
    ToolbarEntity, ToolbarMenuEntity, ToolbarSwitcherEntity, ToolbarEntity_Element, ToolbarOperation, ToolbarMenuOperation,
    ToolbarSwitcherOperation, ToolbarElementType, ToolbarLocation, ShowCount, ToolbarMessage,
    type ToolbarLocationKeys, type ToolbarElementTypeKeys, type ShowCountKeys, type IToolbarEntity,
    type ToolbarElementBaseEntity,
} from "../data/Toolbar";
import type { ToolbarResponse } from "../data/ToolbarResponse";
import { registerToolbarXml } from "./ToolbarXml";
import { ToolbarServer } from "./ToolbarServer";

// Port of Signum.Toolbar's ToolbarLogic.cs — see port/Toolbar.md.
//
// Registers the three toolbar entities + their Save / Delete operations + queries, their in-memory caches,
// the XML (de)serializers, the CONTENT CONFIG registry other modules extend, and — when a web host is
// present — the HTTP surface. Its heart is `toResponseList`: turning the stored elements into the
// authorization-filtered, label-resolved ToolbarResponse tree the renderers draw.
//
// WHERE THE CHECKS RUN: the `saving` event is SYNCHRONOUS (no sync DB access) and the recursion check must
// READ the referenced toolbars — so the element checks are owner-level `@validate`s (data/Toolbar.ts, they
// need no DB) and the recursion check runs in the Save operation's `execute` below. Every save goes through
// that operation, the XML importer included, so the coverage is the same.
//
// Visibility goes through `UserAssetOwnerAuth.filterVisible` — async, since a condition may need DB-filling
// — applied by each LOOKUP, because the caches are filled in ExecutionMode.global where the row-level query
// filter never ran. The response builder is async throughout for the same reason.

// ---- The content-config registry -----------------------------------------------------------------------

/** Everything the response builder needs to know about ONE kind of element content: may this role use it,
 *  what does it show when the element names no label / icon of its own, which query does it ultimately run,
 *  and (for a permission) does it expand into a whole block of synthetic responses. Every callback is
 *  async, because authorization is.
 *
 *  A module registers the config for its own asset from its own `XxxLogic.start` — see altea-user-queries /
 *  altea-chart / altea-dashboard. */
export interface ToolbarContentConfig<T extends Entity = Entity> {
    /** Required. */
    isAuthorized(lite: Lite<T>): Promise<boolean>;
    /** Required. */
    defaultLabel(lite: Lite<T>): Promise<string> | string;
    defaultIconName?(lite: Lite<T>): Promise<string | null> | string | null;
    defaultIconColor?(lite: Lite<T>): Promise<string | null> | string | null;
    /** Replace this ONE element with a list of synthetic ones (used by
     *  `customPermissionResponse` — a permission that stands for a whole generated block). */
    customResponses?(lite: Lite<T>): Promise<ToolbarResponse[] | null> | ToolbarResponse[] | null;
    /** The query this content runs, for the client's per-entity filtering. */
    getRelatedQuery?(lite: Lite<T>): Promise<QueryEntity | null> | QueryEntity | null;
}

// Keyed by the CONTENT
// entity ctor (altea's Lite carries the ctor in `entityType`, so no clean-name detour is needed).
const contentConfigs = new Map<Function, ToolbarContentConfig>();

export namespace ToolbarLogic {

    // ARRAYS rather than dictionaries keyed by lite: the lookups are by id or by predicate, and a Lite is
    // not a value key in JS — as in DashboardLogic.dashboardsLazy.
    export let toolbarsLazy: ResetLazy<ToolbarEntity[]> = null!;
    export let toolbarMenusLazy: ResetLazy<ToolbarMenuEntity[]> = null!;
    export let toolbarSwitchersLazy: ResetLazy<ToolbarSwitcherEntity[]> = null!;

    /** A permission symbol whose element expands into a generated
     *  block of responses (the app registers the generator). Keyed by the permission KEY. */
    export const customPermissionResponse = new Map<string, () => Promise<ToolbarResponse[]> | ToolbarResponse[]>();

    export function registerContentConfig<T extends Entity>(type: Type<T>, config: ToolbarContentConfig<T>): void {
        contentConfigs.set(type, config);
    }

    export function getContentConfig<T extends Entity>(type: Type<T>): ToolbarContentConfig<T> {
        const c = contentConfigs.get(type);
        if (c == null)
            throw new Error(`Toolbar: no content config registered for '${type.name}'`);
        return c;
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
        // false), which is where the recursion check rides — see the header note.
        sb.include(ToolbarEntity)
            .withSave(ToolbarOperation.Save, { execute: tb => ToolbarLogic.assertNoRecursion(tb) })
            .withDelete(ToolbarOperation.Delete)
            .withQuery();

        sb.include(ToolbarMenuEntity)
            .withSave(ToolbarMenuOperation.Save, { execute: tm => ToolbarLogic.assertNoRecursion(tm) })
            .withDelete(ToolbarMenuOperation.Delete)
            .withQuery();

        sb.include(ToolbarSwitcherEntity)
            .withSave(ToolbarSwitcherOperation.Save, { execute: ts => ToolbarLogic.assertNoRecursion(ts) })
            .withDelete(ToolbarSwitcherOperation.Delete)
            .withQuery();

        // Nothing asserts the content implementations: the list is declared ON the field (`@implementedBy`
        // in data/Toolbar.ts) and the app widens it.
        //
        // MISSING: `AuthLogic.hasRuleOverrides` (does this role own any toolbar?) has no hook yet; when one
        // lands, add the Toolbar / ToolbarMenu owner probe here.

        // How the three roots are (de)serialized to / from XML + which Save operation the importer runs.
        registerToolbarXml();

        // The caches behind every response lookup. A plain table read is enough:
        // EVERY query is completed by EntityCompleter (QueryBinder.bindQuery), whose visitFieldEntityArray
        // realises each @part collection as a correlated child projection — so each root arrives with its
        // element / option rows, exactly as `retrieve` would deliver them.
        toolbarsLazy = sb.globalLazy(async () =>
            await table(ToolbarEntity).toArray() as ToolbarEntity[],
            { invalidateWith: [ToolbarEntity] });

        toolbarMenusLazy = sb.globalLazy(async () =>
            await table(ToolbarMenuEntity).toArray() as ToolbarMenuEntity[],
            { invalidateWith: [ToolbarMenuEntity] });

        toolbarSwitchersLazy = sb.globalLazy(async () =>
            await table(ToolbarSwitcherEntity).toArray() as ToolbarSwitcherEntity[],
            { invalidateWith: [ToolbarSwitcherEntity] });

        // Driven off the CONTENT field's `@implementedBy` list, which the app has already widened by the
        // time any Logic.start runs (EntityOverrides.start precedes the schema build) — so every content
        // type is covered with no per-module call and no ordering hazard.
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
            defaultLabel: async lite =>
                (await SymbolLogic.cache(PermissionSymbol)).toSymbol(symbolKeyOf(lite)).niceToString(),
            isAuthorized: async lite =>
                await PermissionAuthLogic.isAuthorized((await SymbolLogic.cache(PermissionSymbol)).toSymbol(symbolKeyOf(lite))),
            customResponses: async lite => {
                const action = customPermissionResponse.get(symbolKeyOf(lite));
                return action == null ? null : await action();
            },
        });

        if (sb.webBuilder)
            ToolbarServer.start(sb.webBuilder);
    }

    // ---- Owner scoping --------------------------------------------------------------------------------
    //
    // The SAME predicate on all three roots; the shared helper does one entity type per call, so each
    // wrapper loops them.

    /** The toolbar belongs to the current USER. */
    export function registerUserTypeCondition(typeCondition: TypeConditionSymbol): void {
        UserAssetOwnerAuth.registerUserTypeCondition(ToolbarEntity, typeCondition);
        UserAssetOwnerAuth.registerUserTypeCondition(ToolbarMenuEntity, typeCondition);
        UserAssetOwnerAuth.registerUserTypeCondition(ToolbarSwitcherEntity, typeCondition);
    }

    /** Global (no owner), or owned by one of the current
     *  user's roles. */
    export function registerRoleTypeCondition(typeCondition: TypeConditionSymbol): void {
        UserAssetOwnerAuth.registerRoleTypeCondition(ToolbarEntity, typeCondition);
        UserAssetOwnerAuth.registerRoleTypeCondition(ToolbarMenuEntity, typeCondition);
        UserAssetOwnerAuth.registerRoleTypeCondition(ToolbarSwitcherEntity, typeCondition);
    }

    // DEFERRED, noted where it belongs: `registerAllowedTypeTypeCondition` + an `allowedTypes` dictionary
    // (a toolbar owned by a "role" that stands for an app-defined capability). It has no consumer in
    // Southwind and no analogue here for capability sets keyed by type.

    // ---- Lookups ---------------------------------------------------------------------------------------

    /** The highest-priority toolbar of that location the current role may
     *  read. `location` arrives as the enum MEMBER NAME (the wire form). */
    export async function getCurrent(location: ToolbarLocationKeys): Promise<ToolbarEntity | undefined> {
        const value = Enum.toValue(ToolbarLocation, location);
        const all = await toolbarsLazy.value();
        const candidates = all
            .filter(t => (t.location as number) === value)
            .sort((a, b) => ((b.priority ?? 0) as number) - ((a.priority ?? 0) as number));

        return (await UserAssetOwnerAuth.filterVisible(candidates))[0];
    }

    /** The whole tree for the current toolbar, or null when
     *  there is none / nothing in it survives authorization. The root is a synthetic Header carrying the
     *  toolbar itself. */
    export async function getCurrentToolbarResponse(location: ToolbarLocationKeys): Promise<ToolbarResponse | null> {
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

    /** One menu's tree (the client fetches a menu on demand — a
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

    // ---- The response builder --------------------------------------------------------------------------

    /** Group each element with the ExtraIcons that trail it, map each group to
     *  its response(s), then repeatedly drop the dividers and headers left dangling by whatever was filtered
     *  out for authorization. */
    export async function toResponseList(elements: ToolbarElementBaseEntity[]): Promise<ToolbarResponse[]> {

        // An ExtraIcon before any real element is DROPPED (the data-layer validation forbids one anyway).
        const groups = elements.groupWhen(e => typeOf(e) !== "ExtraIcon", false, "skip");

        const nested = await Promise.all(groups.map(gr => toResponse(gr.key, gr.elements)));
        const result = nested.notNull().flat();

        for (;;) {
            // A divider is superfluous when it is first, follows another divider, or is LAST.
            //
            // The third condition is `i === result.length - 1`, matching the client's `simplifyForEntity`.
            // (Signum's server reads `i == result.Count`, which can never hold for an in-range index, so a
            // TRAILING divider survives there. Do not "restore" it.)
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

    function isPureHeader(tr: ToolbarResponse): boolean {
        return tr.type === "Header" && tr.content == null && !tr.url;
    }

    /** One element (+ its trailing ExtraIcons) → zero, one or many responses.
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
            guid: element.id == null ? undefined : String(element.id),
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
            // Only a ToolbarMenu element carries these two; on a Toolbar element they are simply absent.
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

    /** The ExtraIcons trailing one element. An extra icon never nests, and one pointing at a nested Toolbar
     *  is dropped. */
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
                guid: extra.id == null ? undefined : String(extra.id),
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

    /** The menu's entity type as its CLEAN NAME (what
     *  the client's `tryGetTypeInfo` / `Finder` speak). */
    async function entityTypeCleanNameOf(menu: ToolbarMenuEntity): Promise<string | undefined> {
        if (menu.entityType == null)
            return undefined;

        // The TypeEntity lite's toStr IS the clean name (altea's TypeLogic stamps it), so no extra read.
        const cleanName = menu.entityType.toString();
        return cleanName || undefined;
    }

    // ---- Cache reads -----------------------------------------------------------------------------------

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

    // ---- The recursion check --------------------------------------------------------------------------

    /** A toolbar may not (transitively) contain itself. Only roots reachable from `tool` are walked, and
     *  every referenced root comes from the caches. */
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

    // ---- registerDelete -------------------------------------------------------------------------------

    /** When a T that toolbar elements may point at is deleted, the elements pointing at it must go too.
     *
     *  Hangs off the `preUnsafeDelete` event of T — the one hook that fires before a set-based delete — and
     *  deletes the orphaned `@part` element / option ROWS. A module that adds a content type calls it too
     *  (see altea-user-queries). */
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

    /** Tolerant of a query row that no longer matches a registered query
     *  no longer matching a registered query. */
    async function isQueryAllowed(lite: Lite<QueryEntity>): Promise<boolean> {
        const queryName = queryNameOf(lite);
        if (queryName == null)
            return false;

        return await QueryAuthLogic.isQueryAllowed(queryName, true);
    }

    /** Kept for the modules that call it from their own content config. */
    export async function inMemoryFilter<T extends Entity>(entity: T): Promise<boolean> {
        return await UserAssetOwnerAuth.isVisible(entity);
    }
}

// A QueryEntity lite's toStr is its `key` (see data/queryEntity.ts), and so is a Symbol lite's
// (data/symbol.ts) — hence one spelling for both.
/** The registered QueryName behind a `Lite<QueryEntity>`, or undefined when this database has a query row
 *  no longer matching a registered query. Resolved through the query CONTAINER — `withQuery` registers there, not in QueryLogic's legacy
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
function typeOf(e: ToolbarElementBaseEntity): ToolbarElementTypeKeys {
    return Enum.toName(ToolbarElementType, e.type);
}

function showCountOf(e: ToolbarElementBaseEntity): ShowCountKeys | undefined {
    return e.showCount == null ? undefined : Enum.toName(ShowCount, e.showCount);
}
