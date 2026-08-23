import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import { createHash, randomUUID } from "node:crypto";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { graph } from "@altea/altea/server/graphBuilder";
import { table } from "@altea/altea/server/table";
import { retrieve } from "@altea/altea/server/Database";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { UserHolder } from "@altea/altea/server/userHolder";
import { Entity, type Type } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Clock } from "@altea/altea/data/utils/clock";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { type uuid } from "@altea/altea/data/basics";
import { FileTypeLogic } from "@altea/altea-files/server/FileTypeLogic.server";
import { UserEntity } from "@altea/altea-auth/data/User";
import { FilePathEmbeddedLogic } from "@altea/altea-files/server/FilePathEmbeddedLogic.server";
import type { IFileTypeAlgorithm } from "@altea/altea-files/server/FileTypeAlgorithm.server";
import { FileTypeSymbol } from "@altea/altea-files/data/Files";
import {
    AsyncEmailSenderPermission, EmailConfigurationEmbedded, EmailFileType, EmailMessageMessage,
    type EmailOwnerData, type IEmailOwnerEntity,
} from "../data/Email";
import {
    EmailMessageEntity, EmailMessageEntity_Attachment, EmailMessageEntity_Recipient, EmailMessageOperation,
    EmailMessageStateEnum,
} from "../data/EmailMessage";
import { EmailTemplateEntity, EmailMasterTemplateEntity, EmailTemplateVisibleOn } from "../data/EmailTemplate";
import { EmailSenderConfigurationEntity, SmtpEmailServiceEntity, type EmailServiceEntity } from "../data/EmailSenderConfiguration";
import { EmailSenderBase } from "./EmailSenderBase.server";
import { SmtpSender } from "./SmtpSender.server";
import { EmailSenderConfigurationLogic } from "./EmailSenderConfigurationLogic.server";
import { EmailTemplateLogic } from "./EmailTemplateLogic.server";
import { EmailModelLogic, type IEmailModel } from "./EmailModelLogic.server";
import { AttachmentLogic } from "./AttachmentLogic.server";
import { AsyncEmailSender } from "./AsyncEmailSender.server";
import { MailingServer } from "./MailingServer.server";

// Port of Signum.Mailing's EmailLogic.cs — the module's `start(sb)` and its public "send this" surface.
//
// altea divergences, documented inline:
//  - `Polymorphic<Func<EmailServiceEntity, …, EmailSenderBase>> EmailSenders` → the `emailSenders` registry
//    below, keyed by constructor and walking the prototype chain (Polymorphic's behaviour).
//  - `CacheLogic.ServerBroadcast` (the cross-host "a message is ready" push) is NOT ported: the async sender's
//    periodic timer is what notices work queued by another host, exactly as in a Signum deployment without
//    SqlDependency.
//  - `ExceptionLogic.DeleteLogs` (the log-cleanup hook) and `PreDeleteSqlSync` on FileTypeSymbol have no
//    altea counterpart.
//  - `OperationLogic.AllowSave<T>()` has no counterpart (altea has no save guard for an operation to lift).
//  - `GetAllTypes` reads the `target` implementations: altea's `target` is `@implementedByAll`, so the DISTINCT
//    target types actually stored are queried, which is Signum's own "hacky" byAll branch.
//  - `SendMailAsync` keeps Signum's `Transaction.PostRealCommit` wake-up through `Transaction.onPostRealCommit`.
//  - EmailOwnerData: a From / Recipient token yields a Lite (or an email string), and `registerEmailOwner`
//    says how to read an owner type's address (see data/Email.ts's header for why).

export namespace EmailLogic {

    let getConfiguration: (() => EmailConfigurationEmbedded) | undefined;
    let attachmentFileTypeSymbol: FileTypeSymbol = EmailFileType.Attachment;

    /** Signum's `EmailLogic.Configuration`. */
    export function configuration(): EmailConfigurationEmbedded {
        if (getConfiguration == undefined)
            throw new Error("EmailLogic.start has not been called (no email configuration)");
        return getConfiguration();
    }

    /** The FileTypeSymbol attachments are written to. */
    export function attachmentFileType(): FileTypeSymbol {
        return attachmentFileTypeSymbol;
    }

    // Signum's `EmailSenders` Polymorphic, keyed by the service entity's constructor.
    type SenderFactory = (service: EmailServiceEntity, config: EmailSenderConfigurationEntity) => EmailSenderBase;
    const emailSenders = new Map<Function, SenderFactory>();

