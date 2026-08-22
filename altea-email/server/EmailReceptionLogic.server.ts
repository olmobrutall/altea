import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery / withExpressionTo
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { graph } from "@altea/altea/server/graphBuilder";
import { table } from "@altea/altea/server/table";
import { Query } from "@altea/altea/server/query";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { withQuoted } from "@altea/altea/data/decorators";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { Clock } from "@altea/altea/data/utils/clock";
import { Entity, type Type } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { ExceptionEntity } from "@altea/altea/data/exception";
import { UserHolder } from "@altea/altea/server/userHolder";
import { ScheduledTaskLogEntity } from "@altea/altea-scheduler/data/Scheduler";
import { SchedulerLogic } from "@altea/altea-scheduler/server/SchedulerLogic.server";
import { SimpleTaskLogic } from "@altea/altea-scheduler/server/SimpleTaskLogic.server";
import { ScheduleTaskRunner, ScheduledTaskContext } from "@altea/altea-scheduler/server/ScheduleTaskRunner.server";
import { EmailMessageEntity } from "../data/EmailMessage";
import {
    EmailReceptionAction, EmailReceptionConfigurationEntity, EmailReceptionConfigurationOperation,
    EmailReceptionEntity, EmailReceptionExceptionEntity, EmailReceptionMixin, type EmailReceptionServiceEntity,
} from "../data/EmailReception";
import { EmailLogic } from "./EmailLogic.server";

// Port of Signum.Mailing/Reception's EmailReceptionLogic.cs — the reception tables, the navigations between
// them, the Save / ReceiveEmails operations, and the two ways a poll gets triggered: a ScheduledTask pointing
// straight at ONE configuration, or the SimpleTask that sweeps every ACTIVE one.
//
// The PROTOCOL is not here. `registerEmailReceptionService` is the seam a package like
// @altea/altea-mailing-pop3 plugs into, and `schemaCompleted` refuses to start if a service type is reachable
// from `EmailReceptionConfiguration.service` without one — the same guard Signum has, for the same reason: a
// configuration the user can create but nothing can poll is a silent dead end.
//
// altea divergences, documented inline:
//  - `Polymorphic<Func<EmailReceptionServiceEntity, …, EmailReceptionEntity>> EmailReceptionServices` becomes
//    the `receptionServices` registry below, keyed by constructor and walking the prototype chain (which is
//    what Polymorphic gives).
//  - Signum RE-DECLARES the EmailMessage query here to add a `SentDate` column off the mixin. altea resolves
//    query columns client-side and `sb.include(EmailMessageEntity)` already ran in EmailLogic.start, so the
//    reception column is a CLIENT concern — MailingReceptionClient adds it to the default columns.
//  - `QueryLogic.Expressions.Register` becomes `@quoted` navigation members registered through
//    `withExpressionTo` / `withExpressionFrom` (see the four below).
//  - Signum's `Duration` expression is NOT ported, for the reason altea-scheduler's ScheduledTaskLogEntity
//    documents: the quote-transformer emits a runtime type reference for a quoted member's return type, and a
//    TimeSpan-shaped result has none to reference. `endDate - startDate` is a client-side subtraction instead.
//  - Signum hides the service's stored password and encrypts the typed-in one through a JSON property
//    converter (Pop3ConfigurationLogic's `CustomReadJsonProperty`). altea does it the way its own SMTP side
//    already does — in the SAVE operation — through `registerEmailReceptionServiceSave`, so the protocol
//    package supplies the one line that knows which field holds the password.
//  - `EmailReceptionLogic.IsStarted` becomes `isStarted()`.

export namespace EmailReceptionLogic {

    /** Signum's `ReceptionComunication` — an app hook fired after every poll, whatever the outcome. */
    export const receptionCommunication: ((reception: EmailReceptionEntity) => void)[] = [];

    // Signum's `EmailReceptionServices` Polymorphic, keyed by the service entity's constructor.
    type ReceiveHandler = (
        service: EmailReceptionServiceEntity,
        config: EmailReceptionConfigurationEntity,
        ctx: ScheduledTaskContext,
    ) => Promise<EmailReceptionEntity>;
    const receptionServices = new Map<Function, ReceiveHandler>();

    // altea-only (see the header): the protocol package's chance to fold a typed-in password into the
    // stored one when a configuration is saved.
    const receptionServiceSaves = new Map<Function, (service: EmailReceptionServiceEntity) => void>();

    let started = false;

    export function isStarted(): boolean {
        return started;
    }

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        if (!EmailReceptionMixin.isDeclared())
            throw new Error("EmailReceptionMixin is not declared on EmailMessageEntity. Call"
                + " EmailReceptionMixin.declare() from the app's shared entity-overrides module (it must run on"
                + " BOTH tiers, before anything is (de)serialized or the schema is built).");

