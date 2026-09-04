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
import { EmailTemplateEntity } from "../data/EmailTemplate";

// The EmailTemplate half of Signum's `TokenMigrationLogic.TokenSynchronizing` subscription
// (EmailTemplateLogic.TokenMigration_Sync / ProcessEmailTemplate). The filter / order walk is the shared
// one — see @altea/altea-user-assets' TokenSyncWalker.
//
// **SCOPE, and it is a real limit:** this repairs a template's stored QUERY tokens — its filters, its
// orders, and the `from` address token. It does NOT walk the template's BODY text, where `@[Customer.Name]`
// references live. That pass is Signum's `TemplateSynchronizationContext` (Signum.Templating's
// CommonTemplate.cs) plus a `Synchronize` method on every value provider, and altea-templating records it
// as unported — on the grounds that it "needs Signum's TokenMigrations / QueryTokenSynchronizer, which
// altea has no counterpart for". That premise no longer holds: this package and
// @altea/altea-user-assets now provide exactly those. So the body pass is a follow-up with its
// prerequisites in place rather than a design question, and until it lands a renamed token inside a
// template BODY still surfaces the way it does today — as a parse error on the template.
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
