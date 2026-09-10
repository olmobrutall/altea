import "@altea/altea/server"; // installs Entity.save()/delete()
import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import { table } from "@altea/altea/server/table";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { SubTokensOptions } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { TokenMigrationLogic } from "@altea/altea-user-assets/server/TokenMigrationLogic";
import { walkQueryTokens, type TokenSlot } from "@altea/altea-user-assets/server/TokenSyncWalker";
import { QueryTokenSynchronizer } from "@altea/altea-user-assets/server/QueryTokenSynchronizer";
import type { TokenSyncContext } from "@altea/altea-user-assets/server/TokenSyncContext";
import { StringDistance } from "@altea/altea/server/sync/stringDistance";
import { TextTemplateParser } from "@altea/altea-templating/server/TextTemplateParser";
import {
    TemplateSynchronizationContext, TemplateSyncException,
} from "@altea/altea-templating/server/TemplateSync";
import { EmailTemplateEntity } from "../data/EmailTemplate";
import { EmailModelLogic } from "./EmailModelLogic";

// The EmailTemplate half of Signum's `TokenMigrationLogic.TokenSynchronizing` subscription
// (EmailTemplateLogic.TokenMigration_Sync / ProcessEmailTemplate). The filter / order walk is the shared
// one — see @altea/altea-user-assets' TokenSyncWalker.
//
// SCOPE — BOTH halves, in this order:
//
//  1. the stored QUERY tokens: the filters, the orders, and the `from` address token;
//  2. the BODY TEXT of each message, where `@[Customer.Name]` / `@foreach[Details]` live — Signum's
//     `TextTemplateParser.Synchronize` over a `TemplateSynchronizationContext`.
//
// ONE context spans every message, as Signum has it, so a decision answered for the first culture is not
// asked again for the rest.
//
// A template whose `query` is null is MODEL-only (its data comes from a code-declared model, not a
// query), so it has no query tokens to repair at all.

export namespace EmailTemplateTokenSync {
    /** Signum's `AvoidSynchronizeTokens` — a host with thousands of templates can opt out. */
    export let avoidSynchronizeTokens = false;

    /** Registered by EmailLogic.start. */
    export function register(): void {
        TokenMigrationLogic.registerTokenSynchronizing("EmailTemplateLogic.tokenSynchronizing", run);
    }

    async function run(ctx: TokenSyncContext): Promise<void> {
        if (avoidSynchronizeTokens)
            return;

        const list = await ExecutionMode.global(async () =>
            await table(EmailTemplateEntity).toArray() as EmailTemplateEntity[]);

        for (const et of list)
            await processEmailTemplate(ctx, et);
    }

    async function processEmailTemplate(ctx: TokenSyncContext, et: EmailTemplateEntity): Promise<void> {
        if (ctx.mode === "Apply") {
            const known = ctx.knownAction(et);
            if (known != null) {
                try {
                    if (known === "Delete")
                        await deleteTemplate(ctx, et);
                    // Skip / Regenerate: Signum's Regenerate reseeds a template from its model's default
                    // text, which is a template-module operation rather than a token decision; nothing
                    // here can do it, so it is treated as Skip.
                } catch (e) {
                    ctx.logError(et, e);
                }
                return;
            }
        }

        try {
            if (et.query == null)
                return; // model-only (see the header)

            const queryName = QueryLogic.tryToQueryName(et.query.key);
            if (queryName == null) {
                SafeConsole.writeLineColor(Color.darkRed,
                    `  EmailTemplate '${et.name}': query '${et.query.key}' no longer exists`);
                return;
            }

            const result = await walkQueryTokens(ctx, {
                queryKey: et.query.key,
                queryName,
                groupResults: false,
                filters: {
                    rows: et.filters,
                    remove: row => {
                        const i = et.filters.indexOf(row as EmailTemplateEntity["filters"][number]);
                        if (i >= 0)
                            et.filters.splice(i, 1);
                    },
                },
                orders: et.orders.map((ord): TokenSlot => ({
                    get: () => ord.token,
                    set: t => { ord.token = t; },
                    remove: () => { et.orders.splice(et.orders.indexOf(ord), 1); },
                })),
            });

            if (result.outcome === "Skip")
                return;

            if (result.outcome === "Delete") {
                await deleteTemplate(ctx, et);
                return;
            }

            let touched = result.outcome === "Touched";

            // Signum's `et.From.Token` pass. `allowRemoveToken: false` — the token IS the from address
            // when `addressSource` is QueryToken, so removing it would leave the template with no sender.
            if (et.from?.token != null) {
                const fixed = await QueryTokenSynchronizer.fixTokenEmbedded(ctx, et.from.token, queryName,
                    SubTokensOptions.CanElement,
                    { remainingText: " From", allowRemoveToken: false, allowReGenerate: et.model != null });

                if (fixed.result === "Fix") {
                    et.from.token = fixed.token;
                    touched = true;
                } else if (fixed.result === "SkipEntity") {
                    return;
                } else if (fixed.result === "DeleteEntity") {
                    await deleteTemplate(ctx, et);
                    return;
                }
            }

            // The BODY-TEXT pass, per message (one per culture): Signum's `TextTemplateParser.Synchronize`
            // over each Subject and Text. ONE context for the whole template, as Signum has it, so a
            // decision answered for the first culture is not asked again for the rest.
            try {
                const sc = new TemplateSynchronizationContext(et, ctx, new StringDistance(), queryName,
                    et.model == null ? undefined : EmailModelLogic.toType(et.model));

                for (const m of et.messages) {
                    const newSubject = await TextTemplateParser.synchronize(m.subject, sc);
                    if (newSubject != m.subject) { m.subject = newSubject!; touched = true; }

                    const newText = await TextTemplateParser.synchronize(m.text, sc);
                    if (newText != m.text) { m.text = newText!; touched = true; }
                }
            } catch (e) {
                if (!(e instanceof TemplateSyncException))
                    throw e;

                // Signum maps these three the same way the filter walk above does.
                if (e.result === "DeleteEntity") {
                    await deleteTemplate(ctx, et);
                    return;
                }
                // SkipEntity, and RegenerateEntity — which reseeds a template from its model's default
                // text, a template-module operation nothing here can do (see the note in the Apply
                // branch above), so it is treated as Skip.
                return;
            }

            if (touched && ctx.mode === "Apply")
                await ExecutionMode.global(() => Transaction.forceNew(async () => { await et.save(); }));
        } catch (e) {
            ctx.logError(et, e);
        }
    }

    async function deleteTemplate(ctx: TokenSyncContext, et: EmailTemplateEntity): Promise<void> {
        if (ctx.mode === "Record")
            ctx.addUserAssetAction(et, "Delete");
        else
            await ExecutionMode.global(() => Transaction.forceNew(async () => { await et.delete(); }));
    }
}
