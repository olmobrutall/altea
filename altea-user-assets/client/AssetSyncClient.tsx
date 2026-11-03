import * as React from "react";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { ajaxGetRaw, saveFile } from "@altea/altea/client/Services";
import { onEmbeddedWidgets } from "@altea/altea/client/Frames/Widgets";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { CodeSyncMessage, CodeSyncMixin, SyncFolderEntity } from "../data/AssetSync";
import { CodeSyncWidget } from "./CodeSyncWidget";

// User-asset code sync — see port/UserAssetCodeSync.md.
export namespace AssetSyncClient {
    let started = false;

    export function start(cb: ClientBuilder): void {
        if (started)
            return;
        started = true;

        cb.configure(SyncFolderEntity);

        onEmbeddedWidgets().push(wc => {
            const entity = wc.ctx.value as Entity;
            if (!MixinDeclarations.isDeclared(entity.getType(), CodeSyncMixin))
                return undefined;
            return [{
                position: "Top",
                eventKey: "codeSync",
                title: CodeSyncMessage.ControlledByCode.niceToString(),
                embeddedWidget: <CodeSyncWidget ctx={wc.ctx as TypeContext<Entity>} />,
            }];
        });

        QuickLinkClient.registerQuickLink(SyncFolderEntity, new QuickLinkAction(
            "DownloadZip",
            () => CodeSyncMessage.DownloadZip.niceToString(),
            ctx => API.downloadZip(ctx.lites[0]!),
            { icon: "file-zipper", iconColor: "#FCAE25" },
        ));
    }

    export namespace API {
        export function downloadZip(folder: Lite<SyncFolderEntity>): void {
            ajaxGetRaw({ url: `/api/assetSync/zip/${folder.id}` }).then(resp => saveFile(resp));
        }
    }
}
