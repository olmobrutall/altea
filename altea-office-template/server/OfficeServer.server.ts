import { WebBuilder, CustomType, attachmentDisposition } from "@altea/altea/server/webApi";
import { retrieve } from "@altea/altea/server/Database";
import { Entity, type Type } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { cleanTypeName } from "@altea/altea/data/registration";
import { OfficeModelEntity, OfficeTemplateVisibleOn, type OfficeTemplateEntity } from "../data/OfficeTemplate";
import { OfficeModelLogic } from "./OfficeModelLogic.server";
import { OfficeTemplateLogic } from "./OfficeTemplateLogic.server";

// Port of Signum.Word's WordController.cs + WordServer.cs — the module's HTTP surface: render a report, and
// the two lookups the "create report" menus make.
//
// altea divergences (the same three @altea/altea-email's MailingServer documents):
//  - `QueryDescriptionTS.AddExtension`, which pushed a query's applicable templates into the
//    QueryDescription DTO, has NO counterpart — altea has no such DTO. The client asks explicitly through
//    `/api/office/officeTemplates`.
//  - `ReflectionServer.OverrideIsNamespaceAllowed` gating a namespace's translations behind type auth is
//    unnecessary: altea ships ONE reflection blob at boot.
//  - `MimeMapping.GetFileStreamResult` → the same `Content-Disposition` + typed `send` that
//    @altea/altea-files' download routes use.

/** Signum's CreateWordReportRequest. */
interface CreateOfficeReportRequest {
    template: Lite<OfficeTemplateEntity>;
    lite?: Lite<Entity> | null;
    entity?: Entity | null;
}

export namespace OfficeServer {
    let started = false;

    export function start(ws: WebBuilder): void {
        if (started)
            return;
        started = true;

        /**
         * Signum's CreateReport — render the template and stream the produced file back.
         *
         * The permission gate lives in `createReport` itself (Signum's
         * `WordTemplatePermission.GenerateReport.AssertAuthorized()`), so every caller is gated, not just
         * this route.
         */
        ws.post("/api/office/createReport",
            { req: CustomType<CreateOfficeReportRequest>() },
            async (req, res) => {
                // `req.body` is the RAW string; `jsonTyped()` deserializes it (Lites become real Lites).
                const body = await req.jsonTyped();

                const template = await OfficeTemplateLogic.getFromCache(body.template);

                const entity = body.entity ?? (body.lite == null
                    ? null
                    : await retrieve(body.lite.entityType as Type<Entity>, body.lite.id));

                const file = await OfficeTemplateLogic.createReportFileContent(template, entity);

                res.setHeader("Content-Disposition", attachmentDisposition(file.fileName));
                res.type(mimeTypeOf(file.fileName)).send(Buffer.from(file.bytes));
            });

        // Signum's GetConstructorType: which TYPE the client must build before it can create a report from
        // this template's model.
        ws.post("/api/office/constructorType",
            { req: CustomType<OfficeModelEntity>(), res: CustomType<string>() },
            async (req, res) => {
                const queryName = OfficeModelLogic.getQueryName(await req.jsonTyped());
                res.jsonTyped(typeof queryName === "function" ? cleanTypeName(queryName) : String(queryName));
            });

        // Signum's GetWordTemplates: the templates a contextual menu / a query button should offer.
        ws.post("/api/office/officeTemplates",
            { req: CustomType<{ lite: Lite<Entity> | null }>(), res: CustomType<Lite<OfficeTemplateEntity>[]>() },
            async (req, res) => {
                const queryKey = String(req.query["queryKey"] ?? "");
                const visibleOn = visibleOnOf(String(req.query["visibleOn"] ?? "Single"));
                const lite = (await req.jsonTyped())?.lite ?? null;
                const entity = lite == null ? null : await retrieve(lite.entityType as Type<Entity>, lite.id);

                res.jsonTyped(await OfficeTemplateLogic.getApplicableOfficeTemplates(queryKey, entity, visibleOn));
            });
    }
}

function visibleOnOf(name: string): OfficeTemplateVisibleOn {
    switch (name) {
        case "Multiple": return OfficeTemplateVisibleOn.Multiple;
        case "Query": return OfficeTemplateVisibleOn.Query;
        default: return OfficeTemplateVisibleOn.Single;
    }
}

/** The Office MIME types, so a browser opens the produced file with the right application. */
const mimeTypes: Record<string, string> = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
    ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
    pdf: "application/pdf",
};

function mimeTypeOf(fileName: string): string {
    const dot = fileName.lastIndexOf(".");
    const ext = dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
    return mimeTypes[ext] ?? "application/octet-stream";
}
