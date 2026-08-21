import "@altea/altea/server"; // installs Entity.save()/delete()
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { retrieve } from "@altea/altea/server/Database";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal, toInt } from "@altea/altea/data/basics";
import { EmailRecipientKindEnum } from "@altea/altea-email/data/Email";
import {
    EmailMessageEntity, EmailMessageEntity_Recipient,
} from "@altea/altea-email/data/EmailMessage";
import {
    EmailReceptionConfigurationEntity, EmailReceptionEntity, EmailReceptionExceptionEntity,
    EmailReceptionMixin, CompareInboxEnum,
} from "@altea/altea-email/data/EmailReception";
import { EmailLogic } from "@altea/altea-email/server/EmailLogic.server";
import { EmailReceptionLogic } from "@altea/altea-email/server/EmailReceptionLogic.server";
import { EmailSenderConfigurationLogic } from "@altea/altea-email/server/EmailSenderConfigurationLogic.server";
import type { ScheduledTaskContext } from "@altea/altea-scheduler/server/ScheduleTaskRunner.server";
import { Pop3EmailReceptionServiceEntity } from "../data/MailingPop3";
import { Pop3Client, type IPop3Client, type MessageUid } from "./Pop3Client";
import { toEmailMessage } from "./MimeToEmailMessage";

// Port of Signum.Mailing.Pop3's Pop3ConfigurationLogic.cs — one poll of one mailbox: which messages are new,
// store each of them (de-duplicating against what is already there), and delete the SERVER copy once it is
// old enough.
//
// The transaction structure is the point of this file and is kept exactly: the reception ROW is written in its
// own transaction up front (so a crash mid-poll still leaves a record of the attempt), each message is stored
// in its own transaction (so one bad message becomes an EmailReceptionException instead of losing the batch),
// and the summary is written in a third. `Transaction.forceNew` everywhere, as Signum's `Transaction.ForceNew`.
//
// altea divergences, documented inline:
//  - `OperationLogic.AllowSave<EmailMessageEntity>()` has no counterpart (altea has no save GUARD an operation
//    must lift); a message is saved directly.
//  - Signum has TWO `SaveEmail` overloads, one of them dead code (nothing calls the 3-argument one). Only the
//    live one — the `ref bool anomalousReception` version — is ported.
//  - `client.GetMessage(...)` returned a parsed MimeMessage; here the client returns the RAW bytes and
//    MimeToEmailMessage parses them, so the protocol and the MIME mapping stay separable.
//  - `Pop3ConfigurationLogic.CancelationToken` (a module-level static) is dropped: the ScheduledTaskContext's
//    own signal is the cancellation, and it is already threaded through.
//  - `AreDuplicates` compares recipients by `GetHashCode()`; altea has no value hash on an entity, so it
//    compares the ADDRESS + KIND pairs, which is what that hash was over.
//  - The `rawContent` an exception carried in its `Data` bag has no counterpart (altea's ExceptionEntity has
//    no data bag); the raw MIME is on the reception info of every message that WAS stored, and a message that
//    failed to parse names its uid in the logged error instead.

export namespace Pop3ConfigurationLogic {

    /** Signum's `MaxReceptionPerTime` — how many messages one poll stores in LastNEmails mode. */
    export let maxReceptionPerTime = 15;

    /** Signum's `GetPop3Client` — replaceable, so a test can hand in a fake mailbox. */
    export let getPop3Client: (service: Pop3EmailReceptionServiceEntity) => Promise<IPop3Client> = service =>
        Pop3Client.connect({
            host: service.host,
            port: service.port as unknown as number,
            username: service.username ?? "",
            password: service.password == null ? "" : EmailSenderConfigurationLogic.decryptPassword(service.password),
            enableSSL: service.enableSSL,
            readTimeout: service.readTimeout as unknown as number,
            clientCertificationFiles: service.clientCertificationFiles.map(c => c.fullFilePath),
        });

    /** Signum's `SurroundReceiveEmail` — wrap a whole poll (a tenant scope, a lock, …). */
    export const surroundReceiveEmail: ((config: EmailReceptionConfigurationEntity) => () => void)[] = [];

    /** Signum's `AssociateNewEmail` / `AssociateDuplicateEmail` — the app's chance to link a received message
     *  to whatever it is about (an order, a ticket) before it is saved. */
    export const associateNewEmail: ((email: EmailMessageEntity) => void)[] = [];
    export const associateDuplicateEmail: ((email: EmailMessageEntity, duplicate: EmailMessageEntity) => void)[] = [];

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        assertImplementedBy();

        EmailReceptionLogic.registerEmailReceptionService(Pop3EmailReceptionServiceEntity, receiveEmails);

