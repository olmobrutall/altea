import { table } from "@altea/altea/server/table";
import { Enum } from "@altea/altea/data/enum";
import { toInt } from "@altea/altea/data/basics";
import {
    FilterOperation, FilterGroupOperation, OrderType, DashboardBehaviour,
} from "@altea/altea/data/dynamicQueries";
import { UserAssetsImporter, syncRows, rowGuid } from "@altea/altea-user-assets/server/UserAssetsImportExport";
import type { IToXmlContext, IFromXmlContext, BinaryStore } from "@altea/altea-user-assets/server/UserAssetsImportExport";
import { A, str, bool, num, enumOr, first, list, arr, token } from "@altea/altea-user-assets/server/XmlUtils";
import { CultureInfoLogic, type CultureLookup } from "@altea/altea/server/cultureInfoLogic";
import { cultureNameOf, type CultureInfoEntity } from "@altea/altea/data/cultureInfoEntity";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import {
    EmailAddressSource, EmailAttachmentType, EmailMasterTemplateEntity, EmailMasterTemplateEntity_Attachment,
    EmailMasterTemplateEntity_Message, EmailMessageFormat, EmailTemplateEntity, EmailTemplateEntity_Attachment,
    EmailTemplateEntity_Filter, EmailTemplateFromEmbedded, EmailTemplateEntity_Message, EmailTemplateEntity_Order,
    EmailTemplateEntity_Recipient, FileTokenAttachmentEntity, ImageAttachmentEntity, WhenManyFromBehaviour,
    WhenManyRecipientsBehaviour, WhenNoneFromBehaviour, WhenNoneRecipientsBehaviour,
    TemplateApplicableEval, type IAttachmentGeneratorEntity,
} from "../data/EmailTemplate";
import { EmailRecipientKind } from "../data/Email";
import { FileEmbedded } from "@altea/altea-files/data/Files";
import { EmailModelLogic } from "./EmailModelLogic";

// Port of Signum.Mailing's `EmailTemplateEntity.ToXml/FromXml` + `EmailMasterTemplateEntity.ToXml/FromXml`.
// altea keeps this OFF the isomorphic entity (System.Xml is server-only) and registers a (de)serializer with
// UserAssetsImporter — the shape @altea/altea-user-queries' UserQueriesXml.server established. The XML shape
// (element / attribute names) is preserved so a Signum-produced file round-trips.
//
// altea divergences, documented inline:
//  - `Guid` → the asset's uuid PRIMARY KEY (the importer keys on it).
//  - `CultureInfo` attributes carry the locale TAG (Signum writes the CultureInfoEntity's Name too), so an
//    exported template stays readable and portable between databases whose culture ids differ.
//  - `Applicable` was a C# SCRIPT element in Signum; altea exports the TemplateApplicableSymbol's KEY
//    instead (see @altea/altea-templating's data/Templating.ts). A file carrying a script imports with the
//    predicate left unset — the template then applies to everything, which is the safe reading.
//  - An enum attribute keeps Signum's member NAME (`Enum.toName`), while the in-memory value is the ordinal.
//  - `MessageFormat`'s legacy `IsBodyHtml` fallback is preserved.

export function registerEmailTemplateXml(): void {
    UserAssetsImporter.register<EmailTemplateEntity>({
        elementName: "EmailTemplate",
        create: () => new EmailTemplateEntity(),
        load: async guid => (await table(EmailTemplateEntity).filter(t => t.id == guid).toArray() as EmailTemplateEntity[])[0],
        save: async t => { await t.save(); },
        toXml: templateToXml,
        fromXml: templateFromXml,
    });
}

export function registerEmailMasterTemplateXml(): void {
    UserAssetsImporter.register<EmailMasterTemplateEntity>({
        elementName: "EmailMasterTemplate",
        create: () => new EmailMasterTemplateEntity(),
        load: async guid => (await table(EmailMasterTemplateEntity).filter(t => t.id == guid).toArray() as EmailMasterTemplateEntity[])[0],
        save: async t => { await t.save(); },
        toXml: masterToXml,
        fromXml: masterFromXml,
    });
}

