import { table } from "@altea/altea/server/table";
import { Enum } from "@altea/altea/data/enum";
import { toInt } from "@altea/altea/data/basics";
import {
    FilterOperationEnum, FilterGroupOperationEnum, OrderTypeEnum, DashboardBehaviourEnum,
} from "@altea/altea/data/dynamicQueries";
import { UserAssetsImporter } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import type { IToXmlContext, IFromXmlContext } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import {
    EmailAddressSourceEnum, EmailAttachmentTypeEnum, EmailMasterTemplateEntity, EmailMasterTemplateEntity_Message,
    EmailMessageFormatEnum, EmailTemplateEntity, EmailTemplateEntity_Filter, EmailTemplateEntity_From,
    EmailTemplateEntity_Message, EmailTemplateEntity_Order, EmailTemplateEntity_Recipient, FileTokenAttachmentEntity,
    ImageAttachmentEntity, WhenManyFromBehaviourEnum, WhenManyRecipientsBehaviourEnum, WhenNoneFromBehaviourEnum,
    WhenNoneRecipientsBehaviourEnum, type IAttachmentGeneratorEntity,
} from "../data/EmailTemplate";
import { EmailRecipientKindEnum } from "../data/Email";
import { EmailModelLogic } from "./EmailModelLogic.server";

// Port of Signum.Mailing's `EmailTemplateEntity.ToXml/FromXml` + `EmailMasterTemplateEntity.ToXml/FromXml`.
// altea keeps this OFF the isomorphic entity (System.Xml is server-only) and registers a (de)serializer with
// UserAssetsImporter — the shape @altea/altea-user-queries' UserQueriesXml.server established. The XML shape
// (element / attribute names) is preserved so a Signum-produced file round-trips.
//
// altea divergences, documented inline:
//  - `Guid` → the asset's uuid PRIMARY KEY (the importer keys on it).
//  - `CultureInfo` attributes carry the plain locale string (altea has no CultureInfoEntity).
//  - `Applicable` was a C# SCRIPT element in Signum; altea exports the TemplateApplicableSymbol's KEY
//    instead (see @altea/altea-templating's data/Templating.ts). A file carrying a script imports with the
//    predicate left unset — the template then applies to everything, which is the safe reading.
//  - An enum attribute keeps Signum's member NAME (`Enum.toName`), while the in-memory value is the ordinal.
//  - `MessageFormat`'s legacy `IsBodyHtml` fallback is preserved.

const A = "@_"; // fast-xml-parser attribute prefix

export function registerEmailTemplateXml(): void {
    UserAssetsImporter.register<EmailTemplateEntity>({
        elementName: "EmailTemplate",
        create: () => new EmailTemplateEntity(),
        load: async guid => (await table(EmailTemplateEntity).filter(t => t.id == guid).toArray() as EmailTemplateEntity[])[0],
        save: async t => { await (t as unknown as { save(): Promise<void> }).save(); },
        toXml: templateToXml,
        fromXml: templateFromXml,
    });
}

