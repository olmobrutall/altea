import { simpleParser, type AddressObject, type Attachment, type EmailAddress, type ParsedMail } from "mailparser";
import { randomUUID } from "node:crypto";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal } from "@altea/altea/data/basics";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { FilePathEmbedded } from "@altea/altea-files/data/Files";
import { EmailFromEmbedded, EmailRecipientKindEnum } from "@altea/altea-email/data/Email";
import { EmailAttachmentTypeEnum } from "@altea/altea-email/data/EmailTemplate";
import {
    EmailMessageEntity, EmailMessageEntity_Attachment, EmailMessageEntity_Recipient, EmailMessageStateEnum,
} from "@altea/altea-email/data/EmailMessage";
import { EmailLogic } from "@altea/altea-email/server/EmailLogic.server";
import {
    EmailReceptionInfoEmbedded, EmailReceptionMixin, type EmailReceptionEntity,
} from "@altea/altea-email/data/EmailReception";
import type { Lite } from "@altea/altea/data/lite";
import type { FileTypeSymbol } from "@altea/altea-files/data/Files";

// Port of the MIME half of Signum.Mailing.Pop3's MailKitPop3Client.cs — turn one received message into an
// EmailMessageEntity (plus the reception info the mixin carries).
//
// altea divergences, documented inline:
//  - `MimeKit` becomes **mailparser** (nodemailer's own parser — this package already depends on nodemailer
//    for SENDING, so the two halves speak the same library family). `MimeMessage` becomes `ParsedMail`, and
//    the two-pass "walk BodyParts for inline parts, then walk Attachments" collapses into mailparser's one
//    `attachments` array, which already carries `contentDisposition`, `contentId` and `related`.
//  - **winmail.dat (TNEF) is NOT unpacked.** Signum extracts a `TnefPart`'s inner attachments and, when one of
//    them is the body, uses it as the message body. mailparser has no TNEF decoder and there is no maintained
//    one on npm; a `winmail.dat` therefore arrives as an ordinary attachment, which is what every non-Outlook
//    client shows too. Flagged rather than silently dropped: the `winMailConverted` branch of Signum's
//    ToEmailMessage has no counterpart here.
//  - `MessagePart` (an attached .eml) needs no special case: mailparser reports a `message/rfc822` attachment
//    with its raw content, which is exactly the `.eml` Signum writes out by hand.
//  - `GroupAddress` flattening is `flattenAddresses` below (mailparser nests a group's members under `group`).
//  - `Encoding.ASCII.GetString(...)` for the raw content becomes latin-1, so a non-ASCII byte survives the
//    round-trip into `rawContent` instead of becoming "?".
//  - `SetCalculateHash` is `EmailLogic.calculateBodyHash` — one formula shared with the save hook.

/** Signum's `EmailAddressMaxLengt` (the typo is Signum's) — an address longer than the column is dropped. */
export let emailAddressMaxLength = 100;

/**
 * Signum's `ToEmailMessage(MimeMessage)` + the `GetMessage` wrapper that stamps the reception info.
 * `attachmentFileType` is the store the attachments are written to (Signum's `EmailFileType.Attachment`).
 */