    // altea-only (see the header): how to read an EmailOwnerData off an owner entity.
    const emailOwners = new Map<Function, (entity: Entity) => EmailOwnerData>();

    export function start(sb: SchemaBuilder, options: {
        /** Signum's `getConfiguration` — the app's mail settings. */
        getConfiguration: () => EmailConfigurationEmbedded;
        /** Signum's `getEmailSenderConfiguration` — which sender configuration a template / target uses. */
        getSenderConfiguration: (
            template: EmailTemplateEntity | null,
            target: Lite<Entity> | null,
            message: EmailMessageEntity | null,
        ) => Promise<EmailSenderConfigurationEntity | null>;
        /** The store attachments are written to (Signum's `attachment` IFileTypeAlgorithm). */
        attachment?: IFileTypeAlgorithm;
        encryptPassword?: (s: string) => string;
        decryptPassword?: (s: string) => string;
    }): void {
        if (sb.alreadyDefined(start))
            return;

        getConfiguration = options.getConfiguration;

        FilePathEmbeddedLogic.start(sb);
        FileTypeLogic.start(sb);
        if (options.attachment != undefined)
            FileTypeLogic.register(attachmentFileTypeSymbol, options.attachment);

        EmailTemplateLogic.getSenderConfiguration = options.getSenderConfiguration;
        EmailTemplateLogic.start(sb);
        AttachmentLogic.start(sb);
        EmailSenderConfigurationLogic.start(sb, {
            encryptPassword: options.encryptPassword,
            decryptPassword: options.decryptPassword,
        });

        // Its recipient / attachment @part rows are included automatically (see EmailTemplateLogic).
        sb.include(EmailMessageEntity).withQuery();

        // altea has no PermissionLogic registry: a PermissionSymbol declared with init() is seeded into the
        // symbol table by PermissionAuthLogic — the symbol just has to be REACHED.
        void AsyncEmailSenderPermission.ViewAsyncEmailSenderPanel;

        // The USER is an email owner out of the box. Signum gets this for free: `UserEntity.EmailOwnerData`
        // is an [AutoExpressionField] declared in Signum.Authorization, so any app can address a user in a
        // template. altea resolves owners through a registry instead (see the header), so the equivalent is
        // registering it HERE — this module already depends on altea-auth — rather than making every app
        // repeat it. An app with its OWN owner types adds them with `registerEmailOwner`.
        registerEmailOwner(UserEntity, u => ({
            owner: u.toLite(),
            email: u.email,
            displayName: u.userName,
            culture: null, // altea has no CultureInfoEntity on the user (see altea-auth's User.ts)
            externalId: u.externalId,
        }));

        registerEmailSender(SmtpEmailServiceEntity, (service, config) => new SmtpSender(config, service as SmtpEmailServiceEntity));

        // Signum's PreSaving + SetCalculateHash: the de-duplication hash is derived, so fill it on save.
        sb.schema.entityEvents(EmailMessageEntity).preSaving.push(email => {
            email.bodyHash = calculateBodyHash(email);
            email.uniqueIdentifier ??= randomUUID() as uuid;
        });

        EmailMessageGraph.register();

        if (sb.webBuilder)
            MailingServer.start(sb.webBuilder);
    }

    /**
     * Signum's `SetCalculateHash` — the de-duplication hash over subject + body. Exported because the
     * RECEPTION side needs it BEFORE the save (it looks for an already-stored message with the same hash, so
     * it must compute what the save hook is about to write). One formula, one caller each side.
     */
    export function calculateBodyHash(email: EmailMessageEntity): string {
        return createHash("sha1").update(email.hashSource(), "utf8").digest("base64");
    }

    /** Signum's `EmailSenders.Register(...)`. */
    export function registerEmailSender(serviceType: Function, factory: SenderFactory): void {
        emailSenders.set(serviceType, factory);
    }

    /** altea-only: how to read an EmailOwnerData off one owner ENTITY type (see the header). Register the
     *  types a From / Recipient token can yield — e.g. `registerEmailOwner(CustomerEntity, c => ({ … }))`. */
    export function registerEmailOwner<T extends Entity>(ownerType: Type<T>, read: (entity: T) => EmailOwnerData): void {
        emailOwners.set(ownerType as unknown as Function, read as unknown as (entity: Entity) => EmailOwnerData);
    }

