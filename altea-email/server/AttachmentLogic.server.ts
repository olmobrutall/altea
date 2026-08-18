import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { randomUUID } from "node:crypto";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { retrieve } from "@altea/altea/server/Database";
import type { Type } from "@altea/altea/data/entity";
import { TextTemplateParser } from "@altea/altea-templating/server/TextTemplateParser.server";
import { TextTemplateParameters } from "@altea/altea-templating/server/TextTemplateParser.Nodes.server";
import type { BlockNode } from "@altea/altea-templating/server/TextTemplateParser.Nodes.server";
import { FileEmbedded, FilePathEmbedded } from "@altea/altea-files/data/Files";
import { FilePathEmbeddedLogic } from "@altea/altea-files/server/FilePathEmbeddedLogic.server";
import { FileTokenAttachmentEntity, ImageAttachmentEntity } from "../data/EmailTemplate";
import {
    EmailTemplateLogic, type GeneratedAttachment, type GenerateAttachmentContext,
} from "./EmailTemplateLogic.server";

// Port of Signum.Mailing's Templates/ImageAttachmentLogic.cs + FileTokenAttachmentLogic.cs — the two
// built-in attachment RULES:
//   • ImageAttachment      — a fixed file stored on the template (typically an inline logo).
//   • FileTokenAttachment  — whatever FILE the rendered rows' token points at.
//
// altea divergences, documented inline:
//  - Signum produced a `FilePathEmbedded` directly (it knew EmailFileType.Attachment). altea's generators
//    return BYTES + a name (GeneratedAttachment) and the renderer writes them into the store, so a generator
//    needs no file-store knowledge — and a custom one is a pure function.
//  - Signum's `[Ignore] object FileNameNode` (the memoised parse tree of the name template) becomes a
//    WeakMap keyed by the attachment row, for the same reason EmailTemplateLogic keeps its message trees off
//    the entity.
//  - `Validator.PropertyValidator(...).StaticPropertyValidation` (validating the name TEMPLATE parses) is a
//    server-side validation Signum attaches to the isomorphic property. altea has no server-only property
//    validator hook, so the check happens where it matters: generating the attachment throws with the parse
//    error, and the template editor shows the same error through the templating toolbar.

const fileNameNodes = new WeakMap<object, BlockNode>();

export namespace AttachmentLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        startImageAttachment(sb);
        startFileTokenAttachment(sb);
    }

    /** Signum's ImageAttachmentLogic.Start. */
    // The attachment TABLES need no include here: each is an @implementedBy target of an attachment row's
    // @valueField, so the SchemaBuilder includes it with the template. What this registers is the BEHAVIOUR.
    export function startImageAttachment(_sb: SchemaBuilder): void {
        EmailTemplateLogic.registerFillAttachmentTokens<ImageAttachmentEntity>(ImageAttachmentEntity, (a, ctx) => {
            if (a.fileName != null)
                TextTemplateParser.parse(a.fileName, ctx.queryName, ctx.modelType).fillQueryTokens(ctx.queryTokens);
        });

        EmailTemplateLogic.registerGenerateAttachment<ImageAttachmentEntity>(ImageAttachmentEntity, async (a, ctx) => {
            return CultureInfo.withCultures(ctx.culture, () => {
                const fileName = !a.fileName ? a.file.fileName : templateString(a, a.fileName, ctx);
                return [{
                    fileName,
                    bytes: a.file.binaryFile,
                    contentId: a.contentId,
                    type: a.type,
                } satisfies GeneratedAttachment];
            });
        });
    }

    /** Signum's FileTokenAttachmentLogic.Start. */
    export function startFileTokenAttachment(_sb: SchemaBuilder): void {
        EmailTemplateLogic.registerFillAttachmentTokens<FileTokenAttachmentEntity>(FileTokenAttachmentEntity, (a, ctx) => {
            if (a.fileName != null)
                TextTemplateParser.parse(a.fileName, ctx.queryName, ctx.modelType).fillQueryTokens(ctx.queryTokens);

            ctx.queryTokens.push(QueryLogic.getToken(ctx.queryName, a.fileToken.tokenString, SubTokensOptionsAll));
        });

        EmailTemplateLogic.registerGenerateAttachment<FileTokenAttachmentEntity>(FileTokenAttachmentEntity, async (a, ctx) => {
            const qc = ctx.queryContext;
            if (qc == undefined)
                throw new Error(`FileTokenAttachment '${a.fileToken.tokenString}' needs a query — the template has none`);

            const column = qc.column(QueryLogic.getToken(qc.queryName, a.fileToken.tokenString, SubTokensOptionsAll));

            // The distinct files the rows point at; a lite is retrieved, an embedded file used as-is.
            const seen = new Set<string>();
            const files: { fileName: string; bytes: Uint8Array }[] = [];
            for (const row of qc.currentRows) {
                const value = column.values[row.index];
                if (value == null)
                    continue;

                const key = value instanceof Lite ? "l:" + value.key()
                    : value instanceof Entity ? "e:" + value.toLite().key()
                        : "o:" + String(files.length);
                if (seen.has(key))
                    continue;
                seen.add(key);

                files.push(await readFile(value));
            }

            const overridenFileName = !a.fileName ? undefined
                : CultureInfo.withCultures(ctx.culture, () => templateString(a, a.fileName!, ctx));

            return files.map(f => ({
                fileName: overridenFileName ?? f.fileName,
                bytes: f.bytes,
                contentId: a.contentId || randomUUID(),
                type: a.type,
            } satisfies GeneratedAttachment));
        });
    }
}

/** Print an attachment's NAME template (Signum's GetTemplateString), memoising the parse tree. */
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

/** The bytes behind whatever a file token yielded: a FileEmbedded / FilePathEmbedded value, or a Lite to an
 *  entity that holds one. */
async function readFile(value: unknown): Promise<{ fileName: string; bytes: Uint8Array }> {
    if (value instanceof FileEmbedded)
        return { fileName: value.fileName, bytes: value.binaryFile };

    if (value instanceof FilePathEmbedded)
        return { fileName: value.fileName, bytes: await FilePathEmbeddedLogic.readAllBytes(value) };

    const entity = value instanceof Lite
        ? await retrieve(value.entityType as Type<Entity>, value.id)
        : value;

    // An entity that HOLDS a file: take its first file-shaped field (Signum required the token's type to be
    // an IFile; altea has no such interface, so the shape is what is checked).
    for (const candidate of Object.values(entity as object)) {
        if (candidate instanceof FileEmbedded || candidate instanceof FilePathEmbedded)
            return await readFile(candidate);
    }

    throw new Error(`A FileTokenAttachment's token yielded '${String(value)}', which holds no file`);
}
