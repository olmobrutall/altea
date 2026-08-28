import { WebBuilder, CustomType, attachmentDisposition } from "@altea/altea/server/webApi";
import { table } from "@altea/altea/server/table";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { toLong } from "@altea/altea/data/basics";
import { UserEntity } from "@altea/altea-auth/data/User";
import { MicrosoftGraph } from "@altea/altea-auth-azuread/server/MicrosoftGraph";
import { mimeType } from "@altea/altea-files/server/FileTypeAlgorithm.server";
import {
    RemoteAttachmentEmbedded, RemoteEmailFolderModel, RemoteEmailMessageModel,
} from "../data/RemoteEmailMessage";
import { RemoteEmailsLogic, type GraphAttachment, type GraphMailMessage } from "./RemoteEmailsLogic";

// Port of Signum.Mailing.MicrosoftGraph/RemoteEmails' RemoteEmailController.cs — the six calls the remote
// mailbox UI makes: open one message, list folders, list categories, download an attachment, and the three
// bulk actions (delete / move / change categories).
//
// altea divergences, documented inline:
//  - The bulk actions keep Signum's NDJSON streaming (`Produces("application/x-ndjson")` +
//    `ForeachNDJson`): one JSON object per message, flushed as it completes, so the progress modal can count
//    them. Written out by hand here — altea's own operations layer has no server-side NDJSON helper yet, and
//    this is the whole of it (a header, a line per result, `end()`).
//  - The attachment download is AUTHENTICATED. Signum marks it `[SignumAllowAnonymous]`, which it has to,
//    because an inline image inside the message body is a plain `<img src>` and a cookie-less browser request
//    would be rejected — but altea authenticates with a Bearer token, so a bare `src=` would not carry
//    credentials ANYWAY. The client therefore fetches the bytes through the app's own ajax and rewrites the
//    `cid:` images to blob URLs (the shape altea-files' FileImage already uses), which lets this route stay
//    behind authentication instead of being reachable by anyone holding a message id.
//  - Every route is addressed by the USER's PRIMARY KEY, where Signum's takes the directory object id
//    (`{oid}`). Two reasons: altea has no lite MODEL, so the client never holds the oid to begin with; and
//    resolving it server-side means a caller cannot read an arbitrary mailbox by naming its oid — it has to
//    name a local user, whose row the ordinary type / row authorization already governs.
//  - `MimeMapping.GetFileStreamResult(..., forDownload: true)` becomes an explicit Content-Type +
//    Content-Disposition pair.
//  - The `singleValueExtendedProperties($filter=id eq '…')` expansion Signum hard-codes on the single-message
//    read comes from `RemoteEmailsLogic.converter.getExpansionPropertyId` instead, so an app that names its
//    own extended properties gets them here too (Signum's own hard-coded id was one deployment's).
//  - Signum's single-message read fills Extension0..3 by calling `GetExtension(message, 0)` four times — the
//    index is copy-pasted. Fixed here (0..3), because reading extension 0 into all four columns is plainly
//    not what was meant.

export namespace RemoteEmailsServer {
    let started = false;

