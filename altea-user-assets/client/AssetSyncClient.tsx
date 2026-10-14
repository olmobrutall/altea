import * as React from "react";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { ajaxGet, ajaxGetRaw, ajaxPost, saveFile } from "@altea/altea/client/Services";
import { ButtonBarManager } from "@altea/altea/client/Frames/ButtonBar";
import { Navigator } from "@altea/altea/client/Navigator";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import { registerSpecialAction } from "@altea/altea/client/OmniboxSpecialAction";
import * as AppContext from "@altea/altea/client/AppContext";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { UserAssetPermission, UserAssetPreviewModel } from "../data/UserAssets";
import { CodeSyncMessage, CodeSyncMixin, SyncFolderEntity } from "../data/AssetSync";
import type { AssetComparison, AssetSyncDiff, AssetSyncInfo, AssetSyncReport, AssetSyncStatus } from "../data/AssetSyncDtos";
import { CodeSyncWidget } from "./CodeSyncWidget";

// User-asset code sync — see port/UserAssetCodeSync.md.
export namespace AssetSyncClient {
    let started = false;

    export function start(cb: ClientBuilder): void {
        if (started)
            return;
        started = true;

        cb.configure(SyncFolderEntity);

        cb.routes.push({ path: "/assetSync", element: <ImportComponent onImport={() => import("./AssetSyncPanel")} /> });

        registerSpecialAction({
            key: "AssetSync",
            allowed: () => AuthClient.isPermissionAuthorized(UserAssetPermission.UserAssetsToXML),
            onClick: () => Promise.resolve("/assetSync"),
        });

        // The LAST thing in the button bar, pushed right (CodeSyncWidget's ms-auto).
        ButtonBarManager.onButtonBarRender().push(bc => {
            const entity = bc.pack.entity as Entity;
            if (!MixinDeclarations.isDeclared(entity.getType(), CodeSyncMixin))
                return undefined;
            const ctx = TypeContext.root(entity, { readOnly: Navigator.isReadOnly(bc.pack) || undefined });
            return [{ order: Number.MAX_SAFE_INTEGER, button: <CodeSyncWidget ctx={ctx} /> }];
        });

        QuickLinkClient.registerQuickLink(SyncFolderEntity, new QuickLinkAction(
            "AssetSync",
            () => CodeSyncMessage.AssetSync.niceToString(),
            (ctx, e) => AppContext.pushOrOpenInTab("/assetSync?folder=" + encodeURIComponent(ctx.lite.toString()), e),
            { icon: "code-compare", iconColor: "#2E86C1" },
        ));

        QuickLinkClient.registerQuickLink(SyncFolderEntity, new QuickLinkAction(
            "DownloadZip",
            () => CodeSyncMessage.DownloadZip.niceToString(),
            ctx => API.downloadZip(ctx.lites[0]!),
            { icon: "file-zipper", iconColor: "#FCAE25" },
        ));
    }

    /** "Differs from code — will be overwritten on the next sync": the comparison plus what the flag makes of it. */
    export function describe(comparison: AssetComparison, keepOnSync: boolean): { text: string; color: string; icon: IconProp } {
        const consequence = keepOnSync ? CodeSyncMessage.KeptOnTheNextSync.niceToString()
            : comparison === "NotInCode" ? CodeSyncMessage.WillBeDeletedOnTheNextSync.niceToString()
            : comparison === "NotInDatabase" ? CodeSyncMessage.WillBeCreatedOnTheNextSync.niceToString()
            : CodeSyncMessage.WillBeOverwrittenOnTheNextSync.niceToString();
        switch (comparison) {
            case "Identical": return { text: CodeSyncMessage.Identical.niceToString(), color: "success", icon: "circle-check" };
            case "DiffersFromCode": return { text: `${CodeSyncMessage.DiffersFromCode.niceToString()} — ${consequence}`, color: keepOnSync ? "info" : "warning", icon: keepOnSync ? "lock" : "triangle-exclamation" };
            case "NotInCode": return { text: `${CodeSyncMessage.NotInCode.niceToString()} — ${consequence}`, color: keepOnSync ? "info" : "danger", icon: keepOnSync ? "lock" : "file-circle-xmark" };
            case "NotInDatabase": return { text: `${CodeSyncMessage.NotInTheDatabase.niceToString()} — ${consequence}`, color: "secondary", icon: "file-circle-plus" };
        }
    }

    export namespace API {
        export function info(): Promise<AssetSyncInfo> {
            return ajaxGet({ url: "/api/assetSync/info" });
        }

        export function status(folder?: string): Promise<AssetSyncStatus[]> {
            return ajaxGet({ url: "/api/assetSync/status" + (folder ? "?folder=" + encodeURIComponent(folder) : "") });
        }

        export function statusOf(guid: string): Promise<AssetSyncStatus | null> {
            return ajaxGet({ url: "/api/assetSync/status/" + guid });
        }

        export function diff(guid: string): Promise<AssetSyncDiff> {
            return ajaxGet({ url: "/api/assetSync/diff/" + guid });
        }

        export function sync(folders?: string[]): Promise<AssetSyncReport> {
            return ajaxPost({ url: "/api/assetSync/sync" }, { folders });
        }

        export function applyFile(guid: string): Promise<void> {
            return ajaxPost({ url: "/api/assetSync/applyFile/" + guid }, undefined);
        }

        export function setKeepOnSync(guid: string, keepOnSync: boolean): Promise<void> {
            return ajaxPost({ url: "/api/assetSync/keepOnSync" }, { guid, keepOnSync });
        }

        export function writeFile(guid: string): Promise<void> {
            return ajaxPost({ url: "/api/assetSync/writeFile/" + guid }, undefined);
        }

        export function rewriteFiles(): Promise<string[]> {
            return ajaxPost({ url: "/api/assetSync/rewriteFiles" }, undefined);
        }

        export function downloadZip(folder: Lite<SyncFolderEntity>): void {
            ajaxGetRaw({ url: `/api/assetSync/zip/${folder.id}` }).then(resp => saveFile(resp));
        }

        /** `content` is the zip as base64. */
        export function zipPreview(content: string): Promise<UserAssetPreviewModel> {
            return ajaxPost({ url: "/api/assetSync/zipPreview" }, { content });
        }

        export function zipImport(content: string, model: UserAssetPreviewModel, keepOnSync: boolean): Promise<void> {
            return ajaxPost({ url: "/api/assetSync/zipImport" }, { content, model, keepOnSync });
        }
    }
}