    /** Turn whatever a From / Recipient token yielded into an EmailOwnerData: a Lite / Entity of a registered
     *  owner type, or a plain email STRING. */
    export async function ownerDataOf(value: unknown): Promise<EmailOwnerData> {
        if (typeof value === "string")
            return { owner: null, email: value, displayName: null, culture: null, externalId: null };

        const entity = value instanceof Lite
            ? await retrieve(value.entityType as Type<Entity>, value.id)
            : value as Entity;

        return ownerDataOfEntity(entity);
    }

    /** The SYNCHRONOUS half of `ownerDataOf`: read an already-LOADED owner entity through its registered
     *  reader. Split out because an IEmailModel's `getRecipients()` is synchronous (Signum's is an
     *  in-memory expression over an entity already in hand — `SendTo(Entity.User.EmailOwnerData)`). */
    export function ownerDataOfEntity(entity: Entity): EmailOwnerData {
        for (let ctor: Function | null = entity.constructor; ctor != null; ctor = Object.getPrototypeOf(ctor) as Function | null) {
            const read = emailOwners.get(ctor);
            if (read != null)
                return read(entity);
        }

        throw new Error(`No email owner is registered for '${entity.constructor.name}'`
            + " — call EmailLogic.registerEmailOwner(TheEntity, e => ({ email, displayName, … })).");
    }

    /** The current user as an EmailOwnerData (an `EmailAddressSource.CurrentUser` From / Recipient). */
    export async function currentUserOwnerData(): Promise<EmailOwnerData> {
        const lite = UserHolder.currentUserLite();
        if (lite == null)
            throw new Error("EmailAddressSource.CurrentUser: there is no current user");

        return await ownerDataOf(lite);
    }

    /** Signum's `GetEmailSender(email)` — the sender the configuration behind this message names. */
    export async function getEmailSender(email: EmailMessageEntity): Promise<EmailSenderBase> {
        const template = email.template == null ? null : await EmailTemplateLogic.getEmailTemplate(email.template);
        const config = await EmailTemplateLogic.getSenderConfiguration?.(template, email.target, email);
        if (config == null)
            throw new Error(EmailMessageMessage.DefaultFromNotFound.niceToString());

        for (let ctor: Function | null = config.service.constructor; ctor != null; ctor = Object.getPrototypeOf(ctor) as Function | null) {
            const factory = emailSenders.get(ctor);
            if (factory != null)
                return factory(config.service, config);
        }

        throw new Error(`No email sender is registered for '${config.service.constructor.name}'`
            + " — call EmailLogic.registerEmailSender(TheService, (service, config) => new YourSender(config, service)).");
    }

    // ---- sending ---------------------------------------------------------------------------------------

    /** Signum's `email.SendMail()` — send NOW, in the caller's transaction. */
    export async function sendMail(email: EmailMessageEntity): Promise<void> {
        await (await getEmailSender(email)).send(email);
    }

    /** Signum's `template.SendMail(entity)`. */
    export async function sendMailFromTemplate(template: Lite<EmailTemplateEntity>, entity: Entity): Promise<void> {
        for (const email of await EmailTemplateLogic.createEmailMessageFromLite(template, entity))
            await sendMail(email);
    }

    /** Signum's `model.SendMail()`. */
    export async function sendMailFromModel(model: IEmailModel, culture?: string): Promise<void> {
        for (const email of await createEmailMessagesFromModel(model, culture))
            await sendMail(email);
    }

    /** Signum's `email.SendMailAsync()` — save as ReadyToSend and let the async sender pick it up. */
    export async function sendMailAsync(email: EmailMessageEntity): Promise<void> {
        email.state = EmailMessageStateEnum.ReadyToSend;
        await email.save();
        wakeUpAfterCommit();
    }

    /** Signum's `SendAllAsync(list)`. */
    export async function sendAllAsync(emails: EmailMessageEntity[]): Promise<void> {
        for (const email of emails) {
            email.state = EmailMessageStateEnum.ReadyToSend;
            await email.save();
        }
        wakeUpAfterCommit();
    }

