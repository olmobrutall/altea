import "@altea/altea/server"; // installs Entity.save()/delete()
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { Clock } from "@altea/altea/data/utils/clock";
import { EmailMessageEntity, EmailMessageStateEnum } from "../data/EmailMessage";
import type { EmailSenderConfigurationEntity } from "../data/EmailSenderConfiguration";
import { EmailLogic } from "./EmailLogic.server";

// Port of Signum.Mailing's EmailSenderBase.cs — the send wrapper every concrete sender shares: it records
// the outcome on the message, whatever happens.
//
// altea divergences, documented inline:
//  - `OperationLogic.AllowSave<EmailMessageEntity>()` has no altea counterpart (altea has no save GUARD that
//    an operation must lift): a message is saved directly.
//  - `Transaction.InTestTransaction` (rethrow instead of logging, so a test sees the real error) has no
//    counterpart; the exception is logged AND rethrown either way, which is what a caller needs.
//  - Signum's `ex.LogException()` is a write inside the failed transaction. altea's ExceptionLogic.logException
//    must run in its OWN transaction or it is rolled back with the failure (the gotcha the processes /
//    scheduler ports both hit) — hence the explicit `Transaction.forceNew`.

export abstract class EmailSenderBase {
    protected constructor(private readonly senderConfig: EmailSenderConfigurationEntity) { }

    /** Signum's Send — send, then stamp Sent / SentException on the message. */
    async send(email: EmailMessageEntity): Promise<void> {
        // The master switch: record the message as sent without touching the network (a dev / test database).
        if (!EmailLogic.configuration().sendEmails) {
            email.state = EmailMessageStateEnum.Sent;
            email.sent = Clock.now;
            await email.save();
            return;
        }

        try {
            await this.sendInternal(email);

            email.state = EmailMessageStateEnum.Sent;
            email.sent = Clock.now;
            email.sentBy = this.senderConfig.toLite();
            await email.save();
        } catch (e) {
            const exLog = await Transaction.forceNew(() => ExceptionLogic.logException(e as Error));

            try {
                await Transaction.forceNew(async () => {
                    email.exception = exLog?.toLite() ?? null;
                    email.state = EmailMessageStateEnum.SentException;
                    await email.save();
                });
            } catch {
                // Recording the failure itself failed — the original error is what matters, so rethrow that.
            }

            throw e;
        }
    }

    protected abstract sendInternal(email: EmailMessageEntity): Promise<void>;
}
