import * as React from "react";
import type { RouteObject } from "react-router";
import { ajaxPost, ajaxPostRaw, saveFile } from "@altea/altea/client/Services";
import type { Type, Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import { UserAssetMessage, UserAssetPreviewModel, type IUserAssetEntity } from "../data/UserAssets";

// Port of Signum's Signum.UserAssets/UserAssetClient.tsx (the export/import trigger surface). altea
// divergences: the filter Converter + parseFilters/stringifyFilters/date endpoints are gone (altea resolves
// tokens + values client-side — see FilterValueString); this keeps the XML export quick-link, the import
// route, and the export/import HTTP API. Permission is enforced server-side (altea has no client primitive).

export namespace UserAssetClient {
    let started = false;

    export function start(routes: RouteObject[]): void {
        if (started)
            return;
        started = true;
        routes.push({ path: "/userAssets/import", element: <ImportComponent onImport={() => import("./ImportAssetsPage")} /> });
    }

    // Registers the "Export to XML" quick-link on a user-asset type (Signum's registerExportAssertLink).
    export function registerExportAssertLink(type: Type<Entity>): void {
        QuickLinkClient.registerQuickLink(type, new QuickLinkAction(
            "ExportToXml",
            () => UserAssetMessage.ExportToXml.niceToString(),
            ctx => API.exportAsset(ctx.lites),
            { allowsMultiple: true, icon: "file-code", iconColor: "#FCAE25" },
        ));
    }

    export namespace API {
        export function exportAsset(lites: Lite<Entity>[]): void {
            ajaxPostRaw({ url: "/api/userAssets/export" }, lites).then(resp => saveFile(resp));
        }

        export interface FileUpload { fileName: string; content: string; }

        export function importPreview(request: FileUpload): Promise<UserAssetPreviewModel> {
            return ajaxPost({ url: "/api/userAssets/importPreview" }, request);
        }

        export interface FileUploadWithModel { file: FileUpload; model: UserAssetPreviewModel; }

        export function importAssets(request: FileUploadWithModel): Promise<void> {
            return ajaxPost({ url: "/api/userAssets/import" }, request);
        }
    }
}

// so the type import isn't elided (used above as a type only).
export type { IUserAssetEntity };