        // The SERVICE (a polymorphic @implementedBy target) is reached from this entity's field, so the
        // SchemaBuilder includes it — and its own @part rows — itself.
        sb.include(EmailReceptionConfigurationEntity)
            .withExpressionTo(c => c.receptions())
            .withQuery();

        sb.include(EmailReceptionEntity)
            .withExpressionTo(r => r.emailMessages())
            .withExpressionTo(r => r.exceptions())
            .withExpressionFrom(ExceptionEntity, (e: ExceptionEntity) => e.pop3Reception())
            .withQuery();

        sb.include(EmailReceptionExceptionEntity).withQuery();

        registerGraph();

        // A ScheduledTask may point straight at ONE configuration (Signum's
        // `SchedulerLogic.ExecuteTask.Register((EmailReceptionConfigurationEntity conf, ctx) => …)`), which is
        // why the entity is an ITaskEntity. The app still has to widen `ScheduledTaskEntity.task` to include
        // it — see EmailReceptionConfigurationEntity's header note on `service` for the same pattern.
        SchedulerLogic.registerExecuteTask(EmailReceptionConfigurationEntity, async (config, ctx) => {
            const reception = await receiveEmails(config, ctx);
            return reception.toLite() as Lite<Entity>;
        });

        // …or the sweep task polls every ACTIVE configuration in turn.
        SimpleTaskLogic.register(EmailReceptionAction.ReceiveAllActiveEmailConfigurations, async ctx => {
            if (!EmailLogic.configuration().reciveEmails)
                throw new Error("EmailLogic.configuration().reciveEmails is set to false");

            const active = await table(EmailReceptionConfigurationEntity).filter(c => c.active).toArray();
            for (const config of active as EmailReceptionConfigurationEntity[]) {
                ctx.signal.throwIfAborted();
                await receiveEmails(config, ctx);
            }

            return null;
        });

        // Signum's SchemaCompleted guard: every implementation of `service` must have a reception handler,
        // else the app offers a configuration nothing can poll.
        sb.schema.schemaCompleted.push(() => {
            const notRegistered = serviceImplementations().filter(t => !receptionServices.has(t));

            if (notRegistered.length > 0)
                throw new Error(`EmailReceptionConfigurationEntity.service is implemented by`
                    + ` ${notRegistered.map(t => t.name).join(", ")} but no reception service is registered for`
                    + ` it. Did you forget a Logic.start(sb) — e.g. Pop3ConfigurationLogic.start(sb)?`);
        });

