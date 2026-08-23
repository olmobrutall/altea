import "@altea/altea/data/globals/arrayExtensions";
import "@altea/altea/data/globals/stringExtensions";
import * as React from "react";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import * as AppContext from "@altea/altea/client/AppContext";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { Operations, EntityOperationSettings } from "@altea/altea/client/Operations";
import { QueryString } from "@altea/altea/client/QueryString";
import { LiteAutocompleteConfig } from "@altea/altea/client/Lines/AutoCompleteConfig";
import SearchControlLoaded from "@altea/altea/client/SearchControl/SearchControlLoaded";
import { tryGetTypeInfo, getOperationInfos, getTypeName, type TypeInfo } from "@altea/altea/client/Reflection";
import { getRegisteredTypes } from "@altea/altea/data/registration";
import type { QueryToken } from "@altea/altea/client/QueryToken";
import type {
    ColumnOption, ColumnOptionParsed, ColumnOptionsMode, FilterOption, FilterOptionParsed,
    FindOptions, FindOptionsParsed,
} from "@altea/altea/client/FindOptions";
import type { ColumnRequest, FilterRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import type { Entity, Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { OmniboxClient } from "@altea/altea-omnibox/client/OmniboxClient";
import { DashboardClient } from "@altea/altea-dashboard/client/DashboardClient";
import { UserQueriesClient } from "@altea/altea-user-queries/client/UserQueriesClient";
import {
    InsertPlace, MoveTreeModel, TreeEntity, TreeMessage, TreeOperation, UserTreePartEntity,
    type FindNodesRequest, type FindNodesResponse, type GetNodeRequest, type TreeNode,
} from "../data/Tree";
import TreeOmniboxProvider from "./TreeOmniboxProvider";
import TreeButton from "./TreeButton";

// Port of Signum.Tree's TreeClient.tsx — the module's client registration, the tree-page URL helpers, the
// per-type opt-ins a tree wants (autocomplete, default order, "Find opens the tree"), and the API calls.
//
// altea divergences:
//  - **`QueryDescription` → the query's ROOT TOKEN.** Every `Finder.parseFindOptions` / `toFindOptions`
//    call takes a `QueryToken` here (altea has no QueryDescription — see CLAUDE.md), so
//    `Finder.getQueryRoot(typeName)` replaces `Finder.getQueryDescription(typeName)` throughout.
//  - **`isTree` asks the metadata blob, not the TypeInfo.** altea's client TypeInfo carries no
//    `operations` (they are per-role), so a tree type is one that has the CreateNextSibling operation
//    according to `getOperationInfos`.
//  - `hideSiblingsAndIsDisabled` becomes `hideTreeInternals`: there is no DisabledMixin to hide (see
//    server/TreeLogic), and altea's non-visible flag lives on the reflected FieldInfo.
export namespace TreeClient {

    export function start(cb: ClientBuilder): void {

        cb.routes.push(
            { path: "/tree/:typeName", element: <ImportComponent onImport={() => import("./TreePage")} /> },
        );

        cb.configure(MoveTreeModel).withView(() => import("./Templates/MoveTreeModel"));
        cb.configure(UserTreePartEntity).withView(() => import("./Dashboard/UserTreePartAdmin"));

        OmniboxClient.registerProvider(new TreeOmniboxProvider());

        Operations.addSettings(
            // Both "add" operations only make sense from a LIST (the tree itself, or a search control) —
            // never from an open entity's button bar.
            new EntityOperationSettings(TreeOperation.CreateChild, {
                contextual: { isVisible: ctx => ctx.context.container instanceof SearchControlLoaded },
            }),
            new EntityOperationSettings(TreeOperation.CreateNextSibling, {
                contextual: { isVisible: ctx => ctx.context.container instanceof SearchControlLoaded },
            }),
            new EntityOperationSettings(TreeOperation.Move, {
                onClick: ctx => moveModal(ctx.entity.toLite()).then(m => m && ctx.defaultClick(m)),
                contextual: { onClick: ctx => moveModal(ctx.context.lites[0]).then(m => m && ctx.defaultClick(m)) },
            }),
            new EntityOperationSettings(TreeOperation.Copy, {
                onClick: ctx => copyModal(ctx.entity.toLite()).then(m => {
                    if (m) {
                        ctx.onConstructFromSuccess = () => { Operations.notifySuccess(); return Promise.resolve(); };
                        ctx.defaultClick(m);
                    }
                }),
                contextual: {
                    onClick: ctx => copyModal(ctx.context.lites[0]).then(m => {
                        if (m) {
                            // ALTEA: Signum's handler is `Operations.notifySuccess()` alone — replacing the
                            // default success path (which would NAVIGATE to the copy) also drops its
                            // row-marking, so in Signum a copy leaves the tree showing the old forest until
                            // the user presses Search. `markRows` here is the viewer's own `search(false)`.
                            ctx.onConstructFromSuccess = () => {
                                Operations.notifySuccess();
                                ctx.context.markRows({});
                                return Promise.resolve();
                            };
                            ctx.defaultClick(m);
                        }
                    }),
                },
            }),
        );

        // The "tree" button on a tree type's search control.
        Finder.ButtonBarQuery.onButtonBarElements.push(ctx => {
            const ti = tryGetTypeInfo(ctx.findOptions.queryKey);

            if (ti == null || !isTree(ti) || !ctx.searchControl.props.showBarExtension)
                return undefined;

            return { button: <TreeButton searchControl={ctx.searchControl} /> };
        });

        DashboardClient.registerRenderer(UserTreePartEntity, {
            component: () => import("./Dashboard/UserTreePart").then(a => a.default),
            icon: () => ({ icon: "sitemap", iconColor: "#B7950B" }),
            withPanel: () => true,
            defaultTitle: c => c.userQuery?.displayName ?? "",
            getQueryNames: c => c.userQuery == null ? [] : [c.userQuery.query.key],
            handleTitleClick: (c, e, _cdRef, ev) => {
                UserQueriesClient.Converter.toFindOptions(c.userQuery, e)
                    .then(fo => AppContext.pushOrOpenInTab(Finder.findOptionsPath(fo), ev));
            },
        });
    }

    // ---- move / copy modals ----------------------------------------------------------------------

    function moveModal(lite: Lite<TreeEntity>): Promise<MoveTreeModel | undefined> {
        const s = settings[lite.entityType.name];
        if (s?.createMoveModel)
            return s.createMoveModel(lite, {});

        return Navigator.view(MoveTreeModel.create({ insertPlace: InsertPlace.LastNode }), {
            title: TreeMessage.Move0.niceToString(lite.toString()),
            modalSize: "md",
            extraProps: { lite },
        }) as Promise<MoveTreeModel | undefined>;
    }

    function copyModal(lite: Lite<TreeEntity>): Promise<MoveTreeModel | undefined> {
        const s = settings[lite.entityType.name];
        if (s?.createCopyModel)
            return s.createCopyModel(lite, {});

        return Navigator.view(MoveTreeModel.create({ insertPlace: InsertPlace.LastNode }), {
            title: TreeMessage.Copy0.niceToString(lite.toString()),
            modalSize: "md",
            extraProps: { lite },
        }) as Promise<MoveTreeModel | undefined>;
    }

    // ---- tree options ⇄ find options -------------------------------------------------------------
    // A tree page IS a search with a different renderer, so its URL is a search URL with `/find/` swapped
    // for `/tree/` — which keeps every filter and column shareable between the two views.

    export interface TreeOptions {
        typeName: string;
        filterOptions?: (FilterOption | null | undefined)[];
        columnOptions?: (ColumnOption | null | undefined)[];
        columnOptionsMode?: ColumnOptionsMode;
    }

    export interface TreeOptionsParsed {
        typeName: string;
        filterOptions: FilterOptionParsed[];
        columnOptions: ColumnOptionParsed[];
    }

    export function treePath(to: TreeOptions): string {
        return Finder.findOptionsPath(toFindOptions(to)).replace("/find/", "/tree/");
    }

    export function toFindOptions(to: TreeOptions): FindOptions {
        return {
            queryName: to.typeName,
            filterOptions: to.filterOptions,
            columnOptions: to.columnOptions,
            columnOptionsMode: to.columnOptionsMode,
        } as FindOptions;
    }

    export function toFindOptionsParsed(top: TreeOptionsParsed): FindOptionsParsed {
        return {
            queryKey: top.typeName,
            groupResults: false,
            filterOptions: top.filterOptions,
            columnOptions: top.columnOptions,
            orderOptions: [],
            pagination: Finder.getSettings(top.typeName)?.pagination ?? Finder.Options.defaultPagination,
        } as FindOptionsParsed;
    }

    export function toTreeOptions(top: TreeOptionsParsed, queryToken: QueryToken): TreeOptions {
        const fo = Finder.toFindOptions(toFindOptionsParsed(top), queryToken, false);

        return {
            typeName: fo.queryName as string,
            filterOptions: fo.filterOptions,
            columnOptions: fo.columnOptions,
            columnOptionsMode: fo.columnOptionsMode,
        } as TreeOptions;
    }

    export function parseTreeOptions(to: TreeOptions, queryToken: QueryToken): Promise<TreeOptionsParsed> {
        return Finder.parseFindOptions(toFindOptions(to), queryToken, false).then(fop => ({
            typeName: fop.queryKey,
            filterOptions: fop.filterOptions,
            columnOptions: fop.columnOptions,
        } as TreeOptionsParsed));
    }

    export function parseTreeOptionsPath(typeName: string, query: Record<string, string>): TreeOptions {
        const fo = Finder.parseFindOptionsPath(typeName, query);

        return {
            typeName: fo.queryName as string,
            filterOptions: fo.filterOptions,
            columnOptions: fo.columnOptions,
            columnOptionsMode: fo.columnOptionsMode,
        } as TreeOptions;
    }

    // ---- per-type opt-ins ------------------------------------------------------------------------

    /**
     * ALTEA: a TypeInfo carries no `name` (it is the compile-time descriptor; the name lives on the
     * constructor it describes), so every `ti.name` of Signum's becomes this.
     */
    function nameOf(ti: TypeInfo): string {
        return getTypeName(ti.ctor as Type<Entity>);
    }

    /** Whether a type is a tree — it has the CreateNextSibling operation (Signum's same test). */
    export function isTree(ti: TypeInfo): boolean {
        return getOperationInfos(nameOf(ti)).some(o => o.key === TreeOperation.CreateNextSibling.key);
    }

    /**
     * ALTEA: there is no client "every TypeInfo" enumerator (Signum has `getAllTypes()`), so the
     * registered CONSTRUCTORS are walked and their TypeInfos resolved.
     */
    export function getAllTreeTypes(): TypeInfo[] {
        return getRegisteredTypes()
            .map(t => tryGetTypeInfo(t))
            .filter(ti => ti != undefined && isTree(ti)) as TypeInfo[];
    }

    /**
     * Signum's `hideSiblingsAndIsDisabled` — the two positioning fields are an implementation detail of
     * the Save operation, so a generated view must not show them. ALTEA: no DisabledMixin to hide either
     * (see server/TreeLogic), and `route` / `parentRoute` / `level` are hidden too, which Signum does not
     * need to do (its Route is `[InTypeScript(false)]`, i.e. never reaches the client at all).
     */
    export function hideTreeInternals(ti: TypeInfo): void {
        for (const name of ["parentOrSibling", "isSibling", "route", "parentRoute", "level", "fullName"]) {
            const fi = ti.fields[name];
            if (fi != undefined && fi.notVisible == undefined)
                fi.notVisible = true;
        }
    }

    /** Signum's `overrideOnFind` — pressing Find on a tree-typed line opens the TREE, not a search modal. */
    export function overrideOnFind(ti: TypeInfo): void {
        const typeName = nameOf(ti);
        const qs = getQuerySettings(typeName);

        qs.onFind ??= (fo, mo) => openTree({
            typeName,
            filterOptions: fo.filterOptions,
            columnOptions: fo.columnOptions,
            columnOptionsMode: fo.columnOptionsMode,
        }, { title: mo?.title });
    }

    export function overrideAutocomplete(ti: TypeInfo): void {
        const typeName = nameOf(ti);
        const es = Navigator.getOrAddSettings(typeName);

        es.autocomplete ??= fo => fo
            ? null
            : new LiteAutocompleteConfig((signal, str) => API.findLiteLikeByName(typeName, str, 5, signal));

        es.autocompleteDelay ??= 750;
    }

    export function overrideDefaultOrder(ti: TypeInfo): void {
        const qs = getQuerySettings(nameOf(ti));
        qs.defaultOrders ??= [{ token: "fullName", orderType: "Ascending" }];
    }

    /** Every opt-in at once — what a host calls per tree type from its client start. */
    export function configure(ti: TypeInfo): void {
        hideTreeInternals(ti);
        overrideOnFind(ti);
        overrideAutocomplete(ti);
        overrideDefaultOrder(ti);
    }

    function getQuerySettings(typeName: string) {
        let qs = Finder.getSettings(typeName);
        if (qs == undefined) {
            qs = { queryName: typeName };
            Finder.addSettings(qs);
        }
        return qs;
    }

    // ---- the modal -------------------------------------------------------------------------------

    export interface TreeModalOptions {
        title?: React.ReactNode;
        excludedNodes?: Lite<TreeEntity>[];
    }

    export function openTree(to: TreeOptions, options?: TreeModalOptions): Promise<Lite<TreeEntity> | undefined> {
        return import("./TreeModal").then(TM => TM.default.open(to, options));
    }

    // ---- per-type hooks --------------------------------------------------------------------------

    export interface TreeSettings<T extends TreeEntity> {
        createCopyModel?: (from: T | Lite<T>, dropConfig: Partial<MoveTreeModel>) => Promise<MoveTreeModel | undefined>;
        createMoveModel?: (from: T | Lite<T>, dropConfig: Partial<MoveTreeModel>) => Promise<MoveTreeModel | undefined>;
        dragTargetIsValid?: (draggedNode: TreeNode, targetNode: TreeNode | null) => Promise<boolean>;
    }

    export const settings: { [typeName: string]: TreeSettings<TreeEntity> } = {};

    export function register<T extends TreeEntity>(type: Type<T>, setting: TreeSettings<T>): void {
        settings[type.name] = setting as TreeSettings<TreeEntity>;
    }

    // ---- node state ------------------------------------------------------------------------------

    /**
     * Signum's `fixState` — the server sends the forest but cannot know what the user expanded, so the
     * per-node state is derived here: no children at all → Leaf; none loaded → Collapsed; all loaded →
     * Expanded; SOME loaded → Filtered (the icon that says "there is more under here than the search
     * matched").
     */
    export function fixState(node: TreeNode): void {
        node.nodeState = node.childrenCount === 0 ? "Leaf"
            : node.loadedChildren.length === 0 ? "Collapsed"
                : Number(node.childrenCount) === node.loadedChildren.length ? "Expanded"
                    : "Filtered";

        node.loadedChildren.forEach(fixState);
    }

    // ---- API -------------------------------------------------------------------------------------

    export namespace API {

        export function findLiteLikeByName(
            typeName: string,
            subString: string,
            count: number,
            abortSignal?: AbortSignal,
        ): Promise<Lite<TreeEntity>[]> {
            // ALTEA: the pattern is a QUERY parameter (Signum puts it in the path, which breaks on a '/').
            return ajaxGet({
                url: `/api/tree/findLiteLikeByName/${typeName}?` + QueryString.stringify({ q: subString, count }),
                signal: abortSignal,
            });
        }

        export function findNodes(typeName: string, request: FindNodesRequest): Promise<FindNodesResponse> {
            return ajaxPost<FindNodesResponse>({ url: `/api/tree/findNodes/${typeName}` }, request)
                .then(response => {
                    response.nodes.forEach(fixState);
                    return response;
                });
        }

        export function getNode(typeName: string, request: GetNodeRequest): Promise<TreeNode> {
            return ajaxPost<TreeNode>({ url: `/api/tree/getNode/${typeName}` }, request);
        }
    }

    /** The two request shapes, re-exported with their altea wire types bound. */
    export type TreeFilterRequest = FilterRequest;
    export type TreeColumnRequest = ColumnRequest;
}

// The tree button asks the search control whether to show itself (Signum's same augmentation).
declare module "@altea/altea/client/SearchControl/SearchControlLoaded" {
    interface ShowBarExtensionOption {
        showTreeButton?: boolean;
    }
}