// ---- EmailTemplate ------------------------------------------------------------------------------------

async function templateToXml(et: EmailTemplateEntity, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const o: Record<string, unknown> = {};
    o[A + "Name"] = et.name;
    o[A + "DisableAuthorization"] = et.disableAuthorization;
    if (et.query != null) o[A + "Query"] = et.query.key;
    o[A + "EditableMessage"] = et.editableMessage;
    if (et.model != null) o[A + "Model"] = et.model.className;
    if (et.masterTemplate != null) o[A + "MasterTemplate"] = ctx.include(await ctx.retrieveLite(et.masterTemplate));
    o[A + "GroupResults"] = et.groupResults;
    o[A + "MessageFormat"] = Enum.toName(EmailMessageFormat, et.messageFormat);

    if (et.filters.length) o["Filters"] = { Filter: et.filters.map(filterXml) };
    if (et.orders.length) o["Orders"] = { Orden: et.orders.map(orderXml) };

    if (et.from != null) o["From"] = addressXml(et.from, {
        [A + "WhenMany"]: Enum.toName(WhenManyFromBehaviour, et.from.whenMany),
        [A + "WhenNone"]: Enum.toName(WhenNoneFromBehaviour, et.from.whenNone),
    });

    o["Recipients"] = {
        Recipient: et.recipients.map(r => addressXml(r, {
            [A + "Kind"]: Enum.toName(EmailRecipientKind, r.kind),
            [A + "WhenMany"]: Enum.toName(WhenManyRecipientsBehaviour, r.whenMany),
            [A + "WhenNone"]: Enum.toName(WhenNoneRecipientsBehaviour, r.whenNone),
        })),
    };

    if (et.attachments.length) o["Attachments"] = attachmentsXml(et.attachments.map(r => r.attachment), ctx.binary);

    o["Messages"] = {
        Message: et.messages.map(m => ({
            [A + "CultureInfo"]: cultureNameOf(m.cultureInfo),
            [A + "Subject"]: m.subject,
            "#text": m.text,
        })),
    };

    if (et.applicable != null) o["Applicable"] = { "#cdata": et.applicable.script };

    return o;
}