        started = true;
    }

    /** Signum's `EmailReceptionServices.Register(...)` — bind the "poll a mailbox" function for one service
     *  type. Call it from the protocol package's own `start`, BEFORE the schema is completed. */
    export function registerEmailReceptionService<T extends EmailReceptionServiceEntity>(
        serviceType: Type<T>,
        receive: (service: T, config: EmailReceptionConfigurationEntity, ctx: ScheduledTaskContext) => Promise<EmailReceptionEntity>,
    ): void {
        receptionServices.set(serviceType as unknown as Function, receive as unknown as ReceiveHandler);
    }

    /** altea-only (see the header): what the Save operation should do to this service type before it is
     *  written — in practice, encrypt the typed-in password into the stored field. */
    export function registerEmailReceptionServiceSave<T extends EmailReceptionServiceEntity>(
        serviceType: Type<T>,
        prepareForSave: (service: T) => void,
    ): void {
        receptionServiceSaves.set(serviceType as unknown as Function,
            prepareForSave as unknown as (service: EmailReceptionServiceEntity) => void);
    }

    /** Run the registered pre-save step for this service instance's type, or for a base of it — the same
     *  seam (and the same public shape) EmailSenderConfigurationLogic exposes on the sending side. */
    export function prepareServiceForSave(service: EmailReceptionServiceEntity): void {
        lookup(receptionServiceSaves, service)?.(service);
    }

    /** Signum's private `ReceiveEmails(e, ctx)` — dispatch to the configured protocol. */
    export async function receiveEmails(
        config: EmailReceptionConfigurationEntity,
        ctx: ScheduledTaskContext,
    ): Promise<EmailReceptionEntity> {
        const handler = lookup(receptionServices, config.service);
        if (handler == null)
            throw new Error(`No email reception service is registered for '${config.service.constructor.name}'`
                + " — call EmailReceptionLogic.registerEmailReceptionService(TheService, …).");

        return await handler(config.service, config, ctx);
    }

    function registerGraph(): void {
        graph(EmailReceptionConfigurationEntity, g => {
        g.Execute(EmailReceptionConfigurationOperation.Save, {
            canBeNew: true,
            canBeModified: true,
            execute: (config: EmailReceptionConfigurationEntity) => {
                // See the header: the protocol package owns the "which field is the password" knowledge.
                prepareServiceForSave(config.service);
            },
        });

        g.ConstructFrom(EmailReceptionConfigurationEntity, EmailReceptionConfigurationOperation.ReceiveEmails, {
            construct: async (config: EmailReceptionConfigurationEntity) => {
                // Signum runs this inside `Transaction.None()`: a poll writes its own reception row (and every
                // stored message) in transactions of its OWN, so it must not be nested inside — and must not
                // be rolled back by — the operation's transaction.
                return await Transaction.none(async () => {
                    const user = UserHolder.currentUserLite();
                    if (user == null)
                        throw new Error("EmailReceptionConfigurationOperation.ReceiveEmails: there is no current user");

                    // An UNSAVED log, exactly as Signum builds it: the poll wants a ScheduledTaskContext (for
                    // cancellation + progress lines), not a scheduler run.
                    const log = ScheduledTaskLogEntity.create({
                        task: EmailReceptionAction.ReceiveAllActiveEmailConfigurations,
                        startTime: Clock.now,
                        machineName: ScheduleTaskRunner.machineName(),
                        applicationName: ScheduleTaskRunner.applicationName(),
                        user,
                    });

                    return await receiveEmails(config, new ScheduledTaskContext(log));
                });
            },
        });
        }).register();
    }

    /** The concrete types `EmailReceptionConfiguration.service` may hold (Signum's
     *  `sb.Schema.FindImplementations(PropertyRoute.Construct(s => s.Service))`). Read off the FieldInfo, so
     *  an app's `overrideImplementedBy` is what this sees. */
    function serviceImplementations(): Function[] {
        const impl = getTypeInfo(EmailReceptionConfigurationEntity)?.fields["service"]?.implementations;
        return impl?.kind === "implementedBy" ? impl.types() : [];
    }

    /** Signum's Polymorphic lookup: the handler registered for this instance's type, or for a base of it. */
    function lookup<H>(registry: Map<Function, H>, service: EmailReceptionServiceEntity): H | undefined {
        for (let ctor: Function | null = service.constructor; ctor != null; ctor = Object.getPrototypeOf(ctor) as Function | null) {
            const handler = registry.get(ctor);
            if (handler != null)
                return handler;
        }
        return undefined;
    }
}

// ---- Query navigations (Signum's QueryLogic.Expressions.Register) ---------------------------------------
// Declared as interface members on the entities and implemented here, where `table(T)` lives — altea's
// pattern for a cross-entity expression (see eastwind's ProductEntity.lines()).

declare module "../data/EmailReception" {
    interface EmailReceptionConfigurationEntity {
        /** Every poll of this mailbox. */
        receptions(): Query<EmailReceptionEntity>;
    }
    interface EmailReceptionEntity {
        /** The messages this poll stored. */
        emailMessages(): Query<EmailMessageEntity>;
        /** The messages this poll could NOT store. */
        exceptions(): Query<ExceptionEntity>;
    }
}

declare module "@altea/altea/data/exception" {
    interface ExceptionEntity {
        /** The poll this exception came out of. Signum's name is `Pop3Reception`, kept as-is even though the
         *  reception module is protocol-agnostic — it is the token name a stored filter would carry.
         *  Returns a Promise, since altea's `singleOrNull` is async; the registered EXPRESSION still sees the
         *  ELEMENT type, because `singleOrNull` is `@resultType`-decorated with it. */
        pop3Reception(): Promise<EmailReceptionEntity | null>;
    }
}

EmailReceptionConfigurationEntity.prototype.receptions = withQuoted(function (this: EmailReceptionConfigurationEntity): Query<EmailReceptionEntity> {
    return table(EmailReceptionEntity).filter(r => r.emailReceptionConfiguration.id == this.id);
});

EmailReceptionEntity.prototype.emailMessages = withQuoted(function (this: EmailReceptionEntity): Query<EmailMessageEntity> {
    return table(EmailMessageEntity)
        .filter(m => m.mixin(EmailReceptionMixin).receptionInfo!.reception.id == this.id);
});

EmailReceptionEntity.prototype.exceptions = withQuoted(function (this: EmailReceptionEntity): Query<ExceptionEntity> {
    return table(EmailReceptionExceptionEntity)
        .filter(a => a.reception.id == this.id)
        .map(a => a.exception.entity);
});

ExceptionEntity.prototype.pop3Reception = withQuoted(function (this: ExceptionEntity): Promise<EmailReceptionEntity | null> {
    return table(EmailReceptionExceptionEntity)
        .filter(re => re.exception.id == this.id)
        .map(re => re.reception.entity)
        .singleOrNull();
});
