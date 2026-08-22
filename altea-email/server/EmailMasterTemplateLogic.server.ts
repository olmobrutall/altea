import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { graph } from "@altea/altea/server/graphBuilder";
import { cultureNameOf } from "@altea/altea/data/cultureInfoEntity";
import { table } from "@altea/altea/server/table";
import {
    EmailMasterTemplateEntity, EmailMasterTemplateEntity_Message, EmailMasterTemplateOperation, languageOf,
} from "../data/EmailTemplate";
import { registerEmailMasterTemplateXml } from "./EmailTemplateXml.server";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { CultureInfoLogic } from "@altea/altea/server/cultureInfoLogic";

// Port of Signum.Mailing's Templates/EmailMasterTemplateLogic.cs — the shared chrome a template's body is
// spliced into.
//
// altea divergences, documented inline:
//  - Signum validates "there must be a message for the DEFAULT culture" through a StaticPropertyValidation
//    that reads EmailLogic.Configuration. That would make the isomorphic entity depend on server state, so
//    the entity validates only what it can see (at least one message, no duplicate cultures) and the
//    DEFAULT-culture requirement is checked here, on save.
//  - `GetCultureMessage(ci)` walks `ci.Parent`; altea's cultures are strings, so `languageOf` ("de-CH" → "de")
//    plays that role.

const defaultMasterTemplateHtml = `<html>
<head>
  <meta charset="utf-8" />
</head>
<body style="font-family: sans-serif; font-size: 14px; color: #333;">
@[content]
</body>
</html>`;

/** One message per application culture, each rendered in ITS culture (Signum's CultureInfoLogic.ForEachCulture). */
function forEachCulture(build: (culture: ReturnType<typeof cultureLite>) => EmailMasterTemplateEntity_Message): EmailMasterTemplateEntity_Message[] {
    return CultureInfoLogic.applicationCultures()
        .map(name => CultureInfo.withCultures(name, () => build(cultureLite(name))));
}

function cultureLite(name: string) {
    return CultureInfoLogic.getCulture(name).toLite();
}

export namespace EmailMasterTemplateLogic {

    /** Signum's `CreateDefaultMasterTemplate` — the master template a fresh database gets. */
    /**
     * The master template a fresh database gets (Signum's `EmailMasterTemplateLogic.CreateDefaultMasterTemplate`).
     *
     * altea divergence: Signum leaves this null and constructs an EMPTY template, so every application has to
     * write the chrome itself. Here the MODULE ships a neutral default — plain HTML with `@[content]` where a
     * template's body lands — because nothing about it is app-specific. An app that wants its own branding
     * still just assigns this.
     */
    export let createDefaultMasterTemplate: (() => EmailMasterTemplateEntity) | undefined = () =>
        EmailMasterTemplateEntity.create({
            name: "Default",
            isDefault: true,
            messages: forEachCulture(culture => EmailMasterTemplateEntity_Message.create({
                culture,
                text: defaultMasterTemplateHtml,
            })),
        });

    /** The locale a master template MUST carry a message for — set by EmailLogic.start from the app's
     *  EmailConfiguration (see the header). */
    let requiredCulture: (() => string) | undefined;

    export function start(sb: SchemaBuilder, options?: { requiredCulture?: () => string }): void {
        if (sb.alreadyDefined(start))
            return;

        if (options?.requiredCulture != null)
            requiredCulture = options.requiredCulture;

        // Its message / attachment @part rows are included automatically (see EmailTemplateLogic).
        sb.include(EmailMasterTemplateEntity).withQuery();

        registerEmailMasterTemplateXml();

        graph(EmailMasterTemplateEntity, g => {
        g.ConstructFrom(EmailMasterTemplateOperation.Clone, {
            entityType: EmailMasterTemplateEntity,
            construct: (e: EmailMasterTemplateEntity) => EmailMasterTemplateEntity.create({
                name: `${e.name} (Cloned)`,
                isDefault: e.isDefault,
                messages: e.messages.map(m => m.clone()),
            }),
        });

        g.Construct(EmailMasterTemplateOperation.Create, {
            construct: () => createDefaultMasterTemplate?.() ?? new EmailMasterTemplateEntity(),
        });

        g.Execute(EmailMasterTemplateOperation.Save, {
            canBeNew: true,
            canBeModified: true,
            execute: (t: EmailMasterTemplateEntity) => assertHasRequiredCulture(t),
        });

        // Signum's Delete: the attachment rows the template owns go with it.
        g.Delete(EmailMasterTemplateOperation.Delete, {
            delete: async (e: EmailMasterTemplateEntity) => {
                const attachments = e.attachments.map(a => a.attachment);
                await e.delete();
                for (const a of attachments)
                    await a.delete();
            },
        });
        }).register();
    }

    /** Signum's `GetCultureMessage(template, ci)` — exact locale, then its language. */
    export function getCultureMessage(template: EmailMasterTemplateEntity, culture: string): EmailMasterTemplateEntity_Message | undefined {
        return template.messages.find(m => cultureNameOf(m.culture) === culture)
            ?? template.messages.find(m => cultureNameOf(m.culture) === languageOf(culture));
    }

    /** Signum's GetDefaultMasterTemplate — the flagged default, else create (and save) one. */
    export async function getDefaultMasterTemplate(): Promise<EmailMasterTemplateEntity | undefined> {
        const all = await table(EmailMasterTemplateEntity).filter(t => t.isDefault).toArray() as EmailMasterTemplateEntity[];
        if (all.length > 0)
            return all[0];

        if (createDefaultMasterTemplate == undefined)
            return undefined;

        const newTemplate = createDefaultMasterTemplate();
        newTemplate.isDefault = true;
        await newTemplate.save();
        return newTemplate;
    }

    function assertHasRequiredCulture(t: EmailMasterTemplateEntity): void {
        const culture = requiredCulture?.();
        if (culture == undefined)
            return;

        if (!t.messages.some(m => { const n = cultureNameOf(m.culture); return n != null && culture.startsWith(n); }))
            throw new Error(`EmailMasterTemplate '${t.name}' has no message for the default culture '${culture}'`);
    }
}