export async function toEmailMessage(
    source: Buffer,
    uniqueId: string,
    reception: Lite<EmailReceptionEntity>,
    attachmentFileType: FileTypeSymbol,
): Promise<EmailMessageEntity> {

    const parsed = await simpleParser(source, { skipTextToHtml: true, skipTextLinks: true });

    const email = EmailMessageEntity.create({
        editableMessage: false,
        from: fromOf(parsed),
        recipients: [],
        state: EmailMessageStateEnum.Received,
        // Signum: a subject with a newline in it would break every list that shows one.
        subject: (parsed.subject ?? "No Subject").replace(/[\r\n]/g, " "),
        body: BigStringEmbedded.create({ text: null }),
        attachments: [],
    });

    addRecipients(email, parsed.to, EmailRecipientKindEnum.To);
    addRecipients(email, parsed.cc, EmailRecipientKindEnum.Cc);
    addRecipients(email, parsed.bcc, EmailRecipientKindEnum.Bcc);

    for (const attachment of parsed.attachments)
        addAttachment(email, attachment, attachmentFileType);

    // Signum: some servers only record the actual mailbox in `Delivered-To`.
    const delivered = trimAndClean(headerValue(parsed, "delivered-to"));
    if (delivered != null && !email.recipients.some(r => r.emailAddress === delivered))
        email.recipients.push(EmailMessageEntity_Recipient.create({
            displayName: null,
            emailAddress: delivered,
            invalidEmail: !isValidAddress(delivered),
            kind: EmailRecipientKindEnum.Bcc,
        }));

    splitCommaSeparatedRecipients(email);

    // Signum's body selection: HTML if there is one, else the plain text.
    email.isBodyHtml = hasText(parsed.html === false ? null : parsed.html);
    email.body.text = email.isBodyHtml ? (parsed.html as string) : (parsed.text ?? null);

    email.mixin(EmailReceptionMixin).receptionInfo = EmailReceptionInfoEmbedded.create({
        uniqueId,
        reception,
        rawContent: BigStringEmbedded.create({ text: source.toString("latin1") }),
        sentDate: sentDateOf(parsed),
        receivedDate: Clock.now,
        deletionDate: null,
    });

    email.bodyHash = EmailLogic.calculateBodyHash(email);

    return email;
}

/** Signum's From selection: the From address, else Reply-To, else a placeholder marked `invalidEmail`. */
function fromOf(parsed: ParsedMail): EmailFromEmbedded {
    const first = flattenAddresses(parsed.from)[0] ?? flattenAddresses(parsed.replyTo)[0];

    if (first != null)
        return EmailFromEmbedded.create({
            emailAddress: first.address!,
            displayName: hasText(first.name) ? first.name : first.address!,
            invalidEmail: !isValidAddress(first.address!),
        });

    return EmailFromEmbedded.create({
        emailAddress: "Missing FROM and ReplyTo -" + (parsed.messageId ?? ""),
        invalidEmail: true,
        displayName: "Missing FROM and ReplyTo",
    });
}

function addRecipients(email: EmailMessageEntity, addresses: AddressObject | AddressObject[] | undefined, kind: EmailRecipientKindEnum): void {
    for (const a of flattenAddresses(addresses))
        email.recipients.push(EmailMessageEntity_Recipient.create({
            emailAddress: a.address!,
            displayName: hasText(a.name) ? a.name : null,
            invalidEmail: !isValidAddress(a.address!),
            kind,
        }));
}

/**
 * Signum's `GetMailboxAddress(InternetAddressList)` — every real mailbox in a header, group members
 * included, dropping anything longer than the column can hold.
 */
function flattenAddresses(addresses: AddressObject | AddressObject[] | undefined): EmailAddress[] {
    if (addresses == undefined)
        return [];

    const all = Array.isArray(addresses) ? addresses : [addresses];

    const result: EmailAddress[] = [];
    for (const object of all)
        for (const value of object.value ?? []) {
            // A GROUP has no address of its own; its members are under `group`.
            if (value.group != undefined)
                result.push(...value.group.filter(m => hasText(m.address)));
            else if (hasText(value.address))
                result.push(value);
        }

    return result.filter(a => a.address!.length <= emailAddressMaxLength);
}