async function templateFromXml(et: EmailTemplateEntity, xml: Record<string, unknown>, ctx: IFromXmlContext): Promise<void> {
    et.name = str(xml[A + "Name"])!;
    et.disableAuthorization = bool(xml[A + "DisableAuthorization"]);
    et.query = xml[A + "Query"] != undefined ? ctx.getQuery(str(xml[A + "Query"])!) : null;
    et.editableMessage = bool(xml[A + "EditableMessage"], true);
    et.model = null; // filled below when the model is registered
    et.groupResults = bool(xml[A + "GroupResults"]);

    et.messageFormat = xml[A + "MessageFormat"] != undefined
        ? Enum.toValue(EmailMessageFormat, str(xml[A + "MessageFormat"]) as never)
        : (bool(xml[A + "IsBodyHtml"]) ? EmailMessageFormat.HtmlComplex : EmailMessageFormat.PlainText);

    if (xml[A + "MasterTemplate"] != undefined)
        et.masterTemplate = (ctx.getEntity(str(xml[A + "MasterTemplate"])!) as EmailMasterTemplateEntity).toLite();

    et.filters = syncRows(et.filters ?? [], arr(xml["Filters"], "Filter"),
        () => new EmailTemplateEntity_Filter(), (f, x) => {
            f.indentation = toInt(num(x[A + "Indentation"]) ?? 0);
            if (x[A + "GroupOperation"] != undefined) {
                f.isGroup = true;
                f.groupOperation = Enum.toValue(FilterGroupOperation, str(x[A + "GroupOperation"]) as never);
            }
            if (x[A + "Token"] != undefined) f.token = token(str(x[A + "Token"])!);
            if (x[A + "Operation"] != undefined) f.operation = Enum.toValue(FilterOperation, str(x[A + "Operation"]) as never);
            if (x[A + "Value"] != undefined) f.valueString = str(x[A + "Value"])!;
            // A `DashboardBehaviour` attribute is IGNORED: a template's filters drive no dashboard, so the
            // row has no such member (see QueryFilterPinnedBaseEntity). A file written by an application
            // that shared one filter type with its user queries may still carry it.
        });

    // No Guid per order / recipient (int-PK rows): syncRows matches them by position, so an unchanged row
    // is REUSED and keeps its snapshot — a fresh row would read as a change in every preview.
    et.orders = syncRows(et.orders ?? [], arr(xml["Orders"], "Orden"),
        () => new EmailTemplateEntity_Order(), (o, x) => {
            o.token = token(str(x[A + "Token"])!);
            o.orderType = Enum.toValue(OrderType, str(x[A + "OrderType"]) as never);
        });

    const fromXmlEl = first(xml["From"]);
    if (fromXmlEl == undefined) {
        et.from = null;
    } else {
        const f = new EmailTemplateFromEmbedded();
        readAddress(f, fromXmlEl);
        f.whenMany = enumOr(WhenManyFromBehaviour, str(fromXmlEl[A + "WhenMany"]), WhenManyFromBehaviour.FistResult);
        f.whenNone = enumOr(WhenNoneFromBehaviour, str(fromXmlEl[A + "WhenNone"]), WhenNoneFromBehaviour.NoMessage);
        et.from = f;
    }

    et.recipients = syncRows(et.recipients ?? [], arr(xml["Recipients"], "Recipient"),
        () => new EmailTemplateEntity_Recipient(), (r, x) => {
            readAddress(r, x);
            r.kind = enumOr(EmailRecipientKind, str(x[A + "Kind"]), EmailRecipientKind.To);
            r.whenMany = enumOr(WhenManyRecipientsBehaviour, str(x[A + "WhenMany"]), WhenManyRecipientsBehaviour.KeepOneMessageWithManyRecipients);
            r.whenNone = enumOr(WhenNoneRecipientsBehaviour, str(x[A + "WhenNone"]), WhenNoneRecipientsBehaviour.ThrowException);
        });

    const cultures = await CultureInfoLogic.lookup();
    et.messages = syncByCulture(et.messages ?? [], arr(xml["Messages"], "Message"), cultures,
        c => EmailTemplateEntity_Message.create({ cultureInfo: c, subject: "", text: "" }), (m, x) => {
            m.subject = str(x[A + "Subject"]) ?? "";
            m.text = str(x["#text"]) ?? "";
        });

    et.attachments = syncAttachments(et.attachments ?? [], xml["Attachments"], ctx.binary,
        a => EmailTemplateEntity_Attachment.create({ attachment: a }));

    // Signum's `Applicable = element.Element("Applicable")?.Let(app => new TemplateApplicableEval { Script =
    // app.Value })`. Round-trips verbatim now that the script IS the stored value.
    const applicableScript = str(xml["Applicable"]);
    et.applicable = applicableScript == undefined ? null
        : TemplateApplicableEval.create({ script: applicableScript });

    // The model is resolved by its registry key; an unregistered one is left unset rather than failing the
    // whole import (the template still opens, with an error on the Model field).
    const modelName = str(xml[A + "Model"]);
    if (modelName != undefined) {
        // AWAITED: this used to be a fire-and-forget `void …then()`, which raced the save that follows —
        // the model was usually still null when the row was written.
        try {
            et.model = await EmailModelLogic.getEmailModelEntity(modelName);
        } catch {
            /* not registered in this database — left unset */
        }
    }
}

// ---- EmailMasterTemplate -------------------------------------------------------------------------------

function masterToXml(emt: EmailMasterTemplateEntity, ctx: IToXmlContext): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    o[A + "Name"] = emt.name ?? "";
    o["Messages"] = {
        Message: emt.messages.map(m => ({ [A + "CultureInfo"]: cultureNameOf(m.cultureInfo), "#text": m.text })),
    };
    if (emt.attachments.length) o["Attachments"] = attachmentsXml(emt.attachments.map(r => r.attachment), ctx.binary);
    return o;
}

