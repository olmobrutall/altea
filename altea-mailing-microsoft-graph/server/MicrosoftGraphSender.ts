import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { FilePathEmbeddedLogic } from "@altea/altea-files/server/FilePathEmbeddedLogic.server";
import { mimeType } from "@altea/altea-files/server/FileTypeAlgorithm.server";
import type { EmailMessageEntity } from "@altea/altea-email/data/EmailMessage";
import { EmailAttachmentTypeEnum } from "@altea/altea-email/data/EmailTemplate";
import {
    EmailRecipientKindEnum, type EmailAddressEmbedded, type EmailRecipientBaseEntity,
} from "@altea/altea-email/data/Email";
import type { EmailSenderConfigurationEntity } from "@altea/altea-email/data/EmailSenderConfiguration";
import { EmailLogic } from "@altea/altea-email/server/EmailLogic.server";
import { EmailSenderBase } from "@altea/altea-email/server/EmailSenderBase.server";
import { EmailSenderConfigurationLogic } from "@altea/altea-email/server/EmailSenderConfigurationLogic.server";
import { AzureADConfigurationEmbedded } from "@altea/altea-auth-azuread/data/AzureAD";
import { AzureADLogic } from "@altea/altea-auth-azuread/server/AzureADLogic";
import { MicrosoftGraph } from "@altea/altea-auth-azuread/server/MicrosoftGraph";
import type { MicrosoftGraphEmailServiceEntity } from "../data/MailingMicrosoftGraph";

// Port of Signum.Mailing.MicrosoftGraph's MicrosoftGraphSender.cs — send one EmailMessage through the Graph
// `sendMail` endpoint, as the FROM address's own mailbox.
//
// altea divergences, documented inline:
//  - `GraphServiceClient` + `Azure.Identity` become the REST helper altea-auth-azuread already has (see its
//    MicrosoftGraph.ts header for why). `GeTokenCredential()` becomes `graphConfig()` below: either the app's
//    own Entra registration (`useActiveDirectoryConfiguration`) or this service's three fields, expressed as
//    the same AzureADConfigurationEmbedded the helper takes. `SignumTokenCredentials.OverridenTokenCredential`
//    is honoured too — the helper checks its own AsyncLocalStorage override first.
//  - `senderUser.SendMail.PostAsync(...)` and the big-attachment `LargeFileUploadTask` become explicit REST:
//    `POST /users/{id}/sendMail` for the small case, and — over the 3 MB limit — `POST /users/{id}/messages`,
//    then a chunked upload session per big attachment, then `POST …/send`. Signum's flow exactly, including
//    its 320 KB slice size (Graph requires a multiple of 320 KiB for all but the last slice).
//  - `email.From.AzureUserId` is carried over as-is; altea fills it from the email owner's `externalId`
//    through the EmailOwnerData registry (see altea-email's data/Email.ts), so an app whose owners do not
//    supply one cannot send through Graph — which the error below says outright.
//  - `ODataException` (Signum's wrapper that surfaces Graph's inner error) is unnecessary: the REST helper
//    already puts the response body in the error message.

/** Signum's `MicrosoftGraphFileSizeLimit` — over this, an attachment needs an upload session. */
export let microsoftGraphFileSizeLimit = 3 * 1024 * 1024;

/** Graph requires every slice but the last to be a multiple of 320 KiB (Signum's `maxSliceSize`). */
const uploadSliceSize = 320 * 1024;

export class MicrosoftGraphSender extends EmailSenderBase {

    constructor(senderConfig: EmailSenderConfigurationEntity, private readonly microsoftGraph: MicrosoftGraphEmailServiceEntity) {
        super(senderConfig);
    }

