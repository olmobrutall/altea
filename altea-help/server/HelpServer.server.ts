import "@altea/altea/server";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import * as Database from "@altea/altea/server/Database";
import { Saver } from "@altea/altea/server/saver";
import { Operations } from "@altea/altea/server/operationLogic";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { Entity } from "@altea/altea/data/entity";
import { cleanTypeName } from "@altea/altea/data/registration";
import type { Lite } from "@altea/altea/data/lite";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import {
    AppendixHelpEntity, AppendixHelpOperation,
    NamespaceHelpEntity, NamespaceHelpOperation,
    QueryHelpEntity, QueryHelpOperation,
    TypeHelpEntity, TypeHelpOperation,
    HelpPermissions,
    type HelpFileUpload, type HelpImportPreviewModel, type HelpImportReportModel,
    type HelpIndexTS, type HelpSearchResponse, type NamespaceHelpTS,
} from "../data/Help";
import { HelpLogic } from "./HelpLogic.server";
import { HelpSearch } from "./HelpSearch.server";
import { HelpExportImport } from "./HelpExportImport.server";

// Port of Signum.Help's HelpController.cs — the routes the pages call.
//
// altea divergences:
//  - **`/api/help/search` is NEW.** Signum has `HelpSearch.cs` and a client `Urls.searchUrl`, but no
//    endpoint and no route — its own omnibox "help 'text'" suggestion 404s. See HelpSearch.
//  - **the type route is GATED.** Signum's `Type` action has its `AssertAuthorized` commented out, so any
//    authenticated user can read any type's help; here it is gated like the rest (the frame widget, which
//    is what made the commented-out gate tempting, is itself behind the same permission client-side).
//  - **the export route answers a base64 payload**, not a `FileStreamResult`: altea's typed `WebBuilder`
//    routes are JSON, and the client already knows how to save a base64 blob (the import page reads one).
//  - Signum's `namespace` route replaces `_` with `.` in the path segment because a C# namespace has dots.
//    altea's namespace is a package path with SLASHES, which cannot travel in a path segment at all — so
//    the namespace is a QUERY parameter.
export namespace HelpServer {

    export function start(ws: WebBuilder): void {

        ws.get("/api/help/index",
            { res: CustomType<HelpIndexTS>() },
            async (_req, res) => {
                await assertView();

                const namespaces = await HelpLogic.getNamespaceHelps();
                const appendices = await HelpLogic.getAppendixHelps();
                const types = await HelpLogic.cachedEntityHelp();

                return res.jsonTyped({
                    culture: await HelpLogic.getCulture(),
                    namespaces: namespaces
                        .filter(nh => nh.types.length > 0)
                        .map(nh => ({
                            namespace: nh.namespace,
                            module: nh.module,
                            title: nh.title,
                            hasEntity: nh.dbEntity != undefined,
                            allowedTypes: nh.types.map(t => {
                                const clean = cleanOf(t);
                                return { cleanName: clean, hasEntity: types.get(clean)?.dbEntity != undefined };
                            }),
                        })),
                    appendices: appendices.map(a => ({ uniqueName: a.uniqueName, title: a.title })),
                } satisfies HelpIndexTS);
            });

        ws.get("/api/help/namespace",
            { res: CustomType<NamespaceHelpTS>() },
            async (req, res) => {
                await assertView();

                const name = (req.query["namespace"] as string | undefined) ?? "";
                const nh = await HelpLogic.getNamespaceHelp(name);
                const types = await HelpLogic.cachedEntityHelp();

                return res.jsonTyped({
                    namespace: nh.namespace,
                    title: nh.title,
                    description: nh.description,
                    entity: HelpLogic.namespaceEntity(nh),
                    allowedTypes: nh.types.map(t => {
                        const clean = cleanOf(t);
                        return { cleanName: clean, hasEntity: types.get(clean)?.dbEntity != undefined };
                    }),
                } satisfies NamespaceHelpTS);
            });

        ws.post("/api/help/saveNamespace",
            { req: CustomType<NamespaceHelpEntity>(), res: CustomType<void>() },
            async (req, res) => {
                await assertView();
                const entity = await req.jsonTyped();

                // Signum: an empty namespace help is DELETED rather than stored — the page always has an
                // editor, so "cleared it" must not leave a blank row behind.
                if (!entity.title && !entity.description) {
                    if (!entity.isNew)
                        await Operations.delete(entity, NamespaceHelpOperation.Delete);
                } else {
                    await Operations.execute(entity, NamespaceHelpOperation.Save);
                }

                return res.jsonTyped(undefined);
            });

        ws.get("/api/help/appendix",
            { res: CustomType<AppendixHelpEntity>() },
            async (req, res) => {
                await assertView();

                const uniqueName = (req.query["uniqueName"] as string | undefined) ?? "";
                if (uniqueName.trim() === "")
                    return res.jsonTyped(AppendixHelpEntity.create({ culture: await HelpLogic.getCulture(), title: "", uniqueName: "" }));

                return res.jsonTyped(await HelpLogic.getAppendixHelp(uniqueName));
            });

        ws.post("/api/help/saveAppendix",
            { req: CustomType<AppendixHelpEntity>(), res: CustomType<void>() },
            async (req, res) => {
                await assertView();
                await Operations.execute(await req.jsonTyped(), AppendixHelpOperation.Save);
                return res.jsonTyped(undefined);
            });

        ws.get("/api/help/type/:cleanName",
            { params: CustomType<{ cleanName: string }>(), res: CustomType<TypeHelpEntity>() },
            async (req, res) => {
                await assertView();

                const { cleanName } = (req as unknown as { params: { cleanName: string } }).params;
                const type = Entity.resolveType(cleanName);

                const th = await HelpLogic.getTypeHelp(type);
                return res.jsonTyped(HelpLogic.typeEntity(th));
            });

        ws.post("/api/help/saveType",
            { req: CustomType<TypeHelpEntity>(), res: CustomType<void>() },
            async (req, res) => {
                await assertView();
                await saveType(await req.jsonTyped());
                return res.jsonTyped(undefined);
            });

        ws.get("/api/help/search",
            { res: CustomType<HelpSearchResponse>() },
            async (req, res) => {
                await assertView();

                const query = (req.query["q"] as string | undefined) ?? "";
                const started = Date.now();
                const results = await HelpSearch.search(query);

                return res.jsonTyped({ query, elapsedMs: Date.now() - started, results } satisfies HelpSearchResponse);
            });

        // ---- export / import ----------------------------------------------------------------------

        ws.post("/api/help/export",
            { req: CustomType<Lite<Entity>[]>(), res: CustomType<HelpFileUpload>() },
            async (req, res) => {
                await assertExport();

                const lites = await req.jsonTyped();
                const entities = await Database.retrieveFromListOfLite(lites);
                const bytes = await HelpExportImport.exportToZip(entities as never);

                const typeName = lites.map(l => l.entityType.name).distinct().single();
                const ids = lites.map(l => String(l.id).substring(0, 5)).join("_");

                return res.jsonTyped({
                    fileName: `${typeName}${ids}.zip`,
                    content: Buffer.from(bytes).toString("base64"),
                } satisfies HelpFileUpload);
            });

        ws.post("/api/help/importPreview",
            { req: CustomType<HelpFileUpload>(), res: CustomType<HelpImportPreviewModel>() },
            async (req, res) => {
                await assertExport();
                const file = await req.jsonTyped();
                return res.jsonTyped(await HelpExportImport.importPreview(base64ToBytes(file.content)));
            });

        ws.post("/api/help/applyImport",
            { req: CustomType<{ file: HelpFileUpload; model: HelpImportPreviewModel }>(), res: CustomType<HelpImportReportModel>() },
            async (req, res) => {
                await assertExport();
                const { file, model } = await req.jsonTyped();
                return res.jsonTyped(await HelpExportImport.applyImport(base64ToBytes(file.content), model));
            });
    }

