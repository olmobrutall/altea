import { table } from "@altea/altea/server/table";
import { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import type { IQuery } from "@altea/altea/data/iquery";
import { withQuoted } from "@altea/altea/data/decorators";
import { Clock } from "@altea/altea/data/utils/clock";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { Graph } from "@altea/altea/server/graph";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { retrieveFromListOfLite } from "@altea/altea/server/Database";
import type { SchemaBuilder } from "@altea/altea/server/schema/schemaBuilder";
import { ProcessLogic } from "@altea/altea-processes/server/ProcessLogic";
import type { ExecutingProcess } from "@altea/altea-processes/server/ProcessRunner";
import {
    PackageEntity, PackageLineEntity, setOperationArgs, getOperationArgs, getLiteArg, tryGetArg,
} from "@altea/altea-processes/data/Package";
import type { ProcessEntity } from "@altea/altea-processes/data/Processes";
import { ModelConverterSymbol } from "@altea/altea-templating/data/Templating";
import { EmailMessageEntity, EmailMessageState, EmailMessageMessage } from "../data/EmailMessage";
import { EmailTemplateEntity } from "../data/EmailTemplate";
import {
    EmailPackageEntity, EmailMessagePackageMixin, EmailMessageProcess, EmailMessagePackageOperation,
} from "../data/EmailPackage";
import { EmailLogic } from "./EmailLogic";
import { EmailTemplateLogic } from "./EmailTemplateLogic";

// Port of Signum.Mailing/Package/EmailPackageLogic.cs — the batch half of the module.
//
// altea divergences:
//  - the three `[AutoExpressionField]` extension methods are `withQuoted` PROTOTYPE members assigned at the
//    bottom of this file, the idiom @altea/altea-printing's PrintPackageEntity.lines() uses: a registered
//    expression needs a quoted member to point at, and the member is server-only because its body is a query.
//  - `ExceptionLogic.DeleteLogs += ExceptionLogic_DeletePackages` has no counterpart: the log-retention
//    machinery IS ported (ExceptionLogic.registerDeleteLogs), but orphaned e-mail packages are not swept.
//  - `ProcessLogic.AssertStarted` / `Schema.Settings.AssertImplementedBy(ProcessEntity.Data)` have none
//    either: `ProcessEntity.data` is @implementedByAll here, so nothing has to be widened.
//  - `AuthLogic.Disable()` around the send loop → `ExecutionMode.global()`.
//  - Signum's `IProcessAlgorithm` classes → `ProcessLogic.registerAction` closures (the same call
//    @altea/altea-sms's two algorithms make), and `CancellationToken.ThrowIfCancellationRequested()` →
//    the AbortSignal `ep.signal`.

export namespace EmailPackageLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // The mixin must be DECLARED before the schema is built — the app does that beside its other entity
        // overrides (both tiers). Fail loudly rather than silently generating an email_message with no
        // package column, which would surface much later as a missing column.
        if (!MixinDeclarations.isDeclared(EmailMessageEntity, EmailMessagePackageMixin))
            throw new Error(
                "EmailMessagePackageMixin is not declared. Call MixinDeclarations.register(EmailMessageEntity, EmailMessagePackageMixin) from the "
                + "app's shared entity-overrides module (it must run on BOTH tiers, before the schema is built).");

        sb.include(EmailPackageEntity).withQuery();

        QueryLogic.expressions.register(EmailPackageEntity, e => e.emailMessages!(),
            { niceName: () => EmailMessageEntity.nicePluralName() });
        QueryLogic.expressions.register(EmailPackageEntity, e => e.remainingMessages!(),
            EmailMessageMessage.RemainingMessages);
        QueryLogic.expressions.register(EmailPackageEntity, e => e.exceptionMessages!(),
            EmailMessageMessage.ExceptionMessages);

        // Signum's CreateEmailsSendAsyncProcessAlgorithm: one PackageEntity whose LINES are the targets and
        // whose operation arguments carry the template (and optionally the model converter).
        ProcessLogic.registerAction(EmailMessageProcess.CreateEmailsSendAsync, async (ep: ExecutingProcess) => {
            const packLite = ep.data as Lite<PackageEntity> | null;
            if (packLite == null)
                throw new Error("The CreateEmailsSendAsync process has no PackageEntity");

            const pack = (await retrieveFromListOfLite([packLite]))[0];
            const template = getLiteArg(getOperationArgs(pack), EmailTemplateEntity);

            const lines = await table(PackageLineEntity)
                .filter(l => l.package.is(packLite) && l.finishTime == null)
                .toArray() as PackageLineEntity[];

            await ep.forEach(lines, l => l.target.toString(), async line => {
                const target = (await retrieveFromListOfLite([line.target]))[0];
                const emails = await EmailTemplateLogic.createEmailMessageFromLite(template, target);
                for (const email of emails)
                    await EmailLogic.sendMailAsync(email);

                line.result = emails.length === 1 ? emails[0].toLite() : null;
                line.finishTime = Clock.now;
                await line.save();
            }, l => l.toLite());
        });

        // Signum's SendEmailProcessAlgorithm: send every remaining message of the package, oldest first, in
        // chunks, retrying a failure up to maxEmailSendRetries.
        ProcessLogic.registerAction(EmailMessageProcess.SendEmails, async (ep: ExecutingProcess) => {
            const packLite = ep.data as Lite<EmailPackageEntity> | null;
            if (packLite == null)
                throw new Error("The SendEmails process has no EmailPackageEntity");

            const emails = await table(EmailMessageEntity)
                .filter(e => e.mixin(EmailMessagePackageMixin).package!.is(packLite)
                    && (e.state == EmailMessageState.RecruitedForSending
                        || e.state == EmailMessageState.Draft
                        || e.state == EmailMessageState.ReadyToSend))
                .orderBy(e => e.creationDate)
                .map(e => e.toLite())
                .toArray() as Lite<EmailMessageEntity>[];

            const config = await EmailLogic.configuration();
            const chunkSize = Number(config.chunkSizeSendingEmails);
            const maxRetries = Number(config.maxEmailSendRetries);

            let counter = 0;
            // Signum's `using (AuthLogic.Disable())` — a batch send must not depend on who queued it.
            await ExecutionMode.global(async () => {
                for (let i = 0; i < emails.length; i += chunkSize) {
                    const retrieved = await retrieveFromListOfLite(emails.slice(i, i + chunkSize));
                    for (const m of retrieved) {
                        if (ep.signal.aborted)
                            throw new Error("The process was cancelled");
                        counter++;
                        try {
                            // Its OWN transaction, so one failed send does not roll back the ones before it.
                            await Transaction.forceNew(() => EmailLogic.sendMail(m));
                            await ep.progressChanged(counter, emails.length);
                        } catch {
                            try {
                                if (Number(m.sendRetries) < maxRetries) {
                                    await Transaction.forceNew(async () => {
                                        const nm = (await retrieveFromListOfLite([m.toLite()]))[0];
                                        (nm as { sendRetries: unknown }).sendRetries = Number(nm.sendRetries) + 1;
                                        nm.state = EmailMessageState.ReadyToSend;
                                        await nm.save();
                                    });
                                }
                            } catch { /* the retry bookkeeping itself failed; nothing more for this one */ }
                        }
                    }
                }
            });
        });

        // Signum's `Graph<ProcessEntity>.ConstructFromMany<EmailMessageEntity>(ReSendEmails)`: copy each
        // selected message into a fresh one, put them all in a new package, and queue the send process.
        new Graph.ConstructFromMany(EmailMessageEntity, EmailMessagePackageOperation.ReSendEmails, {
            construct: async (lites: Lite<EmailMessageEntity>[], args: unknown[]) => {
                // ALTEA: Signum returns null when nothing was selected and the caller silently gets nothing;
                // altea's construct must return an entity, so the empty case says what happened.
                if (lites.length === 0)
                    throw new Error(EmailMessageMessage.NoSuitableRecipientsWereFound.niceToString());

                const pack = new EmailPackageEntity();
                pack.name = tryGetArg(args, String as never) as string ?? null;
                await pack.save();

                for (const m of await retrieveFromListOfLite(lites))
                    await copyIntoPackage(m, pack);

                return await ProcessLogic.create(EmailMessageProcess.SendEmails, pack.toLite());
            },
        }).register();
    }

    /**
     * Signum's `SendMultipleEmailsAsync(template, targets, converter)` — queue ONE process that renders the
     * template for every target. The template (and the converter, when given) ride in the package's
     * operation arguments, which is what CreateEmailsSendAsync reads back.
     */
    export async function sendMultipleEmailsAsync(
        template: Lite<EmailTemplateEntity>,
        targets: Lite<Entity>[],
        converter?: ModelConverterSymbol | null,
    ): Promise<ProcessEntity> {
        const pack = setOperationArgs(new PackageEntity(), converter == null ? [template] : [template, converter]);
        await pack.save();

        for (const t of targets) {
            const line = new PackageLineEntity();
            line.package = pack.toLite();
            line.target = t;
            await line.save();
        }

        return await ProcessLogic.create(EmailMessageProcess.CreateEmailsSendAsync, pack.toLite());
    }
}

