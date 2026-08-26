import "@altea/altea/data/globals/arrayExtensions";
import "@altea/altea/data/globals/stringExtensions";
import * as React from "react";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import * as AppContext from "@altea/altea/client/AppContext";
import { QueryString } from "@altea/altea/client/QueryString";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import { onWidgets, type WidgetContext } from "@altea/altea/client/Frames/Widgets";
import { tasks } from "@altea/altea/client/Lines/LineBase";
import { tryGetTypeInfo, getTypeName, type PseudoType } from "@altea/altea/client/Reflection";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { Entity, type BaseEntity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { Metadata } from "@altea/altea/data/metadata";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import type { OperationSymbol } from "@altea/altea/data/operations";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { OmniboxClient } from "@altea/altea-omnibox/client/OmniboxClient";
import { registerSpecialAction } from "@altea/altea-omnibox/client/OmniboxSpecialAction";
import {
    AppendixHelpEntity, NamespaceHelpEntity, QueryHelpEntity, TypeHelpEntity,
    HelpMessage, HelpPermissions, HelpLinkPrefix,
    type HelpFileUpload, type HelpImportPreviewModel, type HelpImportReportModel,
    type HelpIndexTS, type HelpSearchResponse, type NamespaceHelpTS,
} from "../data/Help";
import HelpOmniboxProvider from "./HelpOmniboxProvider";
import { HelpIcon, HelpWidget } from "./HelpWidget";
import "./Help.css";

// Port of Signum.Help's HelpClient.tsx — the module's client registration (routes, the frame widget, the
// per-line help icon, the export quick link, the omnibox provider and special action), the API calls, the
// URL helpers, and the `[t:Order]` link-token renderer.
//
// altea divergences:
//  - **`/help/search` is registered**, and `searchUrl` takes the SEARCH TEXT. Signum's takes a
//    `PseudoType` and runs `getQueryKey` over it, while its only caller (the omnibox) passes a free-text
//    string — and no route was registered at all, so the suggestion 404s. See server/HelpSearch.
//  - **the namespace URL carries the namespace as a QUERY parameter.** Signum swaps `.` for `_` to fit a
//    C# namespace into a path segment; altea's namespace is a package path with SLASHES, which cannot be
//    escaped into a segment at all.
//  - `AppContext.isPermissionAuthorized` lives in altea-auth (`AuthClient`), and the checks are made
//    INSIDE the callbacks rather than once at start — a permission flag follows `onCurrentUserChanged`,
//    so a start-time snapshot is wrong after a re-login (the lesson altea-time-machine's client records).
//  - `ti.operations` does not exist on altea's client TypeInfo (operations are per-role, so they live on
//    the metadata blob): the `[o:Key]` link resolves the owning type through `Metadata`.
//  - `ChangeLogClient.registerChangeLogModule` is not called — altea's change log is per-application.
export namespace HelpClient {

    export function start(cb: ClientBuilder): void {

        OmniboxClient.registerProvider(new HelpOmniboxProvider());

        registerSpecialAction({
            key: "ImportHelp",
            allowed: () => AuthClient.isPermissionAuthorized(HelpPermissions.ExportHelp),
            onClick: () => Promise.resolve("/help/import"),
        });

        cb.routes.push(
            { path: "/help", element: <ImportComponent onImport={() => import("./Pages/HelpIndexPage")} /> },
            { path: "/help/namespace", element: <ImportComponent onImport={() => import("./Pages/NamespaceHelpPage")} /> },
            { path: "/help/type/:cleanName", element: <ImportComponent onImport={() => import("./Pages/TypeHelpPage")} /> },
            { path: "/help/appendix", element: <ImportComponent onImport={() => import("./Pages/AppendixHelpPage")} /> },
            { path: "/help/search", element: <ImportComponent onImport={() => import("./Pages/HelpSearchPage")} /> },
            { path: "/help/import", element: <ImportComponent onImport={() => import("./Pages/ImportHelpPage")} /> },
        );

        // The "?" button on every entity frame.
        onWidgets().push(wc => AuthClient.isPermissionAuthorized(HelpPermissions.ViewHelp) && wc.ctx.value instanceof Entity
            ? <HelpWidget wc={wc as WidgetContext<Entity>} />
            : undefined);

        // The "?" badge beside a LINE's label, when that property has a written description.
        tasks().push(taskHelpIcon);

        for (const type of [TypeHelpEntity, NamespaceHelpEntity, AppendixHelpEntity, QueryHelpEntity])
            registerExportLink(type);
    }

    function registerExportLink(type: typeof TypeHelpEntity | typeof NamespaceHelpEntity | typeof AppendixHelpEntity | typeof QueryHelpEntity): void {
        QuickLinkClient.registerQuickLink(type as never,
            new QuickLinkAction("HelpExportAsZip", () => HelpMessage.ExportAsZip.niceToString(),
                ctx => exportHelpEntities(ctx.lites), {
                allowsMultiple: true,
                iconColor: "#FCAE25",
                icon: "file-code",
                isVisible: () => Promise.resolve(AuthClient.isPermissionAuthorized(HelpPermissions.ExportHelp)),
            }));
    }

    /** Signum's `taskHelpIcon` — every Line asks, and only a documented property answers. */
    export function taskHelpIcon(lineBase: unknown, state: { labelIcon?: React.ReactNode; ctx: any }): void {
        if (state.labelIcon === undefined && state.ctx?.propertyRoute && state.ctx?.frame?.pack?.typeHelp)
            state.labelIcon = <HelpIcon ctx={state.ctx} />;
    }

    // ---- the `[t:Order]` link tokens --------------------------------------------------------------

    const HELP_LINK_REGEX = /\[(?<letter>[tpqona]):(?<link>[^\]]*)\]/gi;

    /**
     * Signum's `replaceHtmlLinks` — rewrite each `[t:Order]` / `[p:Order.shipDate]` / … token into a real
     * anchor. A token whose target no longer exists renders red rather than as a dead link, which is what
     * makes a stale description visible.
     */
    export function replaceHtmlLinks(txt: string | null | undefined): string {
        if (!txt)
            return "";

        function htmlLink(url: string | null | undefined, title: string): string {
            if (url == null)
                return `<span class="text-danger">${title}</span>`;
            return `<a href="${AppContext.toAbsoluteUrl(url)}">${title}</a>`;
        }

        return txt.replace(HELP_LINK_REGEX, (match, letter: string, link: string) => {
            switch (letter.toLowerCase()) {
                case HelpLinkPrefix.type: {
                    const ti = tryGetTypeInfo(link);
                    return htmlLink(ti && Urls.typeUrl(link), ti?.getNiceName() ?? link);
                }
                case HelpLinkPrefix.appendix:
                    return htmlLink(Urls.appendixUrl(link), link);
                case HelpLinkPrefix.namespace:
                    return htmlLink(Urls.namespaceUrl(link), link);
                case HelpLinkPrefix.operation: {
                    // ALTEA: the client TypeInfo has no `operations` (they are per-role, so they live on
                    // the metadata blob — see CLAUDE.md on XxxInfo vs XxxMetadata), and there is no
                    // "every type" enumerator either. So the owning type is found by scanning the blob for
                    // the culture in play, which is where the operations actually are.
                    const owner = Object.entries(Metadata.forCulture(CultureInfo.currentUICulture()))
                        .find(([, tm]) => tm.operations != undefined && Object.values(tm.operations).some(o => o.key === link));
                    return htmlLink(owner && Urls.operationUrl(owner[0], link), link);
                }
                case HelpLinkPrefix.query: {
                    // A query key is the entity's clean name for an auto-query; the anchor lives on that
                    // type's page.
                    const typeName = link.tryBefore(".") ?? link;
                    const ti = tryGetTypeInfo(typeName);
                    return htmlLink(ti && Urls.queryUrl(typeName, link), link);
                }
                case HelpLinkPrefix.property: {
                    const typeName = link.tryBefore(".");
                    const ti = typeName ? tryGetTypeInfo(typeName) : null;
                    return htmlLink(ti && Urls.propertyUrl(typeName!, link.after(".")), link);
                }
                default:
                    return match;
            }
        });
    }

    // ---- API --------------------------------------------------------------------------------------

    export namespace API {

        export function index(): Promise<HelpIndexTS> {
            return ajaxGet({ url: "/api/help/index" });
        }

        export function namespaceHelp(namespace: string): Promise<NamespaceHelpTS> {
            return ajaxGet({ url: "/api/help/namespace?" + QueryString.stringify({ namespace }) });
        }

        export function saveNamespace(entity: NamespaceHelpEntity): Promise<void> {
            return ajaxPost({ url: "/api/help/saveNamespace" }, entity);
        }

        export function appendix(uniqueName: string | undefined): Promise<AppendixHelpEntity> {
            return ajaxGet({ url: "/api/help/appendix?" + QueryString.stringify({ uniqueName: uniqueName ?? "" }) });
        }

        export function saveAppendix(entity: AppendixHelpEntity): Promise<void> {
            return ajaxPost({ url: "/api/help/saveAppendix" }, entity);
        }

        // Signum caches the type help per clean name for the LIFETIME of the tab, because the frame widget
        // asks for it on every entity open. Kept, and invalidated on save.
        const typeCache: { [cleanName: string]: Promise<TypeHelpEntity> } = {};

        export function type(cleanName: string): Promise<TypeHelpEntity> {
            return typeCache[cleanName] ??= ajaxGet({ url: "/api/help/type/" + cleanName });
        }

        export function saveType(entity: TypeHelpEntity): Promise<void> {
            delete typeCache[entity.type.cleanName];
            return ajaxPost({ url: "/api/help/saveType" }, entity);
        }

        export function search(query: string): Promise<HelpSearchResponse> {
            return ajaxGet({ url: "/api/help/search?" + QueryString.stringify({ q: query }) });
        }

        export function exportZip(lites: Lite<Entity>[]): Promise<HelpFileUpload> {
            return ajaxPost({ url: "/api/help/export" }, lites);
        }

        export function importPreview(file: HelpFileUpload): Promise<HelpImportPreviewModel> {
            return ajaxPost({ url: "/api/help/importPreview" }, file);
        }

        export function applyImport(file: HelpFileUpload, model: HelpImportPreviewModel): Promise<HelpImportReportModel> {
            return ajaxPost({ url: "/api/help/applyImport" }, { file, model });
        }
    }

    /**
     * Download the picked help entities as a zip. ALTEA: the server answers a base64 payload (its typed
     * routes are JSON), so the save happens here rather than through a streamed response.
     */
    export function exportHelpEntities(lites: Lite<Entity>[]): void {
        API.exportZip(lites).then(file => saveBase64(file));
    }

    function saveBase64(file: HelpFileUpload): void {
        const bytes = Uint8Array.from(atob(file.content), c => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = file.fileName;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ---- URLs -------------------------------------------------------------------------------------

    export namespace Urls {

        export function indexUrl(): string {
            return "/help";
        }

        /** ALTEA: takes the SEARCH TEXT (Signum's takes a PseudoType and query-keys it — see the header). */
        export function searchUrl(query: string): string {
            return "/help/search?" + QueryString.stringify({ q: query });
        }

        export function typeUrl(typeName: PseudoType): string {
            return "/help/type/" + getTypeName(typeName);
        }

        /** ALTEA: a query parameter — an altea namespace contains slashes (see the header). */
        export function namespaceUrl(namespace: string): string {
            return "/help/namespace?" + QueryString.stringify({ namespace });
        }

        export function appendixUrl(uniqueName: string | null): string {
            return "/help/appendix" + (uniqueName ? "?" + QueryString.stringify({ uniqueName }) : "");
        }

        export function operationUrl(typeName: PseudoType, operation: OperationSymbol | string): string {
            return typeUrl(typeName) + "#" + idOperation(operation);
        }

        export function idOperation(operation: OperationSymbol | string): string {
            return "o-" + (typeof operation === "string" ? operation : operation.key).replaceAll(".", "_");
        }

        export function propertyUrl(typeName: PseudoType, route: PropertyRoute | string): string {
            return typeUrl(typeName) + "#" + idProperty(route);
        }

        export function idProperty(route: PropertyRoute | string): string {
            const path = route instanceof PropertyRoute ? route.propertyString() : route;
            return "p-" + path.replaceAll(".", "_").replaceAll("/", "_").replaceAll("[", "_").replaceAll("]", "_");
        }

        export function queryUrl(typeName: PseudoType, queryKey: string): string {
            return typeUrl(typeName) + "#" + idQuery(queryKey);
        }

        export function idQuery(queryKey: string): string {
            return "q-" + queryKey.replaceAll(".", "_");
        }
    }
}

// The frame widget stores the type's help on the entity pack, so every Line on the page can read it
// without a request of its own (Signum's same augmentation).
declare module "@altea/altea/data/entityPack" {
    interface EntityPack<T extends BaseEntity> {
        /** Filled CLIENT-side by HelpWidget once it has fetched the type's help (Signum's same field). */
        typeHelp?: TypeHelpEntity;
    }
}