    export function start(ws: WebBuilder): void {
        if (started)
            return;
        started = true;

        // ---- reads ---------------------------------------------------------------------------------------

        ws.get("/api/remoteEmail/:userId/message/:messageId",
            { params: CustomType<{ userId: string; messageId: string }>(), res: CustomType<RemoteEmailMessageModel>() },
            async (req, res) => {
                const messageId = req.params.messageId;
                const oid = await RemoteEmailsLogic.mailboxOfUserId(req.params.userId);
                const config = RemoteEmailsLogic.getGraphConfig(oid);

                const expand = ["attachments", ...expansionProperties()];

                const message = await MicrosoftGraph.get<GraphMailMessage>(
                    config, `users/${oid}/messages/${messageId}`, { expand },
                    { Prefer: "IdType='ImmutableId'" });

                const folders = await RemoteEmailsLogic.mailFolders(config, oid);

                res.jsonTyped(await toMessageModel(oid, message, folders));
            });

        ws.get("/api/remoteEmailFolders/:userId",
            { params: CustomType<{ userId: string }>(), res: CustomType<RemoteEmailFolderModel[]>() },
            async (req, res) => {
                const oid = await RemoteEmailsLogic.mailboxOfUserId(req.params.userId);
                const folders = await RemoteEmailsLogic.mailFolders(RemoteEmailsLogic.getGraphConfig(oid), oid);
                res.jsonTyped([...folders.values()]);
            });

        ws.get("/api/remoteEmailCategories/:userId",
            { params: CustomType<{ userId: string }>(), res: CustomType<string[]>() },
            async (req, res) => {
                if (RemoteEmailsLogic.hardCodedCategories != null) {
                    res.jsonTyped(RemoteEmailsLogic.hardCodedCategories());
                    return;
                }

                const oid = await RemoteEmailsLogic.mailboxOfUserId(req.params.userId);
                const categories = await MicrosoftGraph.get<{ value?: { displayName?: string }[] }>(
                    RemoteEmailsLogic.getGraphConfig(oid), `users/${oid}/outlook/masterCategories`);

                res.jsonTyped((categories.value ?? []).map(c => c.displayName ?? "").filter(n => n !== ""));
            });

        // The bytes of one attachment. See the header on why this is NOT anonymous.
        ws.get("/api/remoteEmail/:userId/message/:messageId/attachment/:attachmentId",
            { params: CustomType<{ userId: string; messageId: string; attachmentId: string }>(), res: CustomType<void>() },
            async (req, res) => {
                const { messageId, attachmentId } = req.params;
                const oid = await RemoteEmailsLogic.mailboxOfUserId(req.params.userId);
                const config = RemoteEmailsLogic.getGraphConfig(oid);

                const attachment = await MicrosoftGraph.get<GraphAttachment>(
                    config, `users/${oid}/messages/${messageId}/attachments/${attachmentId}`);

                if (attachment.contentBytes == undefined) {
                    res.status(404).end();
                    return;
                }

                const name = attachment.name ?? "attachment";
                res.setHeader("Content-Type", attachment.contentType ?? mimeType(name) ?? "application/octet-stream");
                res.setHeader("Content-Disposition", attachmentDisposition(name));
                res.end(Buffer.from(attachment.contentBytes, "base64"));
            });

        // ---- bulk actions (NDJSON, one line per message) -------------------------------------------------

        ws.post("/api/remoteEmail/:userId/delete",
            { params: CustomType<{ userId: string }>(), req: CustomType<string[]>(), res: CustomType<void>() },
            async (req, res) => {
                const oid = await RemoteEmailsLogic.mailboxOfUserId(req.params.userId);
                const config = RemoteEmailsLogic.getGraphConfig(oid);
                const messageIds = await req.jsonTyped();

                await forEachMessageNDJson(res, messageIds, "delete", async messageId => {
                    await MicrosoftGraph.send<void>(config, "DELETE", `users/${oid}/messages/${messageId}`);
                });
            });

        ws.post("/api/remoteEmail/:userId/moveTo/:folderId",
            { params: CustomType<{ userId: string; folderId: string }>(), req: CustomType<string[]>(), res: CustomType<void>() },
            async (req, res) => {
                const folderId = req.params.folderId;
                const oid = await RemoteEmailsLogic.mailboxOfUserId(req.params.userId);
                const config = RemoteEmailsLogic.getGraphConfig(oid);
                const messageIds = await req.jsonTyped();

                await forEachMessageNDJson(res, messageIds, "moveTo", async messageId => {
                    await MicrosoftGraph.send<void>(config, "POST", `users/${oid}/messages/${messageId}/move`,
                        { destinationId: folderId });
                });
            });

        ws.post("/api/remoteEmail/:userId/changeCategories",
            { params: CustomType<{ userId: string }>(), req: CustomType<ChangeCategoriesRequest>(), res: CustomType<void>() },
            async (req, res) => {
                const oid = await RemoteEmailsLogic.mailboxOfUserId(req.params.userId);
                const config = RemoteEmailsLogic.getGraphConfig(oid);
                const request = await req.jsonTyped();

                await forEachMessageNDJson(res, request.messageIds, "changeCategories", async messageId => {
                    // Read-modify-write, as Signum does: Graph replaces the whole list on a PATCH.
                    const message = await MicrosoftGraph.get<{ categories?: string[] }>(
                        config, `users/${oid}/messages/${messageId}`, { select: ["categories"] });

                    const categories = new Set(message.categories ?? []);
                    for (const c of request.categoriesToAdd)
                        categories.add(c);
                    for (const c of request.categoriesToRemove)
                        categories.delete(c);

                    await MicrosoftGraph.send<void>(config, "PATCH", `users/${oid}/messages/${messageId}`,
                        { categories: [...categories] });
                });
            });
    }

    /** Signum's RemoteEmailController.ChangeCategoriesRequest. */
    export interface ChangeCategoriesRequest {
        messageIds: string[];
        categoriesToAdd: string[];
        categoriesToRemove: string[];
    }