/** Signum's ReSendEmails body: a fresh message carrying the same content, recruited for sending. */
async function copyIntoPackage(m: EmailMessageEntity, pack: EmailPackageEntity): Promise<void> {
    // `create` (not `new`), so the mixin's own field initializers run — a `new Owner()` leaves a
    // non-nullable mixin field undefined and the save fails far from here.
    const copy = EmailMessageEntity.create({
        from: m.from,
        recipients: m.recipients,
        target: m.target,
        isBodyHtml: m.isBodyHtml,
        subject: m.subject,
        template: m.template,
        editableMessage: m.editableMessage,
        state: EmailMessageState.RecruitedForSending,
        attachments: m.attachments,
    });
    copy.body.text = m.body.text;
    copy.mixin(EmailMessagePackageMixin).package = pack.toLite();
    await copy.save();
}

// The three `[AutoExpressionField]` extension methods — see the header. The state list is spelled out as
// Signum spells it (an OR of equalities), which is what the provider lowers; an array `.includes` is not.
EmailPackageEntity.prototype.emailMessages = withQuoted(function (this: EmailPackageEntity): IQuery<EmailMessageEntity> {
    return table(EmailMessageEntity).filter(e => e.mixin(EmailMessagePackageMixin).package!.is(this));
});

EmailPackageEntity.prototype.remainingMessages = withQuoted(function (this: EmailPackageEntity): IQuery<EmailMessageEntity> {
    return table(EmailMessageEntity).filter(e => e.mixin(EmailMessagePackageMixin).package!.is(this)
        && (e.state == EmailMessageState.RecruitedForSending
            || e.state == EmailMessageState.Draft
            || e.state == EmailMessageState.ReadyToSend));
});

EmailPackageEntity.prototype.exceptionMessages = withQuoted(function (this: EmailPackageEntity): IQuery<EmailMessageEntity> {
    return table(EmailMessageEntity).filter(e => e.mixin(EmailMessagePackageMixin).package!.is(this)
        && e.state == EmailMessageState.SentException);
});
