import type { Request } from "express";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { retrieveFromListOfLite } from "@altea/altea/server/Database";
import type { Lite } from "@altea/altea/data/lite";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { UserAssetPermission, UserAssetPreviewModel, type IUserAssetEntity } from "../data/UserAssets";
import { UserAssetsImporter, warmUserAssetCaches } from "./UserAssetsImportExport.server";

// Port of Signum's UserAssetController (Signum.UserAssets/UserAssetController.cs) — the export / import
// HTTP surface. altea divergences: no parseFilters/stringifyFilters/parseDate/stringifyDate endpoints —
// altea resolves query tokens and filter values CLIENT-SIDE (see UserAssetClient), so only the XML
// import/export (which needs DB access to resolve assets by Guid) is server-side.

export namespace UserAssetServer {
    let started = false;

    export function start(ws: WebBuilder): void {
        if (started)
            return;
        started = true;

        // POST the lites to export → retrieve the full assets → serialize to an XML attachment.
        ws.post("/api/userAssets/export",
            { req: CustomType<Lite<IUserAssetEntity>[]>() },
            async (req, res) => {
                await assertAuthorized();
                const lites = await req.jsonTyped() as Lite<IUserAssetEntity>[];
                const entities = await retrieveFromListOfLite(lites);
                const xml = await UserAssetsImporter.toXml(entities);

                const typeName = lites[0]?.entityType?.name ?? "UserAssets";
                const fileName = `${typeName}${lites.map(l => l.id).join("_")}.xml`;
                res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
                res.type("application/xml").send(xml);
            });

        // POST the uploaded file → the import preview (New/Different per asset, by Guid).
        ws.post("/api/userAssets/importPreview",
            { req: CustomType<{ fileName: string; content: string }>(), res: UserAssetPreviewModel },
            async (req, res) => {
                await assertAuthorized();
                const file = await req.jsonTyped() as { fileName: string; content: string };
                await warmUserAssetCaches();
                res.jsonTyped(await UserAssetsImporter.preview(file.content));
            });

        // POST the file + the (edited) preview model → apply the import.
        ws.post("/api/userAssets/import",
            { req: CustomType<{ file: { fileName: string; content: string }; model: UserAssetPreviewModel }>() },
            async (req, res) => {
                await assertAuthorized();
                const body = await req.jsonTyped() as { file: { fileName: string; content: string }; model: UserAssetPreviewModel };
                await warmUserAssetCaches();
                await UserAssetsImporter.importAssets(body.file.content, body.model);
                res.status(204).end();
            });
    }
}

async function assertAuthorized(): Promise<void> {
    if (!(await PermissionAuthLogic.isAuthorized(UserAssetPermission.UserAssetsToXML)))
        throw new UnauthorizedAccessException(`Not authorized for '${UserAssetPermission.UserAssetsToXML.key}'`);
}
