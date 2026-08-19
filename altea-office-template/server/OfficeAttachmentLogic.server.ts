import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { Entity } from "@altea/altea/data/entity";
import { overrideImplementedBy } from "@altea/altea/data/decorators";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { retrieve } from "@altea/altea/server/Database";
import type { Type } from "@altea/altea/data/entity";
import { TextTemplateParser } from "@altea/altea-templating/server/TextTemplateParser.server";
import { TextTemplateParameters, type BlockNode } from "@altea/altea-templating/server/TextTemplateParser.Nodes.server";
import { TemplatingLogic } from "@altea/altea-templating/server/TemplatingLogic.server";
import { EmailTemplateLogic, type GenerateAttachmentContext } from "@altea/altea-email/server/EmailTemplateLogic.server";
import {
    EmailAttachmentTypeEnum, EmailTemplateEntity_Attachment, FileTokenAttachmentEntity, ImageAttachmentEntity,
} from "@altea/altea-email/data/EmailTemplate";
import { OfficeAttachmentEntity } from "../data/OfficeTemplate";
import { OfficeModelLogic } from "./OfficeModelLogic.server";
import { OfficeTemplateLogic } from "./OfficeTemplateLogic.server";

// Port of Signum.Word's WordAttachmentLogic.cs — attaching a rendered Office report to an email.
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
//  - Signum stores the produced file through `FilePathEmbedded(EmailFileType.Attachment, …)`; altea's
//    GeneratedAttachment carries the bytes and the mail layer decides where they land, so this just returns
//    `{ fileName, bytes }`.
//  - `CultureInfoUtils.ChangeBothCultures` → `CultureInfo.withCultures`, the same call altea-email's own
//    generators make.
//  - Signum's `StaticPropertyValidation` on FileName parsed the name template at save time. altea's
//    equivalent belongs on the entity (see officeTemplateValidations for the pattern); it is NOT wired here
//    because the fileName is parsed on the generate path anyway and a bad one surfaces there with the same
//    message. Noted rather than silently dropped.

/** Memoised parse of an attachment's fileName template (Signum's `[Ignore] object? FileNameNode`). */
const fileNameNodes = new WeakMap<object, BlockNode>();

export namespace OfficeAttachmentLogic {
    let started = false;

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;

        sb.include(OfficeAttachmentEntity).withQuery();

        // Widen the polymorphic attachment field so a template can hold one of these.
        overrideImplementedBy(EmailTemplateEntity_Attachment, "attachment",
            () => [ImageAttachmentEntity, FileTokenAttachmentEntity, OfficeAttachmentEntity]);

        // The fileName is a text template, so its tokens must join the message's single query.
        EmailTemplateLogic.registerFillAttachmentTokens<OfficeAttachmentEntity>(OfficeAttachmentEntity, (a, ctx) => {
            if (a.fileName != null && a.fileName !== "")
                TextTemplateParser.parse(a.fileName, ctx.queryName, ctx.modelType).fillQueryTokens(ctx.queryTokens);
        });

        EmailTemplateLogic.registerGenerateAttachment<OfficeAttachmentEntity>(OfficeAttachmentEntity, async (a, ctx) => {
            // Signum: `wa.OverrideModel?.RetrieveAndRemember() ?? ctx.Entity ?? ctx.Model!.UntypedEntity`.
            let entity: Entity | null = a.overrideModel != null
                ? await retrieve(a.overrideModel.entityType as Type<Entity>, a.overrideModel.id)
                : ctx.entity ?? (ctx.model?.untypedEntity ?? null);

            if (a.modelConverter != null && entity != null)
                entity = TemplatingLogic.convert(a.modelConverter, entity);

            const template = await OfficeTemplateLogic.getFromCache(a.officeTemplate);

            // A template whose model can be built from the entity alone gets one; one that needs extra
            // parameters cannot be built here, so the report runs off the query instead (Signum's check).
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
                type: EmailAttachmentTypeEnum.Attachment,
            }];
        });
    }
}

/** Signum's GetTemplateString — the attachment's own fileName template, memoised per attachment row. */
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