    /** Signum's `model.CreateEmailMessage()` — render the model's current template. */
    export async function createEmailMessagesFromModel(model: IEmailModel, culture?: string): Promise<EmailMessageEntity[]> {
        // Signum's `using (emailModel.UntypedEntity is IEntity mod ? ExecutionMode.SetIsolation(mod) : null)`:
        // rendering reads the template and whatever the model navigates to, and must do that in the scope of
        // the entity the mail is ABOUT — a mail may well be produced by work that has no ambient scope of its
        // own. No-op unless @altea/altea-isolation is installed.
        const about = model.untypedEntity;
        return await (about == null
            ? render()
            : ExecutionMode.withIsolationOf(about, render));

        async function render(): Promise<EmailMessageEntity[]> {
            const modelEntity = await EmailModelLogic.toEmailModelEntity(modelTypeOf(model));
            const template = await getCurrentTemplate(modelEntity, model.untypedEntity);
            return await EmailTemplateLogic.createEmailMessage(template, model.untypedEntity, model, culture);
        }
    }

    /** Signum's GetCurrentTemplate — the (single) applicable template of a model, creating the default one
     *  when the database has none. */
    export async function getCurrentTemplate(modelEntity: { fullClassName: string; id: unknown }, entity: Entity | null): Promise<EmailTemplateEntity> {
        const all = await EmailTemplateLogic.emailTemplatesLazy.value();
        const candidates = await filterVisible(all.filter(t => t.model != null && String(t.model.id) === String(modelEntity.id)));
        const applicable = candidates.filter(t => EmailTemplateLogic.isApplicable(t, entity));

        if (applicable.length === 1)
            return applicable[0];

        if (applicable.length > 1)
            throw new Error(`More than one active EmailTemplate for EmailModel '${modelEntity.fullClassName}'`);

        // None: generate the model's default template (Signum's CreateDefaultEmailTemplate), in its own
        // transaction and with authorization off — a system mail must work for whoever triggered it.
        return await Transaction.forceNew(() => ExecutionMode.global(async () => {
            const template = await EmailModelLogic.createDefaultTemplateInternal(
                await EmailModelLogic.getEmailModelEntity(modelEntity.fullClassName));
            await template.save();
            EmailTemplateLogic.emailTemplatesLazy.reset();
            return template;
        }));
    }

    /** Signum's `Schema.Current.GetInMemoryFilter<T>(userInterface: false)` over a template list — the
     *  row-level visibility a cached (globally-read) list has to apply itself. */
    export async function filterVisible<T extends Entity>(entities: T[]): Promise<T[]> {
        return inMemoryFilter == undefined ? entities : await inMemoryFilter(entities);
    }

    /** The app / auth module installs the row-level filter (see @altea/altea-user-assets' UserAssetOwnerAuth
     *  for the same seam). Unset ⇒ every template is visible. */
    export let inMemoryFilter: (<T extends Entity>(entities: T[]) => Promise<T[]>) | undefined;

    /** Signum's `WithAttachment(email, filePath, contentId)`. */
    export function withAttachment(email: EmailMessageEntity, file: EmailMessageEntity_Attachment["file"], contentId?: string): EmailMessageEntity {
        email.attachments.push(EmailMessageEntity_Attachment.create({
            contentId: contentId ?? randomUUID(),
            file,
        }));
        return email;
    }

    /** Signum's GetAllTypes — the entity types any stored message actually targets (the byAll branch). */
    export async function getAllTargetTypes(): Promise<string[]> {
        const rows = await table(EmailMessageEntity).filter(e => e.target != null).map(e => e.target).toArray();
        const names = new Set<string>();
        for (const lite of rows)
            if (lite != null)
                names.add((lite as Lite<Entity>).entityType.name);
        return [...names];
    }

    /** Retrieve the entity behind a lite (used for a master template / a target). */
    export async function retrieveLite<T extends Entity>(lite: Lite<T>): Promise<T> {
        return await retrieve(lite.entityType as Type<T>, lite.id) as T;
    }

    // ---- the state machine -----------------------------------------------------------------------------

    const sendableStates = [
        EmailMessageStateEnum.Created, EmailMessageStateEnum.Draft, EmailMessageStateEnum.ReadyToSend,
        EmailMessageStateEnum.RecruitedForSending, EmailMessageStateEnum.Outdated,
    ];

    /** Signum's `Transaction.PostRealCommit += WakeupReadyToSendInThisMachine` — nudge the sender once the
     *  message is really committed (waking it before that would find nothing). */
    function wakeUpAfterCommit(): void {
        Transaction.postRealCommit(() => AsyncEmailSender.wakeUp("ReadyToSend in this machine"));
    }