    /** Signum's `EmailResult` — one line of the NDJSON stream. */
    export interface EmailResult {
        id: string;
        error?: string;
    }

    /**
     * Signum's `ForeachMessageNDJson` — run `action` for each message and stream one result object per line,
     * so a failure is reported per message instead of aborting the batch. Each failure is also LOGGED (as
     * Signum does), in its own transaction: `logException` is a write, and inside the failed request's
     * transaction it would be rolled back with it (the gotcha the processes / scheduler ports both hit).
     */
    async function forEachMessageNDJson(
        res: { setHeader(name: string, value: string): void; write(chunk: string): unknown; end(): unknown },
        messageIds: string[],
        actionName: string,
        action: (messageId: string) => Promise<void>,
    ): Promise<void> {
        res.setHeader("Content-Type", "application/x-ndjson");

        for (const messageId of messageIds) {
            let result: EmailResult;
            try {
                await action(messageId);
                result = { id: messageId };
            } catch (error) {
                await Transaction.forceNew(() => ExceptionLogic.logException(error as Error, e => {
                    e.controllerName = "RemoteEmailController";
                    e.actionName = actionName;
                }));

                result = { id: messageId, error: error instanceof Error ? error.message : String(error) };
            }

            res.write(JSON.stringify(result) + "\n");
        }

        res.end();
    }

    /** The `$expand` entries for whichever Extension columns the app enabled (see the header). */
    function expansionProperties(): string[] {
        const expands: string[] = [];
        for (let index = 0; index < 4; index++) {
            const id = RemoteEmailsLogic.converter.getExpansionPropertyId(index);
            if (id != null)
                expands.push(`singleValueExtendedProperties($filter=id eq '${id}')`);
        }
        return [...new Set(expands)];
    }

    /** Signum's `new RemoteEmailMessageModel { … }` — the opened message. */
    async function toMessageModel(
        oid: string,
        message: GraphMailMessage,
        folders: Map<string, RemoteEmailFolderModel>,
    ): Promise<RemoteEmailMessageModel> {

        // The mailbox is addressed by the directory object id; the MODEL shows the local user, so it is
        // looked up by that id (Signum's `Database.Query<UserEntity>().Where(a => a.ExternalId == oidStr)`).
        const user = await table(UserEntity).filter(u => u.externalId == oid).singleOrNull() as UserEntity | null;
        if (user == null)
            throw new Error(`No user has externalId '${oid}'`);

        return RemoteEmailMessageModel.create({
            id: message.id ?? "",
            user: user.toLite(),
            subject: message.subject ?? "",
            body: message.body?.content ?? "",
            isBodyHtml: message.body?.contentType?.toLowerCase() === "html",
            isDraft: message.isDraft ?? false,
            isRead: message.isRead ?? false,
            hasAttachments: message.hasAttachments ?? false,
            from: RemoteEmailsLogic.toRecipientEmbedded(message.from),
            toRecipients: (message.toRecipients ?? []).map(r => RemoteEmailsLogic.toRecipientEmbedded(r)!),
            ccRecipients: (message.ccRecipients ?? []).map(r => RemoteEmailsLogic.toRecipientEmbedded(r)!),
            bccRecipients: (message.bccRecipients ?? []).map(r => RemoteEmailsLogic.toRecipientEmbedded(r)!),
            attachments: (message.attachments ?? []).map(a => RemoteAttachmentEmbedded.create({
                id: a.id ?? "",
                name: a.name ?? "",
                size: toLong(a.size ?? 0),
                lastModifiedDateTime: RemoteEmailsLogic.toPlainDateTime(a.lastModifiedDateTime)!,
                isInline: a.isInline ?? false,
                contentId: a.contentId ?? null,
            })),
            folder: RemoteEmailsLogic.folderOf(folders, message.parentFolderId),
            categories: message.categories ?? [],
            createdDateTime: RemoteEmailsLogic.toPlainDateTime(message.createdDateTime),
            lastModifiedDateTime: RemoteEmailsLogic.toPlainDateTime(message.lastModifiedDateTime),
            receivedDateTime: RemoteEmailsLogic.toPlainDateTime(message.receivedDateTime),
            sentDateTime: RemoteEmailsLogic.toPlainDateTime(message.sentDateTime),
            webLink: message.webLink ?? null,
            extension0: RemoteEmailsLogic.converter.getExtension(message, 0),
            extension1: RemoteEmailsLogic.converter.getExtension(message, 1),
            extension2: RemoteEmailsLogic.converter.getExtension(message, 2),
            extension3: RemoteEmailsLogic.converter.getExtension(message, 3),
        });
    }
}