async function masterFromXml(emt: EmailMasterTemplateEntity, xml: Record<string, unknown>, ctx: IFromXmlContext): Promise<void> {
    emt.name = str(xml[A + "Name"])!;
    const cultures = await CultureInfoLogic.lookup();
    emt.messages = syncByCulture(emt.messages ?? [], arr(xml["Messages"], "Message"), cultures,
        c => EmailMasterTemplateEntity_Message.create({ cultureInfo: c, text: "" }), (m, x) => {
            m.text = str(x["#text"]) ?? "";
        });
    emt.attachments = syncAttachments(emt.attachments ?? [], xml["Attachments"], ctx.binary,
        a => EmailMasterTemplateEntity_Attachment.create({ attachment: a }));
}

// ---- shared pieces -------------------------------------------------------------------------------------

function addressXml(a: EmailTemplateFromEmbedded | EmailTemplateEntity_Recipient, extra: Record<string, unknown>): Record<string, unknown> {
    const x: Record<string, unknown> = { ...extra };
    if (a.displayName) x[A + "DisplayName"] = a.displayName;
    if (a.emailAddress) x[A + "EmailAddress"] = a.emailAddress;
    if (a.token != null) x[A + "Token"] = a.token.tokenString;
    x[A + "AddressSource"] = Enum.toName(EmailAddressSource, a.addressSource);
    return x;
}

function readAddress(a: EmailTemplateFromEmbedded | EmailTemplateEntity_Recipient, x: Record<string, unknown>): void {
    a.displayName = str(x[A + "DisplayName"]) ?? null;
    a.emailAddress = str(x[A + "EmailAddress"]) ?? null;
    a.token = x[A + "Token"] != undefined ? token(str(x[A + "Token"])!) : null;
    a.addressSource = x[A + "AddressSource"] != undefined
        ? Enum.toValue(EmailAddressSource, str(x[A + "AddressSource"]) as never)
        : (a.emailAddress ? EmailAddressSource.HardcodedAddress : EmailAddressSource.QueryToken);
}

function filterXml(f: EmailTemplateEntity_Filter): Record<string, unknown> {
    const x: Record<string, unknown> = { ...rowGuid(f) };
    x[A + "Indentation"] = f.indentation;
    if (f.isGroup) {
        if (f.groupOperation != null) x[A + "GroupOperation"] = Enum.toName(FilterGroupOperation, f.groupOperation);
        if (f.token != null) x[A + "Token"] = f.token.tokenString;
    } else {
        if (f.token != null) x[A + "Token"] = f.token.tokenString;
        if (f.operation != null) x[A + "Operation"] = Enum.toName(FilterOperation, f.operation);
        if (f.valueString != null) x[A + "Value"] = f.valueString;
    }
    return x;
}

function orderXml(o: EmailTemplateEntity_Order): Record<string, unknown> {
    return { [A + "Token"]: o.token.tokenString, [A + "OrderType"]: Enum.toName(OrderType, o.orderType) };
}

/** Signum's AttachmentFromXmlExtensions: an attachment element is named after its TYPE. */
function attachmentsXml(attachments: readonly IAttachmentGeneratorEntity[], binary: BinaryStore): Record<string, unknown> {
    const result: Record<string, unknown[]> = {};
    for (const a of attachments) {
        if (a instanceof ImageAttachmentEntity) {
            (result["ImageAttachment"] ??= []).push({
                ...(a.fileName != null ? { [A + "FileName"]: a.fileName } : {}),
                [A + "ContentId"]: a.contentId,
                [A + "Type"]: Enum.toName(EmailAttachmentType, a.type),
                File: { [A + "FileName"]: a.file.fileName, ...binary.write(a.file.fileName, a.file.binaryFile) },
            });
        } else if (a instanceof FileTokenAttachmentEntity) {
            (result["FileTokenAttachment"] ??= []).push({
                ...(a.fileName != null ? { [A + "FileName"]: a.fileName } : {}),
                ...(a.contentId != null ? { [A + "ContentId"]: a.contentId } : {}),
                [A + "Type"]: Enum.toName(EmailAttachmentType, a.type),
                [A + "FileToken"]: a.fileToken.tokenString,
            });
        }
        // An app's own attachment type is skipped rather than exported wrongly (Signum threw on an
        // unregistered TypeMapping entry; skipping keeps the rest of the template portable).
    }
    return result;
}

