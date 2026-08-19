import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { retrieve } from "@altea/altea/server/Database";
import { Entity, type Type } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { cleanTypeName } from "@altea/altea/data/registration";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { AsyncEmailSenderPermission } from "../data/Email";
import type { AsyncEmailSenderState, AsyncEmailSenderHealth } from "../data/AsyncEmailSenderState";
import { EmailTemplateVisibleOn, type EmailTemplateEntity } from "../data/EmailTemplate";
import { EmailModelEntity } from "../data/Email";
import { AsyncEmailSender } from "./AsyncEmailSender.server";
import { EmailLogic } from "./EmailLogic.server";
import { EmailModelLogic } from "./EmailModelLogic.server";
import { EmailTemplateLogic } from "./EmailTemplateLogic.server";

// Port of Signum.Mailing's MailingController.cs + MailingServer.cs — the module's HTTP surface: the async
// sender panel's three calls plus the lookups the "send this template" menus make.
//
// altea divergences, documented inline:
//  - Signum's controller sleeps a second after start/stop so the panel's immediate reload sees the new state;
//    both are awaited here, so there is nothing to sleep for (the shape @altea/altea-scheduler settled on).
//  - `QueryDescriptionTS.AddExtension` (which pushed a query's applicable templates into the query-description
//    DTO) has NO counterpart: altea has no QueryDescription DTO. The client asks for them explicitly through
//    `/api/email/emailTemplates` instead (see the client's MailingClient.API.getEmailTemplates).
//  - `ReflectionServer.OverrideIsNamespaceAllowed` / `TemplatingServer.TemplateTokenMessageAllowed` gate a
//    namespace's translations behind type auth; altea ships ONE reflection blob at boot, so there is no gate.
//  - `AfterDeserilization(EmailTemplateEntity) → ParseData` is gone with ParseData (see EmailTemplateLogic).
//  - `getDefaultCulture` returns the plain locale STRING (altea has no CultureInfoEntity).

export namespace MailingServer {
    let started = false;

    export function start(ws: WebBuilder): void {
        if (started)
            return;
        started = true;

        // ---- the async sender panel ---------------------------------------------------------------------

        ws.get("/api/asyncEmailSender/view",
            { res: CustomType<AsyncEmailSenderState>() },
            async (_req, res) => {
                await assertAuthorized();
                res.jsonTyped(AsyncEmailSender.executionState());
            });

        // Anonymous on purpose (Signum's [SignumAllowAnonymous]): this is what a monitor polls.
        ws.get("/api/asyncEmailSender/healthCheck",
            { res: CustomType<AsyncEmailSenderHealth>(), allowAnonymous: true },
            async (_req, res) => {
                const health = AsyncEmailSender.getHealthStatus();
                res.status(health.status === "Healthy" ? 200 : 503).jsonTyped(health);
            });

        ws.post("/api/asyncEmailSender/start",
            { req: CustomType<void>(), res: CustomType<AsyncEmailSenderState>() },
            async (_req, res) => {
                await assertAuthorized();
                await AsyncEmailSender.startAsyncEmailSender();
                res.jsonTyped(AsyncEmailSender.executionState());
            });

        ws.post("/api/asyncEmailSender/stop",
            { req: CustomType<void>(), res: CustomType<AsyncEmailSenderState>() },
            async (_req, res) => {
                await assertAuthorized();
                AsyncEmailSender.stop();
                res.jsonTyped(AsyncEmailSender.executionState());
            });

        // ---- the "send this template" lookups -----------------------------------------------------------

        // Signum's GetConstructorType: which TYPE the client must build before it can construct a message
        // from this template's model (an entity clean name ⇒ pick one with a finder; a model ⇒ open its view).
        ws.post("/api/email/constructorType",
            { req: CustomType<EmailModelEntity>(), res: CustomType<string>() },
            async (req, res) => {
                const queryName = EmailModelLogic.getQueryName(await req.jsonTyped());
                res.jsonTyped(typeof queryName === "function" ? cleanTypeName(queryName) : String(queryName));
            });

        // Signum's GetEmailTemplates: the templates a contextual menu / a query button should offer.
        ws.post("/api/email/emailTemplates",
            { req: CustomType<{ lite: Lite<Entity> | null }>(), res: CustomType<Lite<EmailTemplateEntity>[]>() },
            async (req, res) => {
                const queryKey = String(req.query["queryKey"] ?? "");
                const visibleOn = visibleOnOf(String(req.query["visibleOn"] ?? "Single"));
                // `req.body` is the RAW string, not the parsed object — reading `.lite` off it always
                // yielded undefined, so a single-row contextual menu silently lost its entity filter.
                const lite = (await req.jsonTyped())?.lite ?? null;
                const entity = lite == null ? null : await retrieve(lite.entityType as Type<Entity>, lite.id);

                res.jsonTyped(await EmailTemplateLogic.getApplicableEmailTemplates(queryKey, entity, visibleOn));
            });

        // Signum's GetAllTypes: which entity types have messages at all (the global quick-link's gate).
        ws.get("/api/email/getAllTypes",
            { res: CustomType<string[]>() },
            async (_req, res) => {
                res.jsonTyped(await EmailLogic.getAllTargetTypes());
            });

        ws.get("/api/email/getDefaultCulture",
            { res: CustomType<string>() },
            async (_req, res) => {
                res.jsonTyped(EmailLogic.configuration().defaultCulture);
            });

        AsyncEmailSender.installShutdownHook();
    }
}

function visibleOnOf(name: string): EmailTemplateVisibleOn {
    switch (name) {
        case "Multiple": return EmailTemplateVisibleOn.Multiple;
        case "Query": return EmailTemplateVisibleOn.Query;
        default: return EmailTemplateVisibleOn.Single;
    }
}

// The same shape @altea/altea-scheduler uses for its permission gate.
async function assertAuthorized(): Promise<void> {
    if (!(await PermissionAuthLogic.isAuthorized(AsyncEmailSenderPermission.ViewAsyncEmailSenderPanel)))
        throw new UnauthorizedAccessException(`Not authorized for '${AsyncEmailSenderPermission.ViewAsyncEmailSenderPanel.key}'`);
}