    protected override async sendInternal(email: EmailMessageEntity): Promise<void> {
        using _prof = HeavyProfiler.log("MicrosoftGraph-Send");

        const config = this.graphConfig();

        const userId = email.from.azureUserId;
        if (!userId)
            throw new Error(`Cannot send through Microsoft Graph: the From address '${email.from.emailAddress}' has`
                + " no azureUserId (the directory object id of the sending mailbox). It is filled from the email"
                + " owner's externalId — see EmailLogic.registerEmailOwner.");

        const { message, bigAttachments } = await this.toGraphMessage(email);

        await sendMessage(config, userId, message, bigAttachments);
    }

    /**
     * Signum's `GeTokenCredential()` — which Entra registration this send authenticates with. NOTE the
     * `useActiveDirectoryConfiguration` branch reaches into the AUTH module's configuration on purpose: the
     * point of the flag is not to duplicate the tenant's client secret in the mail settings.
     */
    private graphConfig(): AzureADConfigurationEmbedded {
        if (this.microsoftGraph.useActiveDirectoryConfiguration)
            return AzureADLogic.requireConfig();

        const { azure_DirectoryID, azure_ApplicationID, azure_ClientSecret } = this.microsoftGraph;
        if (azure_DirectoryID == null || azure_ApplicationID == null || azure_ClientSecret == null)
            throw new Error("MicrosoftGraphEmailServiceEntity is missing its Azure directory / application id"
                + " or client secret (and useActiveDirectoryConfiguration is not set).");

        return AzureADConfigurationEmbedded.create({
            directoryID: azure_DirectoryID,
            applicationID: azure_ApplicationID,
            clientSecret: EmailSenderConfigurationLogic.decryptPassword(azure_ClientSecret),
        });
    }

    /** Signum's ToGraphMessage, splitting off the attachments that need an upload session. */
    private async toGraphMessage(email: EmailMessageEntity): Promise<{ message: GraphMessage; bigAttachments: GraphFileAttachment[] }> {
        const attachments: GraphFileAttachment[] = [];
        for (const a of email.attachments) {
            const bytes = await FilePathEmbeddedLogic.readAllBytes(a.file);
            attachments.push({
                "@odata.type": "#microsoft.graph.fileAttachment",
                contentId: a.contentId,
                name: a.file.fileName,
                isInline: a.type === EmailAttachmentTypeEnum.LinkedResource,
                contentType: mimeType(a.file.fileName) ?? "application/octet-stream",
                contentBytes: Buffer.from(bytes).toString("base64"),
                size: bytes.length,
            });
        }

        const bigAttachments = attachments.filter(a => a.size > microsoftGraphFileSizeLimit);
        const small = attachments.filter(a => a.size <= microsoftGraphFileSizeLimit);

        return {
            message: {
                subject: email.subject ?? "",
                body: {
                    content: email.body.text ?? "",
                    contentType: email.isBodyHtml ? "html" : "text",
                },
                from: recipientOf(email.from),
                toRecipients: recipientsOfKind(email, EmailRecipientKindEnum.To),
                ccRecipients: recipientsOfKind(email, EmailRecipientKindEnum.Cc),
                bccRecipients: recipientsOfKind(email, EmailRecipientKindEnum.Bcc),
                attachments: small,
            },
            bigAttachments,
        };
    }
}

/**
 * Signum's static `SendMessage(senderUser, message)` — exported for the same reason it is public there: an
 * app that composes a Graph message itself can send it through the same path.
 */
export async function sendMessage(
    config: AzureADConfigurationEmbedded,
    userId: string,
    message: GraphMessage,
    bigAttachments: GraphFileAttachment[] = [],
): Promise<void> {
    if (bigAttachments.length === 0) {
        // Signum: `SaveToSentItems = false` — the message is already stored as an EmailMessage row here.
        await MicrosoftGraph.send<void>(config, "POST", `users/${userId}/sendMail`,
            { message, saveToSentItems: false });
        return;
    }

    // Over the size limit an attachment cannot ride the request, so: create a DRAFT, upload each big
    // attachment in slices, then send the draft (Signum's `IsDraft = true` … `Drafts/…/Send` flow).
    const draft = await MicrosoftGraph.send<{ id?: string }>(config, "POST", `users/${userId}/messages`,
        { ...message, isDraft: true });

    if (draft?.id == undefined)
        throw new Error("Microsoft Graph did not return an id for the created draft message");

    for (const attachment of bigAttachments)
        await uploadBigAttachment(config, userId, draft.id, attachment);

    await MicrosoftGraph.send<void>(config, "POST", `users/${userId}/messages/${draft.id}/send`);
}

