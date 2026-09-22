import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { FilePathEmbeddedLogic } from "@altea/altea-files/server/FilePathEmbeddedLogic";
import type { EmailMessageEntity } from "@altea/altea-email/data/EmailMessage";
import { EmailAttachmentType } from "@altea/altea-email/data/EmailTemplate";
import {
    EmailRecipientKind, type EmailAddressEmbedded, type EmailRecipientBaseEntity,
} from "@altea/altea-email/data/Email";
import type { EmailSenderConfigurationEntity } from "@altea/altea-email/data/EmailSenderConfiguration";
import { EmailLogic } from "@altea/altea-email/server/EmailLogic";
import { EmailSenderBase } from "@altea/altea-email/server/EmailSenderBase";
import { EmailSenderConfigurationLogic } from "@altea/altea-email/server/EmailSenderConfigurationLogic";
import { ExchangeVersion, type ExchangeWebServiceEmailServiceEntity } from "../data/MailingExchangeWS";
import { ExchangeWebServices, escapeXml, type ExchangeCredentials } from "./ExchangeWebServices";

// Send one EmailMessage through Exchange Web Services. The transport is in ExchangeWebServices.ts; this
// file is the message MAPPING and the send FLOW.
//
// Sending with attachments is THREE requests, not one: EWS ignores an `<Attachments>` element inside
// `CreateItem`, so it is CreateItem(SaveOnly) → CreateAttachment per file → SendItem. With no attachments
// it is a single CreateItem(SendAndSaveCopy).
//
// `From` is deliberately NOT set: Exchange sends as the authenticated mailbox, and setting it would need
// "Send As" rights the configuration says nothing about. `email.from` is still the address AUTODISCOVER
// looks up.
//
// Port of Signum.Mailing.ExchangeWS's ExchangeWebServiceSender.cs — see port/MailingExchange.md.

export class ExchangeWebServiceSender extends EmailSenderBase {

    constructor(senderConfig: EmailSenderConfigurationEntity, private readonly exchange: ExchangeWebServiceEmailServiceEntity) {
        super(senderConfig);
    }

    protected override async sendInternal(email: EmailMessageEntity): Promise<void> {
        using _prof = HeavyProfiler.log("ExchangeWS-Send");

        const credentials: ExchangeCredentials = {
            username: this.exchange.username,
            password: this.exchange.password == null ? null
                : EmailSenderConfigurationLogic.decryptPassword(this.exchange.password),
            useDefaultCredentials: this.exchange.useDefaultCredentials,
        };

        const url = this.exchange.url
            ? this.exchange.url
            : await ExchangeWebServices.autodiscoverUrl(email.from.emailAddress, credentials);

        const version = ExchangeVersion[this.exchange.exchangeVersion];

        // Only real attachments: inline LinkedResources are dropped (see port/MailingExchange.md).
        const attachments = email.attachments.filter(a => a.type === EmailAttachmentType.Attachment);

        if (attachments.length === 0)
            await this.sendDirectly(url, version, credentials, email);
        else
            await this.sendWithAttachments(url, version, credentials, email, attachments);
    }

    /** No attachments: one CreateItem that saves to Sent Items and sends. */
    private async sendDirectly(
        url: string,
        version: string,
        credentials: ExchangeCredentials,
        email: EmailMessageEntity,
    ): Promise<void> {
        await ExchangeWebServices.call(url, version,
            `<m:CreateItem MessageDisposition="SendAndSaveCopy">`
            + `<m:SavedItemFolderId><t:DistinguishedFolderId Id="sentitems" /></m:SavedItemFolderId>`
            + `<m:Items>${this.messageXml(email)}</m:Items>`
            + `</m:CreateItem>`,
            credentials);
    }

