import { createTransport, type Transporter, type SendMailOptions } from "nodemailer";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { FilePathEmbeddedLogic } from "@altea/altea-files/server/FilePathEmbeddedLogic.server";
import { mimeType } from "@altea/altea-files/server/FileTypeAlgorithm.server";
import { EmailMessageEntity } from "../data/EmailMessage";
import { EmailAttachmentTypeEnum } from "../data/EmailTemplate";
import { EmailRecipientKindEnum, type EmailAddressEmbedded, type EmailRecipientBaseEntity } from "../data/Email";
import {
    SmtpDeliveryMethodEnum, type EmailSenderConfigurationEntity, type SmtpEmailServiceEntity,
} from "../data/EmailSenderConfiguration";
import { EmailSenderBase } from "./EmailSenderBase.server";
import { EmailLogic } from "./EmailLogic.server";
import { EmailSenderConfigurationLogic } from "./EmailSenderConfigurationLogic.server";

// Port of Signum.Mailing's SmtpSender.cs + the SmtpClient half of EmailSenderConfigurationLogic.cs.
//
// altea divergences, documented inline:
//  - .NET's `SmtpClient` / `MailMessage` → **nodemailer** (node has no SMTP client of its own). The mapping
//    is one-to-one: To/Cc/Bcc, an `html` or `text` body, `attachments` for EmailAttachmentType.Attachment and
//    the same list with `cid` set for LinkedResource (nodemailer's inline-resource form).
//  - `SmtpDeliveryMethod.SpecifiedPickupDirectory` → nodemailer's `streamTransport` written to that folder as
//    an `.eml` file; `PickupDirectoryFromIis` has no counterpart on a non-Windows host and is REJECTED with a
//    clear message rather than silently doing nothing.
//  - `SmtpDeliveryFormat` (SevenBit / International) → nodemailer negotiates SMTPUTF8 itself, so the field is
//    stored and shown but not passed through.
//  - `ClientCertificationFiles` are loaded into `tls.cert`.
//  - Signum's `ServicePoint.MaxIdleTime = 2` (a .NET connection-pool workaround) has no counterpart.

export class SmtpSender extends EmailSenderBase {
    constructor(senderConfig: EmailSenderConfigurationEntity, private readonly smtp: SmtpEmailServiceEntity) {
        super(senderConfig);
    }

    protected override async sendInternal(email: EmailMessageEntity): Promise<void> {
        const message = this.createMailMessage(email);

        await HeavyProfiler.log("SMTP-Send", async () => {
            const transporter = await createTransporter(this.smtp);
            try {
                await transporter.sendMail(message);
            } finally {
                transporter.close();
            }
        });
    }

    private createMailMessage(email: EmailMessageEntity): SendMailOptions {
        const attachments = email.attachments.map(a => ({
            filename: a.file.fileName,
            content: Buffer.from(FilePathEmbeddedLogic.readAllBytesSync(a.file)),
            contentType: mimeType(a.file.fileName),
            // A LinkedResource is an INLINE resource the HTML body references as `cid:<contentId>`.
            ...(a.type === EmailAttachmentTypeEnum.LinkedResource ? { cid: a.contentId } : {}),
        }));

        return {
            from: formatAddress(email.from),
            to: recipientsOfKind(email, EmailRecipientKindEnum.To),
            cc: recipientsOfKind(email, EmailRecipientKindEnum.Cc),
            bcc: recipientsOfKind(email, EmailRecipientKindEnum.Bcc),
            subject: email.subject ?? "",
            ...(email.isBodyHtml ? { html: email.body.text ?? "" } : { text: email.body.text ?? "" }),
            attachments,
        };
    }
}

/** Signum's `SmtpExtensions.ToMailAddress(EmailAddressEmbedded)`. */
function formatAddress(address: EmailAddressEmbedded): string {
    return address.displayName ? `"${address.displayName.replace(/"/g, "'")}" <${address.emailAddress}>` : address.emailAddress;
}

/** Signum's `ToMailAddress(EmailRecipientEmbedded)` — honours OverrideEmailAddress (the test catch-all) and
 *  refuses to build an address at all when sending is off. */
function formatRecipient(recipient: EmailRecipientBaseEntity): string {
    const config = EmailLogic.configuration();
    if (!config.sendEmails)
        throw new Error("EmailConfigurationEmbedded.sendEmails is set to false");

    const address = config.overrideEmailAddress || recipient.emailAddress;
    return recipient.displayName ? `"${recipient.displayName.replace(/"/g, "'")}" <${address}>` : address;
}

function recipientsOfKind(email: EmailMessageEntity, kind: EmailRecipientKindEnum): string[] {
    return email.recipients.filter(r => r.kind === kind).map(formatRecipient);
}

/** Signum's `GenerateSmtpClient(SmtpEmailServiceEntity)`. */
export async function createTransporter(config: SmtpEmailServiceEntity): Promise<Transporter> {
    if (!EmailLogic.configuration().sendEmails)
        throw new Error("EmailLogic.configuration().sendEmails is set to false");

    switch (config.deliveryMethod) {
        case SmtpDeliveryMethodEnum.Network: {
            const network = config.network;
            if (network == null)
                throw new Error("SmtpEmailServiceEntity.network is not set for a Network delivery method");

            const fs = await import("node:fs/promises");
            const certs: Buffer[] = [];
            for (const cc of network.clientCertificationFiles)
                certs.push(await fs.readFile(cc.fullFilePath));

            return createTransport({
                host: network.host,
                port: network.port,
                secure: network.enableSSL && network.port === 465,
                requireTLS: network.enableSSL && network.port !== 465,
                auth: network.username
                    ? { user: network.username, pass: EmailSenderConfigurationLogic.decryptPassword(network.password ?? "") }
                    : undefined,
                tls: certs.length > 0 ? { cert: certs.map(c => c.toString()) } : undefined,
            });
        }
        case SmtpDeliveryMethodEnum.SpecifiedPickupDirectory: {
            if (!config.pickupDirectoryLocation)
                throw new Error("SmtpEmailServiceEntity.pickupDirectoryLocation is not set for a SpecifiedPickupDirectory delivery method");

            return createPickupDirectoryTransport(config.pickupDirectoryLocation);
        }
        default:
            throw new Error("SmtpDeliveryMethod.PickupDirectoryFromIis has no counterpart outside IIS — use SpecifiedPickupDirectory");
    }
}

/** `SpecifiedPickupDirectory`: build the message and write it to the folder as an .eml, sending nothing. */
function createPickupDirectoryTransport(directory: string): Transporter {
    const transporter = createTransport({ streamTransport: true, buffer: true, newline: "windows" });

    const original = transporter.sendMail.bind(transporter);
    transporter.sendMail = (async (mail: SendMailOptions) => {
        const info = await original(mail) as { messageId: string; message: Buffer };
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        await fs.mkdir(directory, { recursive: true });
        const name = info.messageId.replace(/[<>:"/\\|?*]/g, "_") + ".eml";
        await fs.writeFile(path.join(directory, name), info.message);
        return info;
    }) as typeof transporter.sendMail;

    return transporter;
}
