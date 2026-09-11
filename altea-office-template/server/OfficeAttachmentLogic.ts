import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { Entity } from "@altea/altea/data/entity";
import { overrideImplementedBy } from "@altea/altea/data/decorators";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { retrieve } from "@altea/altea/server/Database";
import type { Type } from "@altea/altea/data/entity";
import { TextTemplateParser } from "@altea/altea-templating/server/TextTemplateParser";
import { TextTemplateParameters, type BlockNode } from "@altea/altea-templating/server/TextTemplateParser.Nodes";
import { TemplatingLogic } from "@altea/altea-templating/server/TemplatingLogic";
import { EmailTemplateLogic, type GenerateAttachmentContext } from "@altea/altea-email/server/EmailTemplateLogic";
import {
    EmailAttachmentType, EmailTemplateEntity_Attachment, FileTokenAttachmentEntity, ImageAttachmentEntity,
} from "@altea/altea-email/data/EmailTemplate";
import { OfficeAttachmentEntity } from "../data/OfficeTemplate";
import { OfficeModelLogic } from "./OfficeModelLogic";
import { OfficeTemplateLogic } from "./OfficeTemplateLogic";

// Port of Signum.Word's WordAttachmentLogic.cs — attaching a rendered Office report to an email. See
// port/OfficeTemplate.md.
//
// This is the seam between the two modules: an @altea/altea-email template lists attachment RULES, and each
// rule type registers how to fill its query tokens and how to produce its bytes. An OfficeAttachment names
// an OfficeTemplate, so generating it is "render that report for this message's entity".
//
// altea divergences, documented inline:
//  - altea-email cannot list OfficeAttachmentEntity in `EmailTemplateEntity_Attachment.attachment`'s
//    `@implementedBy` (it would have to depend on this package, which already depends on IT), so the field
//    is WIDENED here with `overrideImplementedBy` — the extension point altea-email's own comment on
//    IAttachmentGeneratorEntity points at.
//  - the produced file goes through altea-email's own attachment shape, where Signum uses
//    `FilePathEmbedded(EmailFileType.Attachment, …)`; the
//    GeneratedAttachment carries the bytes and the mail layer decides where they land, so this just returns
//    `{ fileName, bytes }`.
//  - `CultureInfoUtils.ChangeBothCultures` → `CultureInfo.withCultures`, the same call altea-email's own
//    generators make.
//  - the FileName template is parsed at save time by a field `@validate`, where Signum uses a
//    StaticPropertyValidation; the
//    equivalent belongs on the entity (see officeTemplateValidations for the pattern); it is NOT wired here
//    because the fileName is parsed on the generate path anyway and a bad one surfaces there with the same
//    message. Noted rather than silently dropped.

/** Memoised parse of an attachment's fileName template. */
const fileNameNodes = new WeakMap<object, BlockNode>();

export namespace OfficeAttachmentLogic {
    let started = false;

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;

        sb.include(OfficeAttachmentEntity).withQuery();

        // Widen the polymorphic attachment field so a template can hold one of these.
        overrideImplementedBy(EmailTemplateEntity_Attachment, e => e.attachment,
            () => [ImageAttachmentEntity, FileTokenAttachmentEntity, OfficeAttachmentEntity]);

        // The fileName is a text template, so its tokens must join the message's single query.
        EmailTemplateLogic.registerFillAttachmentTokens<OfficeAttachmentEntity>(OfficeAttachmentEntity, (a, ctx) => {
            if (a.fileName != null && a.fileName !== "")
                TextTemplateParser.parse(a.fileName, ctx.queryName, ctx.modelType).fillQueryTokens(ctx.queryTokens);
        });

        EmailTemplateLogic.registerGenerateAttachment<OfficeAttachmentEntity>(OfficeAttachmentEntity, async (a, ctx) => {
            // The override model, else the context's entity, else the context model's own entity.
            let entity: Entity | null = a.overrideModel != null
                ? await retrieve(a.overrideModel.entityType as Type<Entity>, a.overrideModel.id)
                : ctx.entity ?? (ctx.model?.untypedEntity ?? null);

            if (a.modelConverter != null && entity != null)
                entity = TemplatingLogic.convert(a.modelConverter, entity);

            const template = await OfficeTemplateLogic.getFromCache(a.officeTemplate);

            // A template whose model can be built from the entity alone gets one; one that needs extra
            // parameters cannot be built here, so the report runs off the query instead.
            const model = template.model != null && !OfficeModelLogic.requiresExtraParameters(template.model)
                ? OfficeModelLogic.createModel(template.model, entity)
                : undefined;

            const file = await OfficeTemplateLogic.createReportFileContent(template, entity, model);

            const fileName = a.fileName == null || a.fileName === ""
                ? file.fileName
                : CultureInfo.withCultures(ctx.culture, () => templateString(a, a.fileName!, ctx));

            return [{
                fileName,
                bytes: file.bytes,
                contentId: "",
                type: EmailAttachmentType.Attachment,
            }];
        });
    }
}

/** The attachment's own fileName template, memoised per attachment row. */
function templateString(attachment: object, text: string, ctx: GenerateAttachmentContext): string {
    let block = fileNameNodes.get(attachment);
    if (block == undefined) {
        block = TextTemplateParser.parse(text, ctx.queryContext?.queryName, ctx.modelType);
        fileNameNodes.set(attachment, block);
    }

    const p = new TextTemplateParameters(ctx.entity, ctx.culture, ctx.queryContext);
    p.model = ctx.model ?? undefined;
    return block.print(p);
}