/** Signum's `LargeFileUploadTask<FileAttachment>(uploadSession, fileStream, maxSliceSize).UploadAsync()`. */
async function uploadBigAttachment(
    config: AzureADConfigurationEmbedded,
    userId: string,
    messageId: string,
    attachment: GraphFileAttachment,
): Promise<void> {
    const bytes = Buffer.from(attachment.contentBytes, "base64");

    const session = await MicrosoftGraph.send<{ uploadUrl?: string }>(config, "POST",
        `users/${userId}/messages/${messageId}/attachments/createUploadSession`,
        {
            AttachmentItem: {
                attachmentType: "file",
                isInline: attachment.isInline,
                name: attachment.name,
                size: bytes.length,
                contentType: attachment.contentType,
            },
        });

    if (session?.uploadUrl == undefined)
        throw new Error(`Microsoft Graph did not return an upload URL for attachment '${attachment.name}'`);

    // The upload URL is pre-authorized (it carries its own token), so these PUTs are plain requests — which
    // is also why they do not go through MicrosoftGraph.send.
    for (let offset = 0; offset < bytes.length; offset += uploadSliceSize) {
        const end = Math.min(offset + uploadSliceSize, bytes.length);
        const slice = bytes.subarray(offset, end);

        const response = await fetch(session.uploadUrl, {
            method: "PUT",
            headers: {
                "Content-Length": String(slice.length),
                "Content-Range": `bytes ${offset}-${end - 1}/${bytes.length}`,
            },
            body: new Uint8Array(slice),
        });

        if (!response.ok)
            throw new Error(`Uploading attachment '${attachment.name}' to Microsoft Graph failed with`
                + ` ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
}

// ---- The Graph shapes this module writes ----------------------------------------------------------------

export interface GraphRecipient {
    emailAddress: { address: string; name?: string | null };
}

export interface GraphMessage {
    subject: string;
    body: { content: string; contentType: "html" | "text" };
    from?: GraphRecipient;
    toRecipients: GraphRecipient[];
    ccRecipients: GraphRecipient[];
    bccRecipients: GraphRecipient[];
    attachments: GraphFileAttachment[];
}

export interface GraphFileAttachment {
    "@odata.type": "#microsoft.graph.fileAttachment";
    contentId: string | null;
    name: string;
    isInline: boolean;
    contentType: string;
    contentBytes: string;
    /** Not part of the Graph payload for the small case, but Graph accepts it and the upload session needs
     *  it — and it is what decides which bucket an attachment falls into. */
    size: number;
}

/** Signum's `ToRecipient(EmailAddressEmbedded)`. */
function recipientOf(address: EmailAddressEmbedded): GraphRecipient {
    return { emailAddress: { address: address.emailAddress, name: address.displayName } };
}

/** Signum's `ToRecipient(EmailRecipientEmbedded)` — honours OverrideEmailAddress (the test catch-all) and
 *  refuses to build an address at all when sending is off. */
function recipientOfRecipient(recipient: EmailRecipientBaseEntity): GraphRecipient {
    const config = EmailLogic.configuration();
    if (!config.sendEmails)
        throw new Error("EmailConfigurationEmbedded.sendEmails is set to false");

    return {
        emailAddress: {
            address: config.overrideEmailAddress || recipient.emailAddress,
            name: recipient.displayName,
        },
    };
}

function recipientsOfKind(email: EmailMessageEntity, kind: EmailRecipientKindEnum): GraphRecipient[] {
    return email.recipients.filter(r => r.kind === kind).map(recipientOfRecipient);
}