        // The typed-in password becomes the stored (encrypted) one when the configuration is saved.
        EmailReceptionLogic.registerEmailReceptionServiceSave(Pop3EmailReceptionServiceEntity, service => {
            if (service.newPassword != null) {
                service.password = EmailSenderConfigurationLogic.encryptPassword(service.newPassword);
                service.newPassword = null;
            }
        });
    }

    /** Signum's `sb.Settings.AssertImplementedBy(e => e.Service, typeof(Pop3EmailReceptionServiceEntity))`. */
    function assertImplementedBy(): void {
        const impl = getTypeInfo(EmailReceptionConfigurationEntity)?.fields["service"]?.implementations;
        const types = impl?.kind === "implementedBy" ? impl.types() : [];

        if (!types.includes(Pop3EmailReceptionServiceEntity as never))
            throw new Error("Pop3EmailReceptionServiceEntity is not among the implementations of"
                + " EmailReceptionConfigurationEntity.service. Add it with `overrideImplementedBy("
                + "EmailReceptionConfigurationEntity, \"service\", () => [Pop3EmailReceptionServiceEntity])`"
                + " in the app's shared entity-overrides module (it must run on BOTH tiers).");
    }

    /** Signum's `ReceiveEmails(service, config, ctx)` — one poll. */
    export async function receiveEmails(
        service: Pop3EmailReceptionServiceEntity,
        config: EmailReceptionConfigurationEntity,
        ctx: ScheduledTaskContext,
    ): Promise<EmailReceptionEntity> {

        if (!EmailLogic.configuration().reciveEmails)
            throw new Error("EmailLogic.configuration().reciveEmails is set to false");

        using _prof = HeavyProfiler.log("ReceiveEmails", () => config.emailAddress);

        const cleanups = surroundReceiveEmail.map(h => h(config));

        try {
            return await receiveEmailsCore(service, config, ctx);
        } finally {
            cleanups.reverse().forEach(c => c());
        }
    }

    async function receiveEmailsCore(
        service: Pop3EmailReceptionServiceEntity,
        config: EmailReceptionConfigurationEntity,
        ctx: ScheduledTaskContext,
    ): Promise<EmailReceptionEntity> {

        // The attempt is recorded BEFORE anything can fail, in its own transaction.
        const reception = await Transaction.forceNew(async () => {
            const row = EmailReceptionEntity.create({
                emailReceptionConfiguration: config.toLite(),
                startDate: Clock.now,
                newEmails: toInt(0),
                serverEmails: toInt(0),
                mailsFromDifferentAccounts: false,
            });
            await row.save();
            return row;
        });

        const now = Clock.now;

        try {
            const client = await getPop3Client(service);
            try {
                const { messagesToSave, serverEmails } = await getMessagesToSave(config, client);

                await Transaction.forceNew(async () => {
                    reception.serverEmails = toInt(serverEmails);
                    reception.newEmails = toInt(messagesToSave.length);
                    await reception.save();
                });

                let anomalousReception = false;
                let lastUid = "";

                for (const mi of messagesToSave) {
                    if (ctx.signal.aborted)
                        break;

                    const result = await saveEmail(config, reception, client, mi);
                    anomalousReception ||= result.anomalous;
                    lastUid = mi.uid;

                    await deleteServerMessageIfNecessary(config, now, client, mi, result.sent);
                }

                await Transaction.forceNew(async () => {
                    reception.endDate = Clock.now;
                    reception.lastServerMessageUID = lastUid;
                    reception.mailsFromDifferentAccounts = anomalousReception;
                    await reception.save();
                });

                // Signum's comment: "Delete messages now" — a POP3 server only applies the DELEs on QUIT.
                await client.disconnect();
            } finally {
                await client[Symbol.asyncDispose]();
            }
        } catch (error) {
            const exception = await Transaction.forceNew(() => ExceptionLogic.logException(error as Error));

            try {
                await Transaction.forceNew(async () => {
                    reception.endDate = Clock.now;
                    reception.exception = exception?.toLite() ?? null;
                    await reception.save();
                });
            } catch {
                // Recording the failure itself failed; the reception row simply stays open.
            }
        }

        EmailReceptionLogic.receptionCommunication.forEach(h => h(reception));

        return reception;
    }

    /**
     * Signum's `GetMessagesToSave` — which of the mailbox's messages this poll should store.
     *
     * `CompareInbox.Full` asks the database whether each server uid is already stored (chunked, because an
     * `IN (…)` over a whole mailbox is not a query anyone wants). `LastNEmails` instead finds the newest
     * already-received message that is STILL on the server and takes what came after it — cheap, and enough
     * for a mailbox that is polled regularly. The first ever poll takes only the last N.
     */
    async function getMessagesToSave(
        config: EmailReceptionConfigurationEntity,
        client: IPop3Client,
    ): Promise<{ messagesToSave: MessageUid[]; serverEmails: number }> {

        const messageInfos = (await client.getMessageInfos()).sort((a, b) => a.number - b.number);
        const serverEmails = messageInfos.length;

        if (config.compareInbox === CompareInboxEnum.Full) {
            const already = new Set<string>();

            for (let i = 0; i < messageInfos.length; i += 50) {
                const uids = messageInfos.slice(i, i + 50).map(m => m.uid);
                const found = await table(EmailMessageEntity)
                    .filter(m => uids.includes(m.mixin(EmailReceptionMixin).receptionInfo!.uniqueId))
                    .map(m => m.mixin(EmailReceptionMixin).receptionInfo!.uniqueId)
                    .toArray() as string[];

                found.forEach(uid => already.add(uid));
            }

            return { messagesToSave: messageInfos.filter(m => !already.has(m.uid)), serverEmails };
        }

        const configLite = config.toLite();
        const lastEmails = await table(EmailMessageEntity)
            .filter(m => m.mixin(EmailReceptionMixin).receptionInfo!.reception.entity.emailReceptionConfiguration.id == configLite.id)
            .orderByDescending(m => m.creationDate)
            .top(maxReceptionPerTime)
            .map((m: EmailMessageEntity) => m.mixin(EmailReceptionMixin).receptionInfo!.uniqueId)
            .toArray() as string[];

        if (lastEmails.length === 0)
            // The first poll: only the newest N, so a years-old mailbox does not arrive all at once.
            return {
                messagesToSave: [...messageInfos].sort((a, b) => b.number - a.number).slice(0, maxReceptionPerTime),
                serverEmails,
            };

        const knownUids = new Set(lastEmails);
        const matching = messageInfos.filter(m => knownUids.has(m.uid));

        // Nothing already-stored is still on the server: it was all deleted, so take everything there is.
        if (matching.length === 0)
            return { messagesToSave: messageInfos, serverEmails };

        const maxKnown = Math.max(...matching.map(m => m.number));

        return {
            messagesToSave: messageInfos.filter(m => m.number > maxKnown).slice(0, maxReceptionPerTime),
            serverEmails,
        };
    }

    /**
     * Signum's `SaveEmail(config, reception, client, mi, ref anomalousReception)` — store ONE message, in its
     * own transaction. Returns when it was sent (for the server-side delete rule) and whether it looked
     * anomalous (see EmailReceptionEntity.mailsFromDifferentAccounts).
     */
    async function saveEmail(
        config: EmailReceptionConfigurationEntity,
        reception: EmailReceptionEntity,
        client: IPop3Client,
        mi: MessageUid,
    ): Promise<{ sent: Temporal.PlainDateTime | null; anomalous: boolean }> {

        try {
            return await Transaction.forceNew(async () => {
                const source = await client.getMessageSource(mi);
                const email = await toEmailMessage(source, mi.uid, reception.toLite(), EmailLogic.attachmentFileType());

                // A message this account is not even a recipient of has to be addressed to SOMETHING.
                if (email.recipients.length === 0)
                    email.recipients.push(EmailMessageEntity_Recipient.create({
                        emailAddress: config.emailAddress ?? "",
                        kind: EmailRecipientKindEnum.To,
                    }));

                const bodyHash = email.bodyHash;
                const candidates = await table(EmailMessageEntity)
                    .filter(a => a.bodyHash == bodyHash)
                    .map(a => ({
                        lite: a.toLite(),
                        date: a.mixin(EmailReceptionMixin).receptionInfo!.receivedDate,
                        uid: a.mixin(EmailReceptionMixin).receptionInfo!.uniqueId,
                    }))
                    .toArray() as { lite: ReturnType<EmailMessageEntity["toLite"]>; date: Temporal.PlainDateTime | null; uid: string }[];

                // Already received, and this account is not a recipient: the mailbox is being fed from
                // somewhere unexpected (Signum's comment). Recorded, not stored again.
                if (candidates.some(c => c.uid === mi.uid))
                    return { sent: null, anomalous: true };

                const newest = candidates
                    .slice()
                    .sort((a, b) => compareDates(b.date, a.date))[0];

                const duplicate = newest == undefined ? null
                    : await retrieve(EmailMessageEntity, newest.lite.id) as EmailMessageEntity;

                if (duplicate != null && areDuplicates(email, duplicate)) {
                    assignEntities(email, duplicate);
                    associateDuplicateEmail.forEach(h => h(email, duplicate));
                } else {
                    associateNewEmail.forEach(h => h(email));
                }

                await email.save();

                return {
                    sent: email.mixin(EmailReceptionMixin).receptionInfo!.sentDate,
                    anomalous: false,
                };
            });
        } catch (error) {
            const exception = await Transaction.forceNew(() =>
                ExceptionLogic.logException(new Error(`Receiving message uid '${mi.uid}': `
                    + (error instanceof Error ? error.message : String(error)), { cause: error })));

            try {
                await Transaction.forceNew(async () => {
                    await EmailReceptionExceptionEntity.create({
                        exception: exception!.toLite(),
                        reception: reception.toLite(),
                    }).save();
                });
            } catch {
                // The failure could not be recorded either; the logged exception is what is left.
            }

            return { sent: null, anomalous: false };
        }
    }

    /**
     * Signum's `AssignEntities` — a re-received copy of a message already in the database reuses the ORIGINAL's
     * links: its target, its stored attachment FILES, and the email-owner each address resolved to. Without
     * this, a duplicate would re-upload every attachment and lose whatever the app had associated.
     */
    function assignEntities(email: EmailMessageEntity, duplicate: EmailMessageEntity): void {
        email.target = duplicate.target;

        for (const attachment of email.attachments) {
            const same = duplicate.attachments.find(a => a.similar(attachment));
            if (same != null)
                attachment.file = same.file;
        }

        email.from.emailOwner = duplicate.from.emailOwner;

        for (const recipient of email.recipients.filter(r => r.kind !== EmailRecipientKindEnum.Bcc)) {
            const same = duplicate.recipients.find(r =>
                r.emailAddress === recipient.emailAddress && r.kind === recipient.kind);
            if (same != null)
                recipient.emailOwner = same.emailOwner;
        }
    }

    /**
     * Signum's `AreDuplicates` — same From, same non-Bcc recipients, same attachments. (The BODY is already
     * known to match: this is only asked about a message with the same bodyHash.)
     */
    function areDuplicates(email: EmailMessageEntity, duplicate: EmailMessageEntity): boolean {
        const key = (r: EmailMessageEntity_Recipient): string => `${r.kind}|${r.emailAddress}`;

        const theirs = duplicate.recipients.filter(r => r.kind !== EmailRecipientKindEnum.Bcc).map(key).sort();
        const ours = email.recipients.filter(r => r.kind !== EmailRecipientKindEnum.Bcc).map(key).sort();

        if (theirs.length !== ours.length || theirs.some((t, i) => t !== ours[i]))
            return false;

        if (duplicate.from.emailAddress !== email.from.emailAddress)
            return false;

        if (duplicate.attachments.length !== email.attachments.length
            || !duplicate.attachments.every(a => email.attachments.some(a2 => a2.similar(a))))
            return false;

        return true;
    }

    /** Signum's `DeleteServerMessageIfNecessary` — drop the SERVER copy once it is old enough. */
    async function deleteServerMessageIfNecessary(
        config: EmailReceptionConfigurationEntity,
        now: Temporal.PlainDateTime,
        client: IPop3Client,
        mi: MessageUid,
        sent: Temporal.PlainDateTime | null,
    ): Promise<void> {
        if (config.deleteMessagesAfter == null || sent == null)
            return;

        const cutoff = sent.toPlainDate().add({ days: config.deleteMessagesAfter as unknown as number });
        if (Temporal.PlainDate.compare(cutoff, Clock.now.toPlainDate()) >= 0)
            return;

        await client.deleteMessage(mi);

        // The stored copy records WHEN the server copy went. Signum does this as a set-based UnsafeUpdate over
        // every message with this uid; `EmailReceptionInfoEmbedded.uniqueId` carries a UNIQUE INDEX, so there
        // is at most one — and a single retrieve + save says the same thing through the mixin accessor, which
        // a set-based setter object cannot reach (a mixin's fields are flattened onto the owner at runtime but
        // deliberately absent from its TYPE).
        const uid = mi.uid;
        const stored = await table(EmailMessageEntity)
            .filter(m => m.mixin(EmailReceptionMixin).receptionInfo!.uniqueId == uid)
            .singleOrNull() as EmailMessageEntity | null;

        if (stored != null)
            await Transaction.forceNew(async () => {
                stored.mixin(EmailReceptionMixin).receptionInfo!.deletionDate = now;
                await stored.save();
            });
    }

    function compareDates(a: Temporal.PlainDateTime | null, b: Temporal.PlainDateTime | null): number {
        if (a == null)
            return b == null ? 0 : -1;
        if (b == null)
            return 1;
        return Temporal.PlainDateTime.compare(a, b);
    }
}
