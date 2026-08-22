import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { graph } from "@altea/altea/server/graphBuilder";
import { cultureNameOf } from "@altea/altea/data/cultureInfoEntity";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Clock } from "@altea/altea/data/utils/clock";
import { TypeReference } from "@altea/altea/data/reflection";
import { TextTemplateParser } from "@altea/altea-templating/server/TextTemplateParser.server";
import type { BlockNode } from "@altea/altea-templating/server/TextTemplateParser.Nodes.server";
import { GlobalValueProvider, type QueryContext } from "@altea/altea-templating/server/ValueProviders.server";
import { TemplatingLogic } from "@altea/altea-templating/server/TemplatingLogic.server";
import { MultiEntityModel, QueryModel } from "@altea/altea-templating/data/Templating";
import { UserHolder } from "@altea/altea/server/userHolder";
import {
    EmailTemplateEntity, EmailTemplateEntity_Message, EmailTemplateEntity_Order, EmailTemplateOperation,
    EmailTemplateVisibleOn, type IAttachmentGeneratorEntity,
} from "../data/EmailTemplate";
import type { EmailMessageEntity } from "../data/EmailMessage";
import type { EmailModelEntity } from "../data/Email";
import type { EmailSenderConfigurationEntity } from "../data/EmailSenderConfiguration";
import { EmailLogic } from "./EmailLogic.server";
import { EmailModelLogic, type IEmailModel } from "./EmailModelLogic.server";
import { EmailMasterTemplateLogic } from "./EmailMasterTemplateLogic.server";
import { EmailMessageBuilder } from "./EmailMessageBuilder.server";
import { registerEmailTemplateXml } from "./EmailTemplateXml.server";

// Port of Signum.Mailing's Templates/EmailTemplateLogic.cs — the template table, its caches, the parse-time
// validation, the operations, and the global variables every template may read.
//
// altea divergences, documented inline:
//  - `ParseData` (resolving each stored token against a QueryDescription on retrieve / before save) is GONE:
//    altea resolves a token from its string WHERE IT IS USED (`QueryLogic.getToken`), so there is nothing to
//    pre-fill. The renderer and the attachment generators resolve their own tokens.
//  - `TokenMigrationLogic.TokenSynchronizing` (the interactive `terminal sync` fix-up of stored tokens) and
//    `Schema_Synchronizing_DefaultTemplates` are NOT ported — see @altea/altea-templating's TemplateUtils
//    header for the missing TokenMigrations infrastructure.
//  - Signum memoises a message's parse tree in `[Ignore]` fields on the embedded (TextParsedNode /
//    SubjectParsedNode). altea keeps the isomorphic entity free of server types, so the trees live in a
//    WeakMap keyed by the message ROW (see parsedNodes below) — same "parse once per template instance".
//  - `IsApplicable` evaluates a code-registered predicate (TemplateApplicableSymbol) instead of a compiled
//    C# script; `GetApplicableEmailTemplates`'s auth filter is `EmailLogic.inMemoryFilter`.
//  - `PreDeleteSqlSync` on EmailModelEntity (the interactive "this model is gone, what now?" console switch)
//    has no altea counterpart.

/** Signum's FillAttachmentTokenContext. */
export interface FillAttachmentTokenContext {
    queryName: QueryName;
    queryTokens: QueryToken[];
    modelType: Function | undefined;
}

/** Signum's GenerateAttachmentContext. */
export interface GenerateAttachmentContext {
    template: EmailTemplateEntity;
    culture: string;
    queryContext: QueryContext | undefined;
    modelType: Function | undefined;
    entity: Entity | null;
    model: IEmailModel | null;
}

/** What an attachment RULE contributes to a message (Signum's `List<EmailAttachmentEmbedded>`). */
export interface GeneratedAttachment {
    fileName: string;
    bytes: Uint8Array;
    contentId: string;
    /** The EmailAttachmentType ordinal (see data/EmailTemplate's EmailAttachmentTypeEnum). */
    type: number;
}

export namespace EmailTemplateLogic {

    /** Signum's `EmailTemplatesLazy`. */
    export let emailTemplatesLazy: ResetLazy<EmailTemplateEntity[]> = null!;

    /** Signum's `GetCultureInfo` — the app's "which locale should THIS entity's mail be in?" hook. */
    export let getCultureInfo: ((entity: Entity | null) => string | undefined) | undefined;

    /** Signum's `GetSmtpConfiguration` — which sender configuration a template / target should use. */
    export let getSenderConfiguration:
        ((template: EmailTemplateEntity | null, target: Lite<Entity> | null, message: EmailMessageEntity | null) => Promise<EmailSenderConfigurationEntity | null>)
        | undefined;