export function registerEmailMasterTemplateXml(): void {
    UserAssetsImporter.register<EmailMasterTemplateEntity>({
        elementName: "EmailMasterTemplate",
        create: () => new EmailMasterTemplateEntity(),
        load: async guid => (await table(EmailMasterTemplateEntity).filter(t => t.id == guid).toArray() as EmailMasterTemplateEntity[])[0],
        save: async t => { await (t as unknown as { save(): Promise<void> }).save(); },
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
    if (et.model != null) o[A + "Model"] = et.model.fullClassName;
    if (et.masterTemplate != null) o[A + "MasterTemplate"] = ctx.include(await ctx.retrieveLite(et.masterTemplate));
    o[A + "GroupResults"] = et.groupResults;
    o[A + "MessageFormat"] = Enum.toName(EmailMessageFormatEnum, et.messageFormat);

    if (et.filters.length) o["Filters"] = { Filter: et.filters.map(filterXml) };
    if (et.orders.length) o["Orders"] = { Orden: et.orders.map(orderXml) };

    if (et.from != null) o["From"] = addressXml(et.from, {
        [A + "WhenMany"]: Enum.toName(WhenManyFromBehaviourEnum, et.from.whenMany),
        [A + "WhenNone"]: Enum.toName(WhenNoneFromBehaviourEnum, et.from.whenNone),
    });

    o["Recipients"] = {
        Recipient: et.recipients.map(r => addressXml(r, {
            [A + "Kind"]: Enum.toName(EmailRecipientKindEnum, r.kind),
            [A + "WhenMany"]: Enum.toName(WhenManyRecipientsBehaviourEnum, r.whenMany),
            [A + "WhenNone"]: Enum.toName(WhenNoneRecipientsBehaviourEnum, r.whenNone),
        })),
    };

    if (et.attachments.length) o["Attachments"] = attachmentsXml(et.attachments);

    o["Messages"] = {
        Message: et.messages.map(m => ({
            [A + "CultureInfo"]: m.culture,
            [A + "Subject"]: m.subject,
            "#text": m.text,
        })),
    };

    if (et.applicable != null) o["Applicable"] = { [A + "Symbol"]: et.applicable.key };

    return o;
}

function templateFromXml(et: EmailTemplateEntity, xml: Record<string, unknown>, ctx: IFromXmlContext): void {
    et.name = str(xml[A + "Name"])!;
    et.disableAuthorization = bool(xml[A + "DisableAuthorization"]) ?? false;
    et.query = xml[A + "Query"] != undefined ? ctx.getQuery(str(xml[A + "Query"])!) : null;
    et.editableMessage = bool(xml[A + "EditableMessage"]) ?? true;
    et.model = null; // filled below when the model is registered
    et.groupResults = bool(xml[A + "GroupResults"]) ?? false;

    et.messageFormat = xml[A + "MessageFormat"] != undefined
        ? Enum.toValue(EmailMessageFormatEnum, str(xml[A + "MessageFormat"]) as never)
        : (bool(xml[A + "IsBodyHtml"]) ? EmailMessageFormatEnum.HtmlComplex : EmailMessageFormatEnum.PlainText);

    if (xml[A + "MasterTemplate"] != undefined)
        et.masterTemplate = (ctx.getEntity(str(xml[A + "MasterTemplate"])!) as EmailMasterTemplateEntity).toLite();

    et.filters = list(asRecord(xml["Filters"])?.["Filter"]).map((x, i) => {
        const f = new EmailTemplateEntity_Filter();
        f.order = toInt(i);
        f.indentation = toInt(num(x[A + "Indentation"]) ?? 0);
        if (x[A + "GroupOperation"] != undefined) {
            f.isGroup = true;
            f.groupOperation = Enum.toValue(FilterGroupOperationEnum, str(x[A + "GroupOperation"]) as never);
        }
        if (x[A + "Token"] != undefined) f.token = token(str(x[A + "Token"])!);
        if (x[A + "Operation"] != undefined) f.operation = Enum.toValue(FilterOperationEnum, str(x[A + "Operation"]) as never);
        if (x[A + "Value"] != undefined) f.valueString = str(x[A + "Value"])!;
        if (x[A + "DashboardBehaviour"] != undefined)
            f.dashboardBehaviour = Enum.toValue(DashboardBehaviourEnum, str(x[A + "DashboardBehaviour"]) as never);
        return f;
    });

    et.orders = list(asRecord(xml["Orders"])?.["Orden"]).map((x, i) => {
        const o = new EmailTemplateEntity_Order();
        o.order = toInt(i);
        o.token = token(str(x[A + "Token"])!);
        o.orderType = Enum.toValue(OrderTypeEnum, str(x[A + "OrderType"]) as never);
        return o;
    });

    const fromXmlEl = asRecord(xml["From"]);
    if (fromXmlEl == undefined) {
        et.from = null;
    } else {
        const f = new EmailTemplateEntity_From();
        readAddress(f, fromXmlEl);
        f.whenMany = enumOr(WhenManyFromBehaviourEnum, str(fromXmlEl[A + "WhenMany"]), WhenManyFromBehaviourEnum.FistResult);
        f.whenNone = enumOr(WhenNoneFromBehaviourEnum, str(fromXmlEl[A + "WhenNone"]), WhenNoneFromBehaviourEnum.NoMessage);
        et.from = f;
    }

    et.recipients = list(asRecord(xml["Recipients"])?.["Recipient"]).map((x, i) => {
        const r = new EmailTemplateEntity_Recipient();
        r.order = toInt(i);
        readAddress(r, x);
        r.kind = enumOr(EmailRecipientKindEnum, str(x[A + "Kind"]), EmailRecipientKindEnum.To);
        r.whenMany = enumOr(WhenManyRecipientsBehaviourEnum, str(x[A + "WhenMany"]), WhenManyRecipientsBehaviourEnum.KeepOneMessageWithManyRecipients);
        r.whenNone = enumOr(WhenNoneRecipientsBehaviourEnum, str(x[A + "WhenNone"]), WhenNoneRecipientsBehaviourEnum.ThrowException);
        return r;
    });

    et.messages = list(asRecord(xml["Messages"])?.["Message"]).map((x, i) => {
        const m = new EmailTemplateEntity_Message();
        m.order = toInt(i);
        m.culture = str(x[A + "CultureInfo"])!;
        m.subject = str(x[A + "Subject"]) ?? "";
        m.text = str(x["#text"]) ?? "";
        return m;
    });

    et.attachments = readAttachments(xml["Attachments"]);

    // Signum stored a C# script here; altea stores a symbol KEY (see the header). A file with a script has
    // no `Symbol` attribute, so the predicate is simply left unset.
    et.applicable = null;

    // The model is resolved by its registry key; an unregistered one is left unset rather than failing the
    // whole import (the template still opens, with an error on the Model field).
    const modelName = str(xml[A + "Model"]);
    if (modelName != undefined) {
        void EmailModelLogic.getEmailModelEntity(modelName)
            .then(m => { et.model = m; })
            .catch(() => { /* not registered here — left unset */ });
    }
}

// ---- EmailMasterTemplate -------------------------------------------------------------------------------

function masterToXml(emt: EmailMasterTemplateEntity, _ctx: IToXmlContext): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    o[A + "Name"] = emt.name ?? "";
    o["Messages"] = {
        Message: emt.messages.map(m => ({ [A + "CultureInfo"]: m.culture, "#text": m.text })),
    };
    if (emt.attachments.length) o["Attachments"] = attachmentsXml(emt.attachments);
    return o;
}

function masterFromXml(emt: EmailMasterTemplateEntity, xml: Record<string, unknown>, _ctx: IFromXmlContext): void {
    emt.name = str(xml[A + "Name"])!;
    emt.messages = list(asRecord(xml["Messages"])?.["Message"]).map((x, i) => {
        const m = new EmailMasterTemplateEntity_Message();
        m.order = toInt(i);
        m.culture = str(x[A + "CultureInfo"])!;
        m.text = str(x["#text"]) ?? "";
        return m;
    });
    emt.attachments = readAttachments(xml["Attachments"]);
}

// ---- shared pieces -------------------------------------------------------------------------------------

function addressXml(a: EmailTemplateEntity_From | EmailTemplateEntity_Recipient, extra: Record<string, unknown>): Record<string, unknown> {
    const x: Record<string, unknown> = { ...extra };
    if (a.displayName) x[A + "DisplayName"] = a.displayName;
    if (a.emailAddress) x[A + "EmailAddress"] = a.emailAddress;
    if (a.token != null) x[A + "Token"] = a.token.tokenString;
    x[A + "AddressSource"] = Enum.toName(EmailAddressSourceEnum, a.addressSource);
    return x;
}

function readAddress(a: EmailTemplateEntity_From | EmailTemplateEntity_Recipient, x: Record<string, unknown>): void {
    a.displayName = str(x[A + "DisplayName"]) ?? null;
    a.emailAddress = str(x[A + "EmailAddress"]) ?? null;
    a.token = x[A + "Token"] != undefined ? token(str(x[A + "Token"])!) : null;
    a.addressSource = x[A + "AddressSource"] != undefined
        ? Enum.toValue(EmailAddressSourceEnum, str(x[A + "AddressSource"]) as never)
        : (a.emailAddress ? EmailAddressSourceEnum.HardcodedAddress : EmailAddressSourceEnum.QueryToken);
}

function filterXml(f: EmailTemplateEntity_Filter): Record<string, unknown> {
    const x: Record<string, unknown> = {};
    x[A + "Indentation"] = f.indentation;
    if (f.isGroup) {
        if (f.groupOperation != null) x[A + "GroupOperation"] = Enum.toName(FilterGroupOperationEnum, f.groupOperation);
        if (f.token != null) x[A + "Token"] = f.token.tokenString;
    } else {
        if (f.token != null) x[A + "Token"] = f.token.tokenString;
        if (f.operation != null) x[A + "Operation"] = Enum.toName(FilterOperationEnum, f.operation);
        if (f.valueString != null) x[A + "Value"] = f.valueString;
    }
    if (f.dashboardBehaviour != null) x[A + "DashboardBehaviour"] = Enum.toName(DashboardBehaviourEnum, f.dashboardBehaviour);
    return x;
}

function orderXml(o: EmailTemplateEntity_Order): Record<string, unknown> {
    return { [A + "Token"]: o.token.tokenString, [A + "OrderType"]: Enum.toName(OrderTypeEnum, o.orderType) };
}

/** Signum's AttachmentFromXmlExtensions: an attachment element is named after its TYPE. */
function attachmentsXml(attachments: readonly IAttachmentGeneratorEntity[]): Record<string, unknown> {
    const result: Record<string, unknown[]> = {};
    for (const a of attachments) {
        if (a instanceof ImageAttachmentEntity) {
            (result["ImageAttachment"] ??= []).push({
                ...(a.fileName != null ? { [A + "FileName"]: a.fileName } : {}),
                [A + "ContentId"]: a.contentId,
                [A + "Type"]: Enum.toName(EmailAttachmentTypeEnum, a.type),
                File: { [A + "FileName"]: a.file.fileName, "#text": Buffer.from(a.file.binaryFile).toString("base64") },
            });
        } else if (a instanceof FileTokenAttachmentEntity) {
            (result["FileTokenAttachment"] ??= []).push({
                ...(a.fileName != null ? { [A + "FileName"]: a.fileName } : {}),
                ...(a.contentId != null ? { [A + "ContentId"]: a.contentId } : {}),
                [A + "Type"]: Enum.toName(EmailAttachmentTypeEnum, a.type),
                [A + "FileToken"]: a.fileToken.tokenString,
            });
        }
        // An app's own attachment type is skipped rather than exported wrongly (Signum threw on an
        // unregistered TypeMapping entry; skipping keeps the rest of the template portable).
    }
    return result;
}

function readAttachments(xml: unknown): IAttachmentGeneratorEntity[] {
    const container = asRecord(xml);
    if (container == undefined)
        return [];

    const result: IAttachmentGeneratorEntity[] = [];

    for (const x of list(container["ImageAttachment"])) {
        const a = new ImageAttachmentEntity();
        a.fileName = str(x[A + "FileName"]) ?? null;
        a.contentId = str(x[A + "ContentId"])!;
        a.type = enumOr(EmailAttachmentTypeEnum, str(x[A + "Type"]), EmailAttachmentTypeEnum.Attachment);
        const file = asRecord(x["File"]);
        if (file != undefined) {
            a.file.fileName = str(file[A + "FileName"]) ?? "";
            a.file.binaryFile = new Uint8Array(Buffer.from(str(file["#text"]) ?? "", "base64"));
        }
        result.push(a);
    }

    for (const x of list(container["FileTokenAttachment"])) {
        const a = new FileTokenAttachmentEntity();
        a.fileName = str(x[A + "FileName"]) ?? null;
        a.contentId = str(x[A + "ContentId"]) ?? null;
        a.type = enumOr(EmailAttachmentTypeEnum, str(x[A + "Type"]), EmailAttachmentTypeEnum.Attachment);
        a.fileToken = token(str(x[A + "FileToken"])!);
        result.push(a);
    }

    return result;
}

function token(tokenString: string): QueryTokenEmbedded {
    const qte = new QueryTokenEmbedded();
    qte.tokenString = tokenString;
    return qte;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function list(value: unknown): Record<string, unknown>[] {
    if (value == null) return [];
    const array = Array.isArray(value) ? value : [value];
    return array.map(v => typeof v === "object" && v != null ? v as Record<string, unknown> : { "#text": v });
}

function str(value: unknown): string | undefined {
    return value == null ? undefined : String(value);
}

function num(value: unknown): number | undefined {
    return value == null ? undefined : Number(value);
}

function bool(value: unknown): boolean | undefined {
    return value == null ? undefined : value === true || value === "true" || value === "True";
}

function enumOr<E extends object>(e: E, name: string | undefined, fallback: number): number {
    if (name == undefined)
        return fallback;
    try {
        return Enum.toValue(e as never, name as never);
    } catch {
        return fallback;
    }
}