    /** With attachments: save a draft, add each file to it, then send the draft (see the header). */
    private async sendWithAttachments(
        url: string,
        version: string,
        credentials: ExchangeCredentials,
        email: EmailMessageEntity,
        attachments: EmailMessageEntity["attachments"],
    ): Promise<void> {
        const created = await ExchangeWebServices.call(url, version,
            `<m:CreateItem MessageDisposition="SaveOnly">`
            + `<m:SavedItemFolderId><t:DistinguishedFolderId Id="drafts" /></m:SavedItemFolderId>`
            + `<m:Items>${this.messageXml(email)}</m:Items>`
            + `</m:CreateItem>`,
            credentials);

        let itemId = readItemId(created, "CreateItemResponse");

        for (const attachment of attachments) {
            const bytes = await FilePathEmbeddedLogic.readAllBytes(attachment.file);

            const attached = await ExchangeWebServices.call(url, version,
                `<m:CreateAttachment>`
                + `<m:ParentItemId Id="${escapeXml(itemId.id)}" ChangeKey="${escapeXml(itemId.changeKey)}" />`
                + `<m:Attachments><t:FileAttachment>`
                + `<t:Name>${escapeXml(attachment.file.fileName)}</t:Name>`
                + (attachment.contentId ? `<t:ContentId>${escapeXml(attachment.contentId)}</t:ContentId>` : "")
                + `<t:Content>${Buffer.from(bytes).toString("base64")}</t:Content>`
                + `</t:FileAttachment></m:Attachments>`
                + `</m:CreateAttachment>`,
                credentials);

            // Every CreateAttachment bumps the parent's ChangeKey; SendItem needs the CURRENT one, so it is
            // read back from the attachment's RootItemId (which is what EWS reports it in).
            itemId = readRootItemId(attached) ?? itemId;
        }

        await ExchangeWebServices.call(url, version,
            `<m:SendItem SaveItemToFolder="true">`
            + `<m:ItemIds><t:ItemId Id="${escapeXml(itemId.id)}" ChangeKey="${escapeXml(itemId.changeKey)}" /></m:ItemIds>`
            + `<m:SavedItemFolderId><t:DistinguishedFolderId Id="sentitems" /></m:SavedItemFolderId>`
            + `</m:SendItem>`,
            credentials);
    }

    /**
     * The child ORDER is not cosmetic: `t:Message` is an xsd SEQUENCE (Subject, Body, Attachments, …
     * ToRecipients, CcRecipients, BccRecipients, … From), and Exchange rejects a message whose elements
     * arrive out of order.
     */
    private messageXml(email: EmailMessageEntity): string {
        return `<t:Message>`
            + `<t:Subject>${escapeXml(email.subject ?? "")}</t:Subject>`
            + `<t:Body BodyType="${email.isBodyHtml ? "HTML" : "Text"}">${escapeXml(email.body.text ?? "")}</t:Body>`
            + mailboxes("ToRecipients", email, EmailRecipientKind.To)
            + mailboxes("CcRecipients", email, EmailRecipientKind.Cc)
            + mailboxes("BccRecipients", email, EmailRecipientKind.Bcc)
            + `</t:Message>`;
    }
}

interface ItemId { id: string; changeKey: string }

function readItemId(body: import("./ExchangeWebServices").ExchangeElement, responseName: string): ItemId {
    const itemId = body.get(responseName)?.get("ResponseMessages")?.get("CreateItemResponseMessage")
        ?.get("Items")?.get("Message")?.get("ItemId");

    const id = itemId?.attribute("Id");
    const changeKey = itemId?.attribute("ChangeKey");
    if (id == undefined || changeKey == undefined)
        throw new Error("Exchange Web Services' CreateItem response carried no ItemId — the draft was not saved.");

    return { id, changeKey };
}

function readRootItemId(body: import("./ExchangeWebServices").ExchangeElement): ItemId | undefined {
    const rootItemId = body.get("CreateAttachmentResponse")?.get("ResponseMessages")
        ?.get("CreateAttachmentResponseMessage")?.get("Attachments")?.get("FileAttachment")
        ?.get("AttachmentId");

    const id = rootItemId?.attribute("RootItemId");
    const changeKey = rootItemId?.attribute("RootItemChangeKey");
    return id != undefined && changeKey != undefined ? { id, changeKey } : undefined;
}

/** Kept for symmetry with SmtpSender, even though this sender never sets a From (see the header). */
export function mailbox(address: EmailAddressEmbedded): string {
    return `<t:Mailbox>`
        + (address.displayName ? `<t:Name>${escapeXml(address.displayName)}</t:Name>` : "")
        + `<t:EmailAddress>${escapeXml(address.emailAddress)}</t:EmailAddress>`
        + `</t:Mailbox>`;
}

/** Honours OverrideEmailAddress (the test catch-all) and refuses to build an address at all when sending
 *  is off. */
function recipientMailbox(recipient: EmailRecipientBaseEntity): string {
    const config = EmailLogic.configurationLoaded();
    if (!config.sendEmails)
        throw new Error("EmailConfigurationEmbedded.sendEmails is set to false");

    const address = config.overrideEmailAddress || recipient.emailAddress;
    return `<t:Mailbox>`
        + (recipient.displayName ? `<t:Name>${escapeXml(recipient.displayName)}</t:Name>` : "")
        + `<t:EmailAddress>${escapeXml(address)}</t:EmailAddress>`
        + `</t:Mailbox>`;
}

function mailboxes(element: string, email: EmailMessageEntity, kind: EmailRecipientKind): string {
    const recipients = email.recipients.filter(r => r.kind === kind);
    if (recipients.length === 0)
        return "";

    return `<t:${element}>${recipients.map(recipientMailbox).join("")}</t:${element}>`;
}