/**
 * The message rows, matched by CULTURE — what identifies a message (a template has at most one per
 * culture). A matched row is REUSED, so it keeps its id and snapshot and an unchanged one is no change; a
 * culture the template lacks gets a new row, and a row whose culture the file no longer has is dropped.
 */
function syncByCulture<T extends Entity & { cultureInfo: Lite<CultureInfoEntity> }>(
    current: T[],
    elements: Record<string, unknown>[],
    cultures: CultureLookup,
    create: (culture: Lite<CultureInfoEntity>) => T,
    sync: (row: T, xml: Record<string, unknown>) => void,
): T[] {
    const unused = [...current];
    return elements.map(x => {
        const culture = cultures.get(str(x[A + "CultureInfo"])!).toLite();
        const index = unused.findIndex(m => m.cultureInfo != null && m.cultureInfo.id == culture.id);
        const row = index === -1 ? create(culture) : unused.splice(index, 1)[0];
        sync(row, x);
        return row;
    });
}

/**
 * The attachment rows, REUSING a current row — and the attachment entity behind it — whose attachment is of
 * the same type, updated in place (an image's bytes included: a blob compares by content in the snapshot,
 * so equal bytes are no change). A fresh attachment would read as a change in every preview.
 *
 * The XML groups the elements by type (Signum's AttachmentFromXmlExtensions names each after it), so it
 * cannot say how images and file tokens interleave. Positions are therefore counted PER TYPE — the k-th
 * `ImageAttachment` element is the k-th image row — and the reused rows keep their current order, new ones
 * appended; taking the file's order instead would report every interleaved template as changed.
 */
function syncAttachments<R extends Entity & { attachment: IAttachmentGeneratorEntity }>(
    current: R[],
    xml: unknown,
    binary: BinaryStore,
    createRow: (attachment: IAttachmentGeneratorEntity) => R,
): R[] {
    const container = first(xml);
    const reused = new Set<R>();
    const created: R[] = [];

    function sync<T extends IAttachmentGeneratorEntity>(elements: Record<string, unknown>[], type: new () => T,
        create: () => T, fill: (a: T, x: Record<string, unknown>) => void): void {
        const sameType = current.filter(r => r.attachment instanceof type);
        elements.forEach((x, i) => {
            const row = sameType[i];
            if (row != undefined) {
                fill(row.attachment as T, x);
                reused.add(row);
            } else {
                const a = create();
                fill(a, x);
                created.push(createRow(a));
            }
        });
    }

    sync(list(container?.["ImageAttachment"]), ImageAttachmentEntity,
        // `file` is created here: the embedded has no initializer, so a bare create() left it undefined and
        // reading an image into a NEW row threw.
        () => ImageAttachmentEntity.create({
            fileName: null, contentId: "", type: EmailAttachmentType.Attachment,
            file: FileEmbedded.create({ fileName: "", binaryFile: new Uint8Array(0) }),
        }), (a, x) => {
        a.fileName = str(x[A + "FileName"]) ?? null;
        a.contentId = str(x[A + "ContentId"])!;
        a.type = enumOr(EmailAttachmentType, str(x[A + "Type"]), EmailAttachmentType.Attachment);
        const file = first(x["File"]);
        if (file != undefined) {
            a.file.fileName = str(file[A + "FileName"]) ?? "";
            a.file.binaryFile = binary.read(file);
        }
    });

    sync(list(container?.["FileTokenAttachment"]), FileTokenAttachmentEntity,
        () => FileTokenAttachmentEntity.create({ fileName: null, contentId: null, type: EmailAttachmentType.Attachment, fileToken: token("") }), (a, x) => {
        a.fileName = str(x[A + "FileName"]) ?? null;
        a.contentId = str(x[A + "ContentId"]) ?? null;
        a.type = enumOr(EmailAttachmentType, str(x[A + "Type"]), EmailAttachmentType.Attachment);
        a.fileToken = token(str(x[A + "FileToken"])!);
    });

    return [...current.filter(r => reused.has(r)), ...created];
}