/** Signum's `AddAttachment` — skip a duplicate (same stored bytes), and never lose the content id. */
function addAttachment(email: EmailMessageEntity, attachment: Attachment, fileType: FileTypeSymbol): void {
    const fileName = fixFileName(attachment.filename ?? nameOf(attachment));

    const file = FilePathEmbedded.create({ fileType, fileName });
    file.binaryFile = new Uint8Array(attachment.content);

    const row = EmailMessageEntity_Attachment.create({
        // Signum: a missing content id is replaced by a generated one, so the field stays required.
        contentId: hasText(attachment.contentId) ? attachment.contentId! : ("NotSet" + randomUUID()).substring(0, 20),
        file,
        // An INLINE image is a LinkedResource (the body references it by content id); anything explicitly
        // dispositioned `attachment`, or not an image at all, is a real attachment.
        type: !attachment.contentType.includes("image") || attachment.contentDisposition === "attachment"
            ? EmailAttachmentTypeEnum.Attachment : EmailAttachmentTypeEnum.LinkedResource,
    });

    // Signum de-duplicates on the file HASH, which is only filled once the file is stored; before the save
    // the equivalent is the bytes themselves, so compare length + name (what the hash is over, cheaply).
    const duplicate = email.attachments.some(a =>
        a.file.fileName === row.file.fileName && a.file.binaryFile?.length === row.file.binaryFile?.length);

    if (!duplicate)
        email.attachments.push(row);
}

/** Signum's `FixFilename` — strip what a file system cannot hold, and never end up with an empty name. */
function fixFileName(fileName: string): string {
    // The same set FilePathEmbedded's own validator rejects, plus the control characters.
    let clean = fileName.replace(/[\\/:*?"<>| -]/g, "_");

    if (clean.length > 250)
        // Signum's `Substring(250)` keeps the TAIL, which drops the start of the name and keeps the
        // extension; that is almost certainly what was meant, so it is kept.
        clean = clean.substring(clean.length - 250);

    return clean.length === 0 ? "NoFileName" : clean;
}

/** Signum's `GetName(ContentType)` — a name for an attachment that came without one. */
function nameOf(attachment: Attachment): string {
    if (attachment.contentType === "text/calendar")
        return "calendar.ics";

    const subtype = attachment.contentType.includes("/")
        ? attachment.contentType.substring(attachment.contentType.indexOf("/") + 1)
        : null;

    return subtype == null ? "noname.unknown" : `noname.${subtype.replace(/[^a-z0-9]/gi, "")}`;
}

/** Signum's split of a recipient whose address field actually holds several, comma-separated. */
function splitCommaSeparatedRecipients(email: EmailMessageEntity): void {
    const splitable = email.recipients.filter(r => r.emailAddress.includes(","));

    for (const original of splitable) {
        for (const address of original.emailAddress.split(",")) {
            const trimmed = address.trim();
            if (trimmed === "")
                continue;

            email.recipients.push(EmailMessageEntity_Recipient.create({
                displayName: original.displayName,
                emailAddress: trimmed,
                invalidEmail: !isValidAddress(trimmed),
                kind: original.kind,
            }));
        }

        email.recipients.splice(email.recipients.indexOf(original), 1);
    }
}

/** Signum's `message.Date.UtcDateTime == DateTime.MinValue ? Clock.Now.ToUniversalTime() : …`. */
function sentDateOf(parsed: ParsedMail): Temporal.PlainDateTime {
    if (parsed.date == undefined)
        return Clock.now;

    return Temporal.Instant.fromEpochMilliseconds(parsed.date.getTime())
        .toZonedDateTimeISO("UTC").toPlainDateTime();
}

function headerValue(parsed: ParsedMail, name: string): string | undefined {
    const value = parsed.headers.get(name);
    return typeof value === "string" ? value : undefined;
}

/** Signum's `TrimAndClean` — strip surrounding quotes and any embedded whitespace control characters. */
function trimAndClean(value: string | undefined): string | null {
    if (value == undefined || value === "")
        return null;

    let clean = value.trim();
    if (clean.startsWith("'") || clean.startsWith('"'))
        clean = clean.substring(1);
    if (clean.endsWith("'") || clean.endsWith('"'))
        clean = clean.substring(0, clean.length - 1);

    return clean.replace(/[\t\n\r]/g, "");
}

function hasText(value: string | null | undefined): boolean {
    return value != undefined && value !== "";
}

/** Whether the address is well-formed enough for altea's own EMailValidator to accept it. A received message
 *  keeps a malformed address (marked `invalidEmail`) rather than failing to be stored — Signum's rule. */
function isValidAddress(address: string): boolean {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address);
}
