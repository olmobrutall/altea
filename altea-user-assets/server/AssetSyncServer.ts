import { table } from "@altea/altea/server/table";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";
import { CustomType, attachmentDisposition, type WebBuilder } from "@altea/altea/server/webApi";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { UserAssetPermission, UserAssetPreviewModel } from "../data/UserAssets";
import { SyncFolderEntity } from "../data/AssetSync";
import type { AssetSyncInfo } from "../data/AssetSyncDtos";
import { AssetSyncLogic } from "./AssetSyncLogic";

// The HTTP surface of the user-asset code sync — see port/UserAssetCodeSync.md. Every route is gated by
// UserAssetsToXML, the permission of the one-file export / import.
export namespace AssetSyncServer {
    let started = false;

    export function start(ws: WebBuilder): void {
        if (started)
            return;
        started = true;

        ws.get("/api/assetSync/info", {}, async (_req, res) => {
            await assertAuthorized();
            const info: AssetSyncInfo = { writeFiles: AssetSyncLogic.writesFiles(), folders: AssetSyncLogic.folderDirectories() };
            res.json(info);
        });

        ws.get("/api/assetSync/status", {}, async (req, res) => {
            await assertAuthorized();
            const folder = typeof req.query["folder"] === "string" ? req.query["folder"] : undefined;
            res.json(await AssetSyncLogic.status(folder));
        });

        ws.get("/api/assetSync/status/:guid", { params: CustomType<{ guid: string }>() }, async (req, res) => {
            await assertAuthorized();
            res.json(await AssetSyncLogic.statusOf(req.params.guid));
        });

        ws.get("/api/assetSync/diff/:guid", { params: CustomType<{ guid: string }>() }, async (req, res) => {
            await assertAuthorized();
            res.json(await AssetSyncLogic.diff(req.params.guid));
        });

        ws.post("/api/assetSync/sync", { req: CustomType<{ folders?: string[] }>() }, async (req, res) => {
            await assertAuthorized();
            const body = await req.jsonTyped() as { folders?: string[] };
            res.json(await AssetSyncLogic.syncFromCode({ folders: body.folders }));
        });

        ws.post("/api/assetSync/applyFile/:guid", { params: CustomType<{ guid: string }>() }, async (req, res) => {
            await assertAuthorized();
            await AssetSyncLogic.applyFile(req.params.guid);
            res.status(204).end();
        });

        ws.post("/api/assetSync/keepOnSync", { req: CustomType<{ guid: string; keepOnSync: boolean }>() }, async (req, res) => {
            await assertAuthorized();
            const body = await req.jsonTyped() as { guid: string; keepOnSync: boolean };
            await AssetSyncLogic.setKeepOnSync(body.guid, body.keepOnSync);
            res.status(204).end();
        });

        ws.post("/api/assetSync/writeFile/:guid", { params: CustomType<{ guid: string }>() }, async (req, res) => {
            await assertAuthorized();
            await AssetSyncLogic.writeFile(req.params.guid);
            res.status(204).end();
        });

        ws.post("/api/assetSync/rewriteFiles", {}, async (_req, res) => {
            await assertAuthorized();
            res.json(await AssetSyncLogic.rewriteFiles());
        });

        ws.get("/api/assetSync/zip/:folderId", { params: CustomType<{ folderId: string }>() }, async (req, res) => {
            await assertAuthorized();
            const folder = await table(SyncFolderEntity).filter(f => f.id == SyncFolderEntity.parseId(req.params.folderId)).single();
            const zip = await AssetSyncLogic.zipFolder(folder.toLite());
            res.setHeader("Content-Disposition", attachmentDisposition(zip.name));
            res.type("application/zip").send(Buffer.from(zip.bytes));
        });

        ws.post("/api/assetSync/zipPreview",
            { req: CustomType<{ content: string }>(), res: UserAssetPreviewModel },
            async (req, res) => {
                await assertAuthorized();
                const body = await req.jsonTyped() as { content: string };
                res.jsonTyped(await AssetSyncLogic.previewZip(Buffer.from(body.content, "base64")));
            });

        ws.post("/api/assetSync/zipImport",
            { req: CustomType<{ content: string; model: UserAssetPreviewModel; keepOnSync: boolean }>() },
            async (req, res) => {
                await assertAuthorized();
                const body = await req.jsonTyped() as { content: string; model: UserAssetPreviewModel; keepOnSync: boolean };
                await AssetSyncLogic.importZip(Buffer.from(body.content, "base64"), body.model, body.keepOnSync);
                res.status(204).end();
            });
    }
}

async function assertAuthorized(): Promise<void> {
    if (!(await PermissionLogic.isAuthorized(UserAssetPermission.UserAssetsToXML)))
        throw new UnauthorizedAccessException(`Not authorized for '${UserAssetPermission.UserAssetsToXML.key}'`);
}
