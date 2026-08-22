import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/server/operationFluentInclude";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal } from "@altea/altea/data/basics";
import type { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { UserEntity } from "@altea/altea-auth/data/User";
import { EmailLogic } from "@altea/altea-email/server/EmailLogic.server";
import { EmailModelLogic, emailModel } from "@altea/altea-email/server/EmailModelLogic.server";
import {
    EmailTemplateEntity, EmailTemplateEntity_Message, EmailMessageFormatEnum,
} from "@altea/altea-email/data/EmailTemplate";
import { EmailRecipientKindEnum } from "@altea/altea-email/data/Email";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { CultureInfoLogic } from "@altea/altea/server/cultureInfoLogic";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { SchedulerLogic } from "@altea/altea-scheduler/server/SchedulerLogic.server";
import { ScheduledTaskEntity } from "@altea/altea-scheduler/data/Scheduler";
import {
    AlertEntity, AlertState, AlertMessage, AlertNotificationMail, SendAlertTypeBehavior,
    SendNotificationEmailTaskEntity, SendNotificationEmailTaskOperation,
} from "../data/Alert";
import { AlertLogic } from "./AlertLogic.server";

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
//  - the template body drops Signum's `@[m:TextFormatted]` — see AlertNotificationMail in data/Alert.ts.
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
            defaultTemplateConstructor: () => EmailTemplateEntity.create({
                disableAuthorization: false,
                groupResults: false,
                messageFormat: EmailMessageFormatEnum.HtmlComplex,
                messages: forEachCulture(culture => EmailTemplateEntity_Message.create({
                    culture,
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

        const alertTypeKeys = new Set(task.alertTypes.map(r => r.alertType.key));

        return await ExecutionMode.global(async () => {
            const candidates = await table(AlertEntity)
                .filter(a => a.state == AlertState.Saved
                    && a.emailNotificationsSent == false
                    && a.avoidSendMail == false
                    && a.recipient != null
                    && Temporal.PlainDateTime.compare(a.alertDate, max) < 0)
                .toArray() as AlertEntity[];

            // The two remaining predicates are IN MEMORY: `min` is optional (Signum writes `min == null ||
            // min < a.AlertDate`, a captured-null comparison altea's binder would have to special-case) and
            // the behaviour filter is a set membership over symbols. Both are cheap over one task's batch.
            const alerts = candidates.filter(a =>
                (min == null || Temporal.PlainDateTime.compare(min, a.alertDate) < 0)
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
                const recipient = await group.recipient.retrieve() as UserEntity;
                const model = AlertNotificationMail.create({
                    alerts: group.alerts.sort((a, b) =>
                        Temporal.PlainDateTime.compare(b.alertDate, a.alertDate)),
                });

                const messages = await EmailLogic.createEmailMessagesFromModel(emailModel({
                    untypedEntity: recipient,
                    modelType: AlertNotificationMail,
                    getRecipients: () => [{
                        ownerData: EmailLogic.ownerDataOfEntity(recipient),
                        kind: EmailRecipientKindEnum.To,
                    }],
                    // The model IS the alert list; the template's query is only about the user.
                    getFilters: undefined,
                }) as never);

                for (const message of messages) {
                    await EmailLogic.sendMailAsync(message);
                    sent++;
                }

                // Carry the model through: `createEmailMessagesFromModel` renders `@[m:…]` off it.
                void model;
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
            case SendAlertTypeBehavior.Include: return alert.alertType != null && keys.has(alert.alertType.key);
            case SendAlertTypeBehavior.Exclude: return alert.alertType == null || !keys.has(alert.alertType.key);
            default: return true;
        }
    }
}

/** One EmailTemplate message per application culture, each rendered in ITS culture. */
function forEachCulture(build: (culture: ReturnType<typeof cultureLite>) => EmailTemplateEntity_Message): EmailTemplateEntity_Message[] {
    return CultureInfoLogic.applicationCultures()
        .map(name => CultureInfo.withCultures(name, () => build(cultureLite(name))));
}

function cultureLite(name: string) {
    return CultureInfoLogic.getCulture(name).toLite();
}

export type { Entity, AlertLogic };
