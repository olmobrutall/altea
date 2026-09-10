import "@altea/altea/server"; // installs Entity.save()/delete()
import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import { table } from "@altea/altea/server/table";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { TokenMigrationLogic } from "@altea/altea-user-assets/server/TokenMigrationLogic";
import { walkQueryTokens, type TokenSlot } from "@altea/altea-user-assets/server/TokenSyncWalker";
import type { TokenSyncContext } from "@altea/altea-user-assets/server/TokenSyncContext";
import { OfficeTemplateEntity } from "../data/OfficeTemplate";

// The OfficeTemplate half of Signum's `TokenMigrationLogic.TokenSynchronizing` subscription
// (WordTemplateLogic.TokenMigration_Sync / ProcessWordTemplate — `Word*` is `Office*` here, see
// data/OfficeTemplate's naming divergence). The filter / order walk is the shared one — see
// @altea/altea-user-assets' TokenSyncWalker.
//
// **SCOPE:** as with @altea/altea-email's, this repairs the template's stored QUERY tokens (filters,
// orders). It does NOT walk the tokens inside the DOCUMENT — an office template's `@[Customer.Name]`
// lives in the .docx/.pptx/.xlsx bytes, which Signum walks with `TemplateSynchronizationContext` over the
// parsed document. That pass is the follow-up altea-email's header describes; its prerequisites (this
// module and @altea/altea-user-assets' QueryTokenSynchronizer) now exist, and until it lands a renamed
// token inside a document surfaces as a parse error when the template is rendered.
//
// A template whose `query` is null is MODEL-only, so it has no query tokens to repair.

export namespace OfficeTemplateTokenSync {
    export let avoidSynchronizeTokens = false;

    /** Registered by OfficeTemplateLogic.start. */
    export function register(): void {
        TokenMigrationLogic.registerTokenSynchronizing("OfficeTemplateLogic.tokenSynchronizing", run);
    }

    async function run(ctx: TokenSyncContext): Promise<void> {
        if (avoidSynchronizeTokens)
            return;

        const list = await ExecutionMode.global(async () =>
            await table(OfficeTemplateEntity).toArray() as OfficeTemplateEntity[]);

        for (const ot of list)
            await processTemplate(ctx, ot);
    }

    async function processTemplate(ctx: TokenSyncContext, ot: OfficeTemplateEntity): Promise<void> {
        if (ctx.mode === "Apply") {
            const known = ctx.knownAction(ot);
            if (known != null) {
                try {
                    if (known === "Delete")
                        await deleteTemplate(ctx, ot);
                } catch (e) {
                    ctx.logError(ot, e);
                }
                return;
            }
        }

        try {
            if (ot.query == null)
                return;

            const queryName = QueryLogic.tryToQueryName(ot.query.key);
            if (queryName == null) {
                SafeConsole.writeLineColor(Color.darkRed,
                    `  OfficeTemplate '${ot.name}': query '${ot.query.key}' no longer exists`);
                return;
            }

            const result = await walkQueryTokens(ctx, {
                queryKey: ot.query.key,
                queryName,
                groupResults: false,
                filters: {
                    rows: ot.filters,
                    remove: row => {
                        const i = ot.filters.indexOf(row as OfficeTemplateEntity["filters"][number]);
                        if (i >= 0)
                            ot.filters.splice(i, 1);
                    },
                },
                orders: ot.orders.map((ord): TokenSlot => ({
                    get: () => ord.token,
                    set: t => { ord.token = t; },
                    remove: () => { ot.orders.splice(ot.orders.indexOf(ord), 1); },
                })),
            });

            if (result.outcome === "Skip")
                return;

            if (result.outcome === "Delete") {
                await deleteTemplate(ctx, ot);
                return;
            }

            if (result.outcome === "Touched" && ctx.mode === "Apply")
                await ExecutionMode.global(() => Transaction.forceNew(async () => { await ot.save(); }));
        } catch (e) {
            ctx.logError(ot, e);
        }
    }

    async function deleteTemplate(ctx: TokenSyncContext, ot: OfficeTemplateEntity): Promise<void> {
        if (ctx.mode === "Record")
            ctx.addUserAssetAction(ot, "Delete");
        else
            await ExecutionMode.global(() => Transaction.forceNew(async () => { await ot.delete(); }));
    }
}
