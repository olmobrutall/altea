import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/server/fluentOperations";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal } from "@altea/altea/data/basics";
import type { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { UserEntity } from "@altea/altea-auth/data/User";
import { EmailLogic } from "@altea/altea-email/server/EmailLogic";
import { EmailModel, EmailModelLogic } from "@altea/altea-email/server/EmailModelLogic";
import type { EmailOwnerRecipientData } from "@altea/altea-email/data/Email";
import {
    EmailTemplateEntity, EmailTemplateEntity_Message, EmailMessageFormat,
} from "@altea/altea-email/data/EmailTemplate";
import { EmailRecipientKind } from "@altea/altea-email/data/Email";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { CultureInfoLogic } from "@altea/altea/server/cultureInfoLogic";
import type { CultureInfoEntity } from "@altea/altea/data/cultureInfoEntity";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { SchedulerLogic } from "@altea/altea-scheduler/server/SchedulerLogic";
import { ScheduledTaskEntity } from "@altea/altea-scheduler/data/Scheduler";
import {
    AlertEntity, AlertState, AlertMessage, SendAlertTypeBehavior,
    SendNotificationEmailTaskEntity, SendNotificationEmailTaskOperation,
} from "../data/Alert";
import { AlertLogic } from "./AlertLogic";

/**
 * Signum's AlertNotificationMail — the unread alerts of ONE user, newest first. The template's query is about
 * the user (`@[Entity]`); the alert list is the model's own (`@foreach[m:alerts] as $a`).
 *
 * altea divergence: Signum's model also exposes a static `TextFormatted(TemplateParameters)` that expands an
 * alert's `[prop:text](url)` placeholders into anchors inside the MAIL. That expansion is not ported here —
 * it lives in the client's `AlertsClient.format`, which is what the dropdown and the alert view render with,
 * so a mail shows the alert text as written. (The mail is a notification; the link is the app.)
 */
export class AlertNotificationMail extends EmailModel<UserEntity> {
    constructor(user: UserEntity, readonly alerts: AlertEntity[]) {
        super(user);
    }

    override getRecipients(): EmailOwnerRecipientData[] {
        return [{ ownerData: EmailLogic.ownerDataOfEntity(this.entity), kind: EmailRecipientKind.To }];
    }
}

// Port of Signum.Alerts' `AlertLogic.RegisterAlertNotificationMail(sb)` — the OPT-IN half that mails a user
// the alerts they have not attended, driven by a ScheduledTask.
//
// It lives in its own file rather than inside AlertLogic (where Signum keeps it) for one reason: it is the
// only part of the module that depends on @altea/altea-email and @altea/altea-scheduler, and an app that
// wants alerts without either should not drag them in. `AlertLogic.start` works on its own.
//
// altea divergences:
//
//  - **no EmailPackage.** Signum groups the generated messages under an `EmailPackageEntity` (Signum.Mailing
//    .Package + `EmailMessagePackageMixin`), which altea-email does not port, and returns its lite as the
//    task's "product". Here the messages are simply queued and the task's product is null.
//  - **no `BulkInsertQueryIds` / `UnsafeUpdate`-from-query for the flag**: the messages are saved one by one
//    and `emailNotificationsSent` is set with a set-based `executeUpdate` over the same filter.
//  - the template body drops Signum's `@[m:TextFormatted]` — see AlertNotificationMail above.
export namespace AlertNotificationLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Signum's AssertImplementedBy: the app must have widened ScheduledTaskEntity.task to include this
        // task, or a scheduled entry could never point at it. Fail loudly at startup, not at first run.
        assertScheduledTaskImplementedBy();

        sb.include(SendNotificationEmailTaskEntity)
            .withSave(SendNotificationEmailTaskOperation.Save)
            .withQuery();

        EmailModelLogic.registerEmailModel({
            modelType: AlertNotificationMail,
            queryName: UserEntity,
            defaultTemplateConstructor: async () => EmailTemplateEntity.create({
                disableAuthorization: false,
                groupResults: false,
                messageFormat: EmailMessageFormat.HtmlComplex,
                messages: await forEachCulture(cultureInfo => EmailTemplateEntity_Message.create({
                    cultureInfo,
                    subject: AlertMessage.NewUnreadNotifications.niceToString(),
                    text: `<p>${AlertMessage.Hi0.niceToString("@[Entity]")}</p>\n`
                        + `<p>${AlertMessage.YouHaveSomePendingAlerts.niceToString()}</p>\n`
                        + `<ul>\n`
                        + `@foreach[m:alerts] as $a\n`
                        + `<li>\n`
                        + `    <strong>@[$a.titleField]:</strong><br/>\n`
                        + `    @[$a.textField]<br/>\n`
                        + `    <small>@[$a.alertDate] @[$a.createdBy]</small>\n`
                        + `</li>\n`
                        + `@endforeach\n`
                        + `</ul>\n`
                        + `<p>${AlertMessage.PleaseVisit0.niceToString(`<a href="@[g:UrlLeft]">@[g:UrlLeft]</a>`)}</p>`,
                })),
            }),
        });

        SchedulerLogic.registerExecuteTask(SendNotificationEmailTaskEntity, async task => {
            await sendNotificationEmails(task);
            return null; // Signum returns the EmailPackage lite — see the header.
        });
    }

    function assertScheduledTaskImplementedBy(): void {
        const impl = getTypeInfo(ScheduledTaskEntity)?.fields["task"]?.implementations;
        const types = impl?.kind === "implementedBy" ? impl.types() : [];

        if (!types.includes(SendNotificationEmailTaskEntity as never))
            throw new Error("SendNotificationEmailTaskEntity is not among the implementations of"
                + " ScheduledTaskEntity.task. Add it with `overrideImplementedBy(ScheduledTaskEntity,"
                + " \"task\", () => [SimpleTaskSymbol, …, SendNotificationEmailTaskEntity])` in the app's"
                + " shared entity-overrides module (it must run on BOTH tiers).");
    }

    /** Signum's `SchedulerLogic.ExecuteTask.Register((SendNotificationEmailTaskEntity task, ctx) => …)`. */
    export async function sendNotificationEmails(task: SendNotificationEmailTaskEntity): Promise<number> {
        const max = Clock.now.subtract({ minutes: Number(task.sendNotificationsOlderThan) });
        const min = task.ignoreNotificationsOlderThan == null
            ? null
            : Clock.now.subtract({ days: Number(task.ignoreNotificationsOlderThan) });

        // A task names DECLARED alert types, which always carry a key (a user-created one has only a
        // name, and there is nothing to match it by here).
        const alertTypeKeys = new Set(task.alertTypes.map(r => r.alertType.key!));

        return await ExecutionMode.global(async () => {
            const candidates = await table(AlertEntity)
                .filter(a => a.state == AlertState.Saved
                    && a.emailNotificationsSent == false
                    && a.avoidSendMail == false
                    && a.recipient != null
                    && Temporal.PlainDateTime.compare(a.alertDate!, max) < 0)
                .toArray() as AlertEntity[];

            // The two remaining predicates are IN MEMORY: `min` is optional (Signum writes `min == null ||
            // min < a.AlertDate`, a captured-null comparison altea's binder would have to special-case) and
            // the behaviour filter is a set membership over symbols. Both are cheap over one task's batch.
            const alerts = candidates.filter(a =>
                (min == null || Temporal.PlainDateTime.compare(min, a.alertDate!) < 0)
                && matchesBehavior(a, task.sendBehavior, alertTypeKeys));

            if (alerts.length === 0)
                return 0;

            // Signum: `alerts.GroupBy(a => a.Recipient)` → one mail per recipient.
            const byRecipient = new Map<string, { recipient: Lite<UserEntity>; alerts: AlertEntity[] }>();
            for (const a of alerts) {
                const key = a.recipient!.key();
                let group = byRecipient.get(key);
                if (group == null)
                    byRecipient.set(key, group = { recipient: a.recipient!, alerts: [] });
                group.alerts.push(a);
            }

            let sent = 0;
            for (const group of byRecipient.values()) {
                const recipient = await group.recipient.retrieve();
                const model = new AlertNotificationMail(recipient, group.alerts.sort((a, b) =>
                    Temporal.PlainDateTime.compare(b.alertDate!, a.alertDate!)));

                for (const message of await EmailLogic.createEmailMessagesFromModel(model)) {
                    await EmailLogic.sendMailAsync(message);
                    sent++;
                }
            }

            // Signum: `query.UnsafeUpdate().Set(a => a.EmailNotificationsSent, true)`.
            const ids = new Set(alerts.map(a => String(a.id)));
            await table(AlertEntity)
                .filter(a => a.state == AlertState.Saved && a.emailNotificationsSent == false)
                .toArray()
                .then(async rows => {
                    for (const row of rows as AlertEntity[])
                        if (ids.has(String(row.id))) {
                            row.emailNotificationsSent = true;
                            await row.save();
                        }
                });

            return sent;
        });
    }

    function matchesBehavior(alert: AlertEntity, behavior: SendAlertTypeBehavior, keys: Set<string>): boolean {
        switch (behavior) {
            case SendAlertTypeBehavior.All: return true;
            case SendAlertTypeBehavior.Include: return alert.alertType != null && keys.has(alert.alertType.key!);
            case SendAlertTypeBehavior.Exclude: return alert.alertType == null || !keys.has(alert.alertType.key!);
            default: return true;
        }
    }
}

/** One EmailTemplate message per application culture, each rendered in ITS culture. */
async function forEachCulture(build: (culture: Lite<CultureInfoEntity>) => EmailTemplateEntity_Message): Promise<EmailTemplateEntity_Message[]> {
    return (await CultureInfoLogic.lookup()).lites()
        .map(c => CultureInfo.withCultures(c.name, () => build(c.lite)));
}

export type { Entity, AlertLogic };