    /**
     * Signum's `SaveType`. Three things happen here, and each is load-bearing:
     *  1. each QUERY help is saved (or deleted when emptied) as its own row — they are shared between types;
     *  2. the rows the CLIENT never saw are preserved. The page only renders the routes/operations the
     *     CURRENT user may see, so a naive save would silently delete the descriptions of the ones it hid;
     *  3. rows with no description are dropped, and an entity left with nothing is deleted rather than
     *     stored blank.
     */
    async function saveType(entity: TypeHelpEntity): Promise<void> {
        await Transaction.create(async () => {

            for (const query of entity.queries) {
                query.columns = query.columns.filter(c => c.description);

                if (query.columns.length === 0 && !query.description) {
                    if (!query.isNew)
                        await Operations.delete(query, QueryHelpOperation.Delete);
                } else {
                    await Operations.execute(query, QueryHelpOperation.Save);
                }
            }

            if (!entity.isNew) {
                const stored = await ExecutionMode.global(() => Database.retrieve(TypeHelpEntity, entity.id!));

                const visibleRoutes = new Set(entity.properties.map(p => p.propertyRoute));
                for (const hidden of stored.properties.filter(p => !visibleRoutes.has(p.propertyRoute))) {
                    hidden.typeHelp = entity;
                    entity.properties.push(hidden);
                }

                const visibleOperations = new Set(entity.operations.map(o => o.operation.key));
                for (const hidden of stored.operations.filter(o => !visibleOperations.has(o.operation.key))) {
                    hidden.typeHelp = entity;
                    entity.operations.push(hidden);
                }
            }

            entity.properties = entity.properties.filter(p => p.description);
            entity.operations = entity.operations.filter(o => o.description);

            // `queries` is not a column, so it must not travel into the save graph.
            entity.queries = [];

            if (entity.isEmpty()) {
                if (!entity.isNew)
                    await Operations.delete(entity, TypeHelpOperation.Delete);
            } else {
                await Operations.execute(entity, TypeHelpOperation.Save);
            }
        });
    }

    function cleanOf(type: Function): string {
        return cleanTypeName(type);
    }

    async function assertView(): Promise<void> {
        if (!(await PermissionAuthLogic.isAuthorized(HelpPermissions.ViewHelp)))
            throw new UnauthorizedAccessException(`Not authorized for '${HelpPermissions.ViewHelp.key}'`);
    }

    async function assertExport(): Promise<void> {
        if (!(await PermissionAuthLogic.isAuthorized(HelpPermissions.ExportHelp)))
            throw new UnauthorizedAccessException(`Not authorized for '${HelpPermissions.ExportHelp.key}'`);
    }

    function base64ToBytes(base64: string): Uint8Array {
        const payload = base64.includes(",") ? base64.substring(base64.indexOf(",") + 1) : base64;
        return new Uint8Array(Buffer.from(payload, "base64"));
    }
}