    // Signum's two Polymorphics over IAttachmentGeneratorEntity, keyed by constructor (the shape
    // SchedulerLogic.registerExecuteTask established).
    type FillTokens = (attachment: IAttachmentGeneratorEntity, ctx: FillAttachmentTokenContext) => void;
    type Generate = (attachment: IAttachmentGeneratorEntity, ctx: GenerateAttachmentContext) => Promise<GeneratedAttachment[]>;

    const fillAttachmentTokensHandlers = new Map<Function, FillTokens>();
    const generateAttachmentHandlers = new Map<Function, Generate>();

    /** Signum's memoised parse trees, off the entity (see the header). Keyed by the message ROW instance. */
    const parsedNodes = new WeakMap<object, { subject?: BlockNode; text?: BlockNode }>();

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        TemplatingLogic.start(sb);

        // The @part rows (from / recipients / filters / orders / messages / attachments) need no include of
        // their own: SchemaBuilder.generateField includes every entity a field reaches, propagating this
        // owner's EntityData as it goes.
        sb.include(EmailTemplateEntity).withQuery();

        emailTemplatesLazy = sb.globalLazy(
            () => table(EmailTemplateEntity).toArray() as Promise<EmailTemplateEntity[]>,
            { invalidateWith: [EmailTemplateEntity] });

        EmailModelLogic.start(sb);
        EmailMasterTemplateLogic.start(sb, { requiredCulture: () => EmailLogic.configuration().defaultCulture });

        registerEmailTemplateXml();

        // Signum's PreSaving: re-print each message through the parser, so a stored template is always in
        // canonical form AND a syntax error is caught at save time rather than at send time.
        sb.schema.entityEvents(EmailTemplateEntity).preSaving.push(template => {
            const queryName = tryQueryName(template);
            const modelType = template.model == null ? undefined : EmailModelLogic.toType(template.model);
            for (const message of template.messages) {
                message.text = TextTemplateParser.parse(message.text, queryName, modelType).toString();
                message.subject = TextTemplateParser.parse(message.subject, queryName, modelType).toString();
                // The text just changed, so the memoised trees are stale (Signum's setters nulled them).
                parsedNodes.delete(message);
            }
        });