    const EmailMessageGraph = graph(EmailMessageEntity, EmailMessageStateEnum, g => {
        g.Construct(EmailMessageOperation.CreateMail, {
        construct: () => EmailMessageEntity.create({ state: EmailMessageStateEnum.Created }),
        });

        g.ConstructFrom(EmailTemplateEntity, EmailMessageOperation.CreateEmailFromTemplate, {
        canConstruct: (et: EmailTemplateEntity) => et.model != null && EmailModelLogic.requiresExtraParameters(et.model)
            ? EmailMessageMessage._01requiresExtraParameters.niceToString("EmailModel", et.model.fullClassName)
            : null,
        construct: async (et: EmailTemplateEntity, args?: unknown[]) => {
            const arg = args?.[0];
            const entity = arg instanceof Lite ? await retrieveLite(arg)
                : arg instanceof Entity ? arg
                    : null;

            const messages = await EmailTemplateLogic.createEmailMessage(et, entity);
            if (messages.length === 0)
                throw new Error(EmailMessageMessage.NoSuitableRecipientsWereFound.niceToString());
            return messages[0];
        },
        });

        g.Execute(EmailMessageOperation.Save, {
        canBeNew: true,
        canBeModified: true,
        fromStates: [EmailMessageStateEnum.Created, EmailMessageStateEnum.Outdated],
        toStates: [EmailMessageStateEnum.Draft],
        getState: (m: EmailMessageEntity) => m.state,
        execute: (m: EmailMessageEntity) => { m.state = EmailMessageStateEnum.Draft; },
        });

        g.Execute(EmailMessageOperation.ReadyToSend, {
        canBeNew: true,
        canBeModified: true,
        fromStates: [
            EmailMessageStateEnum.Created, EmailMessageStateEnum.Draft, EmailMessageStateEnum.SentException,
            EmailMessageStateEnum.RecruitedForSending, EmailMessageStateEnum.Outdated,
        ],
        toStates: [EmailMessageStateEnum.ReadyToSend],
        getState: (m: EmailMessageEntity) => m.state,
        execute: (m: EmailMessageEntity) => {
            m.sendRetries = 0 as EmailMessageEntity["sendRetries"];
            m.exception = null;
            m.state = EmailMessageStateEnum.ReadyToSend;
            wakeUpAfterCommit();
        },
        });

        g.Execute(EmailMessageOperation.Send, {
        canBeNew: true,
        canBeModified: true,
        canExecute: (m: EmailMessageEntity) => sendableStates.includes(m.state) ? null
            : EmailMessageMessage.TheEmailMessageCannotBeSentFromState0.niceToString(EmailMessageStateEnum[m.state]),
        execute: async (m: EmailMessageEntity) => await sendMail(m),
        });

        g.ConstructFrom(EmailMessageEntity, EmailMessageOperation.ReSend, {
        construct: (m: EmailMessageEntity) => EmailMessageEntity.create({
            from: m.from.clone(),
            recipients: m.recipients.map(r => EmailMessageEntity_Recipient.create({
                emailOwner: r.emailOwner, emailAddress: r.emailAddress, displayName: r.displayName, kind: r.kind,
            })),
            target: m.target,
            subject: m.subject,
            body: BigStringEmbedded.create({ text: m.body.text }),
            isBodyHtml: m.isBodyHtml,
            template: m.template,
            editableMessage: m.editableMessage,
            state: EmailMessageStateEnum.Created,
            attachments: m.attachments.map(a => EmailMessageEntity_Attachment.create({
                file: a.file, type: a.type, contentId: a.contentId,
            })),
        }),
        });

        g.Delete(EmailMessageOperation.Delete, {
        delete: async (m: EmailMessageEntity) => { await m.delete(); },
        });
    });
}

/** The model's registered TYPE. An altea model is a plain shape, so the type is the entity it is about
 *  (Signum read `model.GetType()`); a model with no entity must be created through its registration. */
function modelTypeOf(model: IEmailModel): Function {
    const modelType = (model as { modelType?: Function }).modelType;
    if (modelType != undefined)
        return modelType;
    if (model.untypedEntity != null)
        return model.untypedEntity.constructor;
    throw new Error("An IEmailModel with no untypedEntity must carry a `modelType` so its registration can be found");
}

/** Re-exported so an app's starter needs only this module. */
export { EmailMasterTemplateEntity, EmailTemplateVisibleOn };