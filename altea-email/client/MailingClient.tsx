import * as React from "react";
import { Dropdown } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import { CultureInfoEntity } from "@altea/altea/data/cultureInfoEntity";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { Constructor } from "@altea/altea/client/Constructor";
import { Operations, EntityOperationSettings } from "@altea/altea/client/Operations";
import { QuickLinkClient, QuickLinkExplore } from "@altea/altea/client/QuickLinkClient";
import { onContextualItems, type ContextualItemsContext, type MenuItemBlock } from "@altea/altea/client/SearchControl/ContextualItems";
import { Entity, type BaseEntity, type Type } from "@altea/altea/data/entity";
import { tryGetTypeInfo } from "@altea/altea/data/reflection";
import { Lite } from "@altea/altea/data/lite";
import { getQueryKey } from "@altea/altea/client/Reflection";
import { getKey as queryKeyOf } from "@altea/altea/data/dynamicQuery/queryUtils";
import type { QueryRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import { TemplatingClient } from "@altea/altea-templating/client/TemplatingClient";
import { UserAssetClient } from "@altea/altea-user-assets/client/UserAssetClient";
import {
    AsyncEmailSenderPermission, EmailConfigurationEmbedded, EmailFromEmbedded, EmailModelEntity,
} from "../data/Email";
import {
    EmailMessageEntity, EmailMessageEntity_Attachment, EmailMessageEntity_Recipient, EmailMessageOperation,
} from "../data/EmailMessage";
import {
    EmailMasterTemplateEntity, EmailMasterTemplateEntity_Message, EmailTemplateEntity, EmailTemplateEntity_Message,
    EmailTemplateVisibleOn, FileTokenAttachmentEntity, ImageAttachmentEntity,
} from "../data/EmailTemplate";
import {
    EmailSenderConfigurationEntity, SmtpEmailServiceEntity, SmtpNetworkDeliveryEmbedded,
} from "../data/EmailSenderConfiguration";
import type { AsyncEmailSenderState } from "../data/AsyncEmailSenderState";
import { registerSpecialAction } from "@altea/altea/client/OmniboxSpecialAction";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import MailingMenu from "./MailingMenu";
import "./Mailing.css";

// Port of Signum.Mailing's MailingClient.tsx — the module's client registration: the async-sender panel
// route, the entity editors, the "send this template" contextual menu / query button, the global quick-link
// to a target's messages, and the typed HTTP client.
//
// altea divergences, documented inline:
//  - `Navigator.addSettings(new EntitySettings(T, view))` → `cb.configure(T).withView(...)`; the server
//    `.WithQuery(() => …)` projections become `withQuerySettings({ defaultColumns })` (altea resolves query
//    columns client-side).
//  - Signum read a query's applicable templates off `queryDescription.emailTemplates` (an extension the
//    server pushed into the QueryDescription DTO). altea has no such DTO, so MailingMenu ASKS for them
//    (API.getEmailTemplates with visibleOn: "Query") when the button renders.
//  - `EvalClient` / `ChangeLogClient` have no altea counterpart on this path.
//  - `registerToString(EmailTemplateMessageEmbedded, …)` is unnecessary: the row's own `toString()` already
//    returns its culture.

export namespace MailingClient {

    export function start(cb: ClientBuilder, options: {
        contextual: boolean;
        queryButton: boolean;
        quickLinkInDefaultGroup?: boolean;
    }): void {

        TemplatingClient.start(cb);

        cb.routes.push(
            { path: "/asyncEmailSender/view", element: <ImportComponent onImport={() => import("./AsyncEmailSenderPage")} /> },
        );

        registerSpecialAction({
            key: "AsyncEmailSenderPanel",
            allowed: () => AuthClient.isPermissionAuthorized(AsyncEmailSenderPermission.ViewAsyncEmailSenderPanel),
            onClick: () => Promise.resolve("/asyncEmailSender/view"),
        });

        cb.configure(EmailMessageEntity)
            .withView(() => import("./Templates/EmailMessage"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(e => e.id),
                    token(e => e.state),
                    token(e => e.subject),
                    token(e => e.template),
                    token(e => e.sent),
                    token(e => e.target),
                    token(e => e.sentBy),
                    token(e => e.exception),
                ],
            }));

        cb.configure(EmailTemplateEntity)
            .withView(() => import("./Templates/EmailTemplate"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(t => t.id),
                    token(t => t.name),
                    token(t => t.query),
                    token(t => t.model),
                ],
            }));

        cb.configure(EmailMasterTemplateEntity)
            .withView(() => import("./Templates/EmailMasterTemplate"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(t => t.id),
                    token(t => t.name),
                    token(t => t.isDefault),
                ],
            }));

        cb.configure(EmailSenderConfigurationEntity)
            .withView(() => import("./Templates/EmailSenderConfiguration"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(s => s.id),
                    token(s => s.name),
                    token(s => s.service),
                ],
            }));

        cb.configure(EmailModelEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(m => m.id),
                    token(m => m.fullClassName),
                ],
            }));

        cb.configure(ImageAttachmentEntity).withView(() => import("./Templates/ImageAttachment"));
        cb.configure(FileTokenAttachmentEntity).withView(() => import("./Templates/FileTokenAttachment"));
        cb.configure(EmailMessageEntity_Recipient).withView(() => import("./Templates/EmailRecipient"));
        cb.configure(EmailFromEmbedded).withView(() => import("./Templates/EmailFrom"));
        cb.configure(EmailConfigurationEmbedded).withView(() => import("./Templates/EmailConfiguration"));
        cb.configure(SmtpEmailServiceEntity).withView(() => import("./SenderServices/SmtpEmailService"));
        cb.configure(SmtpNetworkDeliveryEmbedded).withView(() => import("./SenderServices/SmtpNetworkDelivery"));

        // A NEW template starts with one message in the server's default culture (Signum's constructor).
        Constructor.registerConstructor(EmailTemplateEntity, async () => {
            const culture = (await API.getDefaultCulture()).toLite();
            return EmailTemplateEntity.create({
                messages: [EmailTemplateEntity_Message.create({ culture })],
            });
        });

        Constructor.registerConstructor(EmailMasterTemplateEntity, async () => {
            const culture = (await API.getDefaultCulture()).toLite();
            return EmailMasterTemplateEntity.create({
                messages: [EmailMasterTemplateEntity_Message.create({ culture, text: defaultMasterTemplateText })],
            });
        });

        // "Create an email from this template": what the button must gather first depends on the template's
        // MODEL — an entity-shaped model needs a row picked in a finder, a model with its own editor needs
        // that editor opened (Signum's onClick, minus the isTypeEntity fast path it derived from reflection).
        Operations.addSettings(new EntityOperationSettings(EmailMessageOperation.CreateEmailFromTemplate, {
            onClick: async ctx => {
                const template = ctx.entity as EmailTemplateEntity;
                const constructorType = template.model != null ? await API.getConstructorType(template.model) : undefined;

                if (constructorType == undefined) {
                    if (template.query == null)
                        return await ctx.defaultClick();

                    const lite = await Finder.find({ queryName: template.query.key });
                    if (lite == null)
                        return;

                    return await ctx.defaultClick(await Navigator.API.fetch(lite));
                }

                const setting = settings[constructorType];
                const model = setting?.createFromTemplate != undefined
                    ? await setting.createFromTemplate(template)
                    : await Constructor.construct(constructorType).then(e => e && Navigator.view(e));

                if (model != null)
                    return await ctx.defaultClick(model);
            },
        }));

        Operations.addSettings(new EntityOperationSettings(EmailMessageOperation.ReadyToSend, {
            contextual: { isVisible: () => true },
            contextualFromMany: { isVisible: () => true },
        }));

        if (options.contextual)
            onContextualItems().push(getEmailTemplates);

        if (options.queryButton)
            Finder.ButtonBarQuery.onButtonBarElements().push(ctx =>
                ({ button: <MailingMenu searchControl={ctx.searchControl} /> }));

        // "Emails of this entity" — offered on every type any message actually targets.
        let cachedAllTypes: Promise<string[]> | undefined;
        QuickLinkClient.registerGlobalQuickLink(async entityType => {
            const types = await (cachedAllTypes ??= API.getAllTypes());
            if (!types.includes(entityType))
                return [];

            return [new QuickLinkExplore(EmailMessageEntity, ctx => EmailMessageEntity.findOptions(token => ({
                filterOptions: [{ token: token(e => e.target), value: ctx.lite }],
            })), {
                key: getQueryKey(EmailMessageEntity),
                text: () => EmailMessageEntity.nicePluralName(),
                icon: "envelope",
                iconColor: "orange",
                color: "warning",
                group: options.quickLinkInDefaultGroup ? undefined : null,
            })];
        });

        UserAssetClient.registerExportAssertLink(EmailTemplateEntity);
        UserAssetClient.registerExportAssertLink(EmailMasterTemplateEntity);
    }

    /** Signum's EmailModelSettings — how the client BUILDS a model before constructing a message from it. */
    export interface EmailModelSettings<T extends BaseEntity> {
        createFromTemplate?: (et: EmailTemplateEntity) => Promise<BaseEntity | undefined>;
        createFromEntities?: (et: Lite<EmailTemplateEntity>, lites: Lite<Entity>[]) => Promise<BaseEntity | undefined>;
        createFromQuery?: (et: Lite<EmailTemplateEntity>, req: QueryRequest) => Promise<BaseEntity | undefined>;
    }

    export const settings: { [typeName: string]: EmailModelSettings<BaseEntity> } = {};

    export function register<T extends BaseEntity>(type: Type<T>, setting: EmailModelSettings<T>): void {
        settings[(type as unknown as { typeName: string }).typeName] = setting as EmailModelSettings<BaseEntity>;
    }

    /** Signum's getEmailTemplates contextual item — "send one of these templates for the selected rows". */
    export function getEmailTemplates(ctx: ContextualItemsContext<Entity>): Promise<MenuItemBlock | undefined> | undefined {
        if (ctx.lites.length === 0)
            return undefined;

        if (tryGetTypeInfo(EmailTemplateEntity) == null)
            return undefined;

        return API.getEmailTemplates(
            queryKeyOf(ctx.queryToken.queryName),
            ctx.lites.length > 1 ? "Multiple" : "Single",
            { lite: ctx.lites.length === 1 ? ctx.lites[0] : null },
        ).then(templates => {
            if (templates.length === 0)
                return undefined;

            return {
                header: EmailTemplateEntity.nicePluralName(),
                menuItems: templates.map(et => (
                    <Dropdown.Item key={et.key()} onClick={() => void handleMenuClick(et, ctx)}>
                        <FontAwesomeIcon aria-hidden={true} icon="envelope" className="icon" />
                        {et.toString()}
                    </Dropdown.Item>
                )),
            } satisfies MenuItemBlock;
        });
    }

    export async function handleMenuClick(et: Lite<EmailTemplateEntity>, ctx: ContextualItemsContext<Entity>): Promise<void> {
        const template = await Navigator.API.fetch(et);
        const constructorType = template.model != null ? await API.getConstructorType(template.model) : undefined;

        if (constructorType == undefined)
            return await createAndViewEmail(et, ctx.lites[0]);

        const setting = settings[constructorType];
        if (setting?.createFromEntities == undefined)
            throw new Error(`No 'createFromEntities' is registered in the EmailModelSettings of '${constructorType}'`);

        const model = await setting.createFromEntities(et, ctx.lites);
        if (model != null)
            await createAndViewEmail(et, model);
    }

    export async function createAndViewEmail(template: Lite<EmailTemplateEntity>, ...args: unknown[]): Promise<void> {
        const pack = await Operations.API.constructFromLite(template, EmailMessageOperation.CreateEmailFromTemplate, ...args);
        if (pack != null)
            await Navigator.view(pack);
    }

    export namespace API {

        export function view(): Promise<AsyncEmailSenderState> {
            // The panel polls twice a second; `avoidNotifyPendingRequests` keeps the global loading
            // indicator from flickering (the shape @altea/altea-scheduler's panel uses).
            return ajaxGet({ url: "/api/asyncEmailSender/view", avoidNotifyPendingRequests: true });
        }

        export function start(): Promise<AsyncEmailSenderState> {
            return ajaxPost({ url: "/api/asyncEmailSender/start" }, undefined);
        }

        export function stop(): Promise<AsyncEmailSenderState> {
            return ajaxPost({ url: "/api/asyncEmailSender/stop" }, undefined);
        }

        export interface GetEmailTemplatesRequest {
            lite: Lite<Entity> | null;
        }

        export function getConstructorType(emailModelEntity: EmailModelEntity): Promise<string> {
            return ajaxPost({ url: "/api/email/constructorType" }, emailModelEntity);
        }

        export function getEmailTemplates(
            queryKey: string,
            visibleOn: keyof typeof EmailTemplateVisibleOn,
            request: GetEmailTemplatesRequest,
        ): Promise<Lite<EmailTemplateEntity>[]> {
            return ajaxPost({ url: `/api/email/emailTemplates?queryKey=${encodeURIComponent(queryKey)}&visibleOn=${visibleOn}` }, request);
        }

        export function getAllTypes(signal?: AbortSignal): Promise<string[]> {
            return ajaxGet({ url: "/api/email/getAllTypes", signal });
        }

        export function getDefaultCulture(signal?: AbortSignal): Promise<CultureInfoEntity> {
            return ajaxGet({ url: "/api/email/getDefaultCulture", signal });
        }
    }
}

/** The starting point of a fresh master template — `@[content]` is where a template's body lands. */
const defaultMasterTemplateText = `<html>
<head></head>
<body>
@[content]
</body>
</html>`;

// Referenced so the attachment row type is registered on the client (its editor is opened from the
// message view's attachment table).
void EmailMessageEntity_Attachment;