        registerGraph();
        registerGlobalVariables();
    }

    // ---- global variables (Signum's four RegisterGlobalVariable calls) ----------------------------------

    function registerGlobalVariables(): void {
        const str = new TypeReference({ typeName: "String" });
        const dateTime = new TypeReference({ typeName: "PlainDateTime" });
        const date = new TypeReference({ typeName: "PlainDate" });

        GlobalValueProvider.registerGlobalVariable("UrlLeft", () => EmailLogic.configuration().urlLeft, str);
        GlobalValueProvider.registerGlobalVariable("Now", () => Clock.now, dateTime, "G");
        GlobalValueProvider.registerGlobalVariable("Today", () => Clock.now.toPlainDate(), date, "d");
        // Signum resolves the full UserEntity; altea's UserHolder already carries the lite + claims, and a
        // template that needs a user FIELD reads it off the lite's toStr or through the query.
        GlobalValueProvider.registerGlobalVariable("CurrentUser", () => UserHolder.currentUserLite(),
            new TypeReference({ typeName: "String" }));
    }

    // ---- operations ------------------------------------------------------------------------------------

    function registerGraph(): void {
        graph(EmailTemplateEntity, g => {
        g.Construct(EmailTemplateOperation.Create, {
            construct: async () => EmailTemplateEntity.create({
                masterTemplate: (await EmailMasterTemplateLogic.getDefaultMasterTemplate())?.toLite() ?? null,
            }),
        });

        g.ConstructFrom(EmailTemplateOperation.Clone, {
            entityType: EmailTemplateEntity,
            construct: (e: EmailTemplateEntity) => EmailTemplateEntity.create({
                name: `${e.name} (Cloned)`,
                masterTemplate: e.masterTemplate,
                applicable: e.applicable,
                disableAuthorization: e.disableAuthorization,
                editableMessage: e.editableMessage,
                groupResults: e.groupResults,
                messageFormat: e.messageFormat,
                from: e.from?.clone() ?? null,
                recipients: e.recipients.map(r => r.clone()),
                query: e.query,
                model: e.model,
                orders: e.orders.map(o => EmailTemplateEntity_Order.create({ token: o.token, orderType: o.orderType })),
                messages: e.messages.map(m => m.clone()),
            }),
        });

        g.Execute(EmailTemplateOperation.Save, {
            canBeNew: true,
            canBeModified: true,
            execute: () => { },
        });

        // Signum's Delete: the attachment rows the template owns go with it.
        g.Delete(EmailTemplateOperation.Delete, {
            delete: async (t: EmailTemplateEntity) => {
                // The attachment ENTITIES a row points at are Parts of their own (Signum deleted them too);
                // the rows go with the template's own cascade.
                const attachments = t.attachments.map(a => a.attachment);
                await t.delete();
                for (const a of attachments)
                    await a.delete();
            },
        });
        }).register();
    }

    // ---- parsing ---------------------------------------------------------------------------------------

    /** The template's query as a QueryName, or undefined (a model-only template). */
    export function tryQueryName(template: EmailTemplateEntity): QueryName | undefined {
        return template.query == null ? undefined : QueryLogic.tryGetQueryNameByKey(template.query.key);
    }

    /** Signum's ParseTemplate — parse WITHOUT throwing, for the property validators / the editor. */
    export function parseTemplate(template: EmailTemplateEntity, text: string | null): { node: BlockNode; errorMessage: string } {
        const modelType = template.model == null ? undefined : EmailModelLogic.toType(template.model);
        return TextTemplateParser.tryParse(text, tryQueryName(template), modelType);
    }

    /** Signum's `TextNode(message)` — the message BODY's parse tree, spliced into its master template first,
     *  memoised per message row. */
    export async function textNode(template: EmailTemplateEntity, message: EmailTemplateEntity_Message): Promise<BlockNode> {
        const cached = parsedNodes.get(message);
        if (cached?.text != undefined)
            return cached.text;

        let body = message.text;

        if (template.masterTemplate != null) {
            const master = await EmailLogic.retrieveLite(template.masterTemplate);
            const masterMessage = EmailMasterTemplateLogic.getCultureMessage(master, cultureNameOf(message.culture) ?? EmailLogic.configuration().defaultCulture)
                ?? EmailMasterTemplateLogic.getCultureMessage(master, EmailLogic.configuration().defaultCulture);

            if (masterMessage != null) {
                // `@[content]` is where the body goes. Use a REPLACER FUNCTION so a `$` in the body is not
                // read as a replacement pattern.
                body = masterMessage.text.replace(/@\[content\]/g, () => body);
            }
        }

        const modelType = template.model == null ? undefined : EmailModelLogic.toType(template.model);
        const node = TextTemplateParser.parse(body, tryQueryName(template), modelType);
        parsedNodes.set(message, { ...cached, text: node });
        return node;
    }

    /** Signum's `SubjectNode(message)` — the subject collapses to ONE line before parsing. */
    export function subjectNode(template: EmailTemplateEntity, message: EmailTemplateEntity_Message): BlockNode {
        const cached = parsedNodes.get(message);
        if (cached?.subject != undefined)
            return cached.subject;

        const subject = message.subject.split(/[\r\n]+/).map(l => l.trim()).filter(l => l !== "").join(" ");
        const modelType = template.model == null ? undefined : EmailModelLogic.toType(template.model);
        const node = TextTemplateParser.parse(subject, tryQueryName(template), modelType);
        parsedNodes.set(message, { ...cached, subject: node });
        return node;
    }

    // ---- attachments -----------------------------------------------------------------------------------

    /** Signum's `FillAttachmentTokens.Register(...)`. */
    export function registerFillAttachmentTokens<T extends IAttachmentGeneratorEntity>(
        attachmentType: Function,
        handler: (attachment: T, ctx: FillAttachmentTokenContext) => void,
    ): void {
        fillAttachmentTokensHandlers.set(attachmentType, handler as unknown as FillTokens);
    }

    /** Signum's `GenerateAttachment.Register(...)`. */
    export function registerGenerateAttachment<T extends IAttachmentGeneratorEntity>(
        attachmentType: Function,
        handler: (attachment: T, ctx: GenerateAttachmentContext) => Promise<GeneratedAttachment[]>,
    ): void {
        generateAttachmentHandlers.set(attachmentType, handler as unknown as Generate);
    }

    export function fillAttachmentTokens(attachment: IAttachmentGeneratorEntity, ctx: FillAttachmentTokenContext): void {
        dispatch(fillAttachmentTokensHandlers, attachment, "fillAttachmentTokens")(attachment, ctx);
    }

    export function generateAttachment(attachment: IAttachmentGeneratorEntity, ctx: GenerateAttachmentContext): Promise<GeneratedAttachment[]> {
        return dispatch(generateAttachmentHandlers, attachment, "generateAttachment")(attachment, ctx);
    }

    function dispatch<H>(handlers: Map<Function, H>, attachment: IAttachmentGeneratorEntity, what: string): H {
        for (let ctor: Function | null = attachment.constructor; ctor != null; ctor = Object.getPrototypeOf(ctor) as Function | null) {
            const handler = handlers.get(ctor);
            if (handler != null)
                return handler;
        }
        throw new Error(`EmailTemplateLogic.${what} is not registered for ${attachment.constructor.name}`);
    }

    // ---- creating messages ------------------------------------------------------------------------------

    /** Signum's GetEmailTemplate — the cached template behind a lite. */
    export async function getEmailTemplate(liteTemplate: Lite<EmailTemplateEntity>): Promise<EmailTemplateEntity> {
        const all = await emailTemplatesLazy.value();
        const found = all.find(t => String(t.id) === String(liteTemplate.id));
        if (found == null)
            throw new Error(`Email template ${String(liteTemplate.id)} not in cache`);
        return found;
    }

    /** Signum's `CreateEmailMessage(liteTemplate, entity, model, culture)` — render a template into zero or
     *  more messages (one per From × recipient-group combination). */
    export async function createEmailMessageFromLite(
        liteTemplate: Lite<EmailTemplateEntity>,
        entity?: Entity | null,
        model?: IEmailModel | null,
        culture?: string,
    ): Promise<EmailMessageEntity[]> {
        return await createEmailMessage(await getEmailTemplate(liteTemplate), entity, model, culture);
    }

    export async function createEmailMessage(
        template: EmailTemplateEntity,
        entity?: Entity | null,
        model?: IEmailModel | null,
        culture?: string,
    ): Promise<EmailMessageEntity[]> {
        let theModel = model ?? null;
        let theEntity: Entity | null = null;

        if (template.model != null) {
            // A template with a MODEL renders against that model — build it from the target when the caller
            // did not supply one (Signum's `model ??= EmailModelLogic.CreateModel(...)`; its type check has no
            // counterpart, since an altea model is a plain shape, not a class instance).
            theModel ??= EmailModelLogic.createModel(template.model, entity ?? null);
        } else {
            theEntity = entity ?? null;
        }

        const build = async (): Promise<EmailMessageEntity[]> =>
            await new EmailMessageBuilder(template, theEntity, theModel, culture).createEmailMessages();

        return template.disableAuthorization ? await ExecutionMode.global(build) : await build();
    }

    // ---- applicability / visibility ---------------------------------------------------------------------

    /** Signum's `template.IsApplicable(entity)` — the stored script, compiled on first use. */
    export function isApplicable(template: EmailTemplateEntity, entity: Entity | null): boolean {
        if (template.applicable == null)
            return true;

        try {
            return template.applicable.algorithm(entity);
        } catch (e) {
            throw new Error(`Error evaluating Applicable for EmailTemplate '${template.name}' with entity '${String(entity)}': ${(e as Error).message}`);
        }
    }

    /** Signum's VisibleOnDictionary — where a MODEL's templates are offered. */
    export const visibleOnByModelType = new Map<Function, EmailTemplateVisibleOn>([
        [MultiEntityModel, EmailTemplateVisibleOn.Single | EmailTemplateVisibleOn.Multiple],
        [QueryModel, EmailTemplateVisibleOn.Single | EmailTemplateVisibleOn.Multiple | EmailTemplateVisibleOn.Query],
    ]);

    /** Signum's IsVisible. */
    export function isVisible(template: EmailTemplateEntity, visibleOn: EmailTemplateVisibleOn): boolean {
        if (template.model == null)
            return visibleOn === EmailTemplateVisibleOn.Single;

        // A model that generates its OWN default template is a system mail — never offered in a menu.
        if (EmailModelLogic.hasDefaultTemplateConstructor(template.model))
            return false;

        const modelType = EmailModelLogic.toType(template.model);
        const should = visibleOnByModelType.get(modelType) ?? EmailTemplateVisibleOn.Single;
        return (should & visibleOn) !== 0;
    }

    /** Signum's GetApplicableEmailTemplates — the templates a "send this" menu should offer. */
    export async function getApplicableEmailTemplates(
        queryKey: string,
        entity: Entity | null,
        visibleOn: EmailTemplateVisibleOn,
    ): Promise<Lite<EmailTemplateEntity>[]> {
        const all = await emailTemplatesLazy.value();
        const candidates = all.filter(t => t.query?.key === queryKey && isVisible(t, visibleOn) && isApplicable(t, entity));
        const visible = await EmailLogic.filterVisible(candidates);
        return visible.map(t => t.toLite());
    }

    /** The template rows created for a MODEL that has none yet (the terminal's helper). */
    export async function generateDefaultTemplates(): Promise<string[]> {
        const errors: string[] = [];
        const models = await EmailModelLogic.allEmailModelEntities();

        for (const model of models) {
            const existing = await table(EmailTemplateEntity).filter(t => t.model!.is(model)).toArray();
            if (existing.length > 0)
                continue;

            try {
                const template = await EmailModelLogic.createDefaultTemplateInternal(model);
                await ExecutionMode.global(() => template.save());
            } catch (e) {
                errors.push(`${model.fullClassName}: ${(e as Error).message}`);
            }
        }

        return errors;
    }
}

/** Re-exported for the model / attachment registrations. */
export type { EmailModelEntity };
