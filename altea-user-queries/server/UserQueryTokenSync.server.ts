import "@altea/altea/server"; // installs Entity.save()/delete()
import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import { table } from "@altea/altea/server/table";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { TokenMigrationLogic } from "@altea/altea-user-assets/server/TokenMigrationLogic.server";
import { walkQueryTokens, type TokenSlot } from "@altea/altea-user-assets/server/TokenSyncWalker.server";
import type { TokenSyncContext } from "@altea/altea-user-assets/server/TokenSyncContext.server";
import { PaginationMode } from "@altea/altea/data/dynamicQueries";
import { toInt } from "@altea/altea/data/basics";
import { UserQueryEntity } from "../data/UserQuery";

// The UserQuery half of Signum's `TokenMigrationLogic.TokenSynchronizing` subscription
// (UserQueryLogic.TokenMigration_Sync / ProcessUserQuery).
//
// The filter / column / order walk itself lives ONCE in @altea/altea-user-assets' TokenSyncWalker (see
// its header on why Signum has four copies); what is left here is what is genuinely a user query's own:
// its paging, and its system-time dates.

export namespace UserQueryTokenSync {
    /** Registered by UserQueriesLogic.start. */
    export function register(): void {
        TokenMigrationLogic.registerTokenSynchronizing("UserQueryLogic.tokenSynchronizing", run);
    }

    async function run(ctx: TokenSyncContext): Promise<void> {
        const list = await ExecutionMode.global(async () =>
            await table(UserQueryEntity).toArray() as UserQueryEntity[]);

        for (const uq of list)
            await processUserQuery(ctx, uq);
    }

    async function processUserQuery(ctx: TokenSyncContext, uq: UserQueryEntity): Promise<void> {
        // A decision recorded in an earlier session wins in Apply mode — that is what makes a replay
        // unattended: whatever a human already answered is not asked again.
        if (ctx.mode === "Apply") {
            const known = ctx.knownAction(uq);
            if (known != null) {
                try {
                    // Regenerate is not meaningful for a UserQuery (there is no default-template seed to
                    // regenerate from), so it is treated as Skip — Signum says the same in a comment.
                    if (known === "Delete")
                        await deleteUserQuery(ctx, uq);
                    // Skip / Regenerate: nothing to do.
                } catch (e) {
                    ctx.logError(uq, e);
                }
                return;
            }
        }

        try {
            const queryName = QueryLogic.tryToQueryName(uq.query.key);
            if (queryName == null) {
                // The QUERY itself is gone. Nothing about the tokens can be resolved, and it is not a
                // token decision to make — a `.query.json` rename, or deleting the asset, is the answer.
                SafeConsole.writeLineColor(Color.darkRed,
                    `  UserQuery '${uq.displayName}': query '${uq.query.key}' no longer exists`);
                return;
            }

            const result = await walkQueryTokens(ctx, {
                queryKey: uq.query.key,
                queryName,
                groupResults: uq.groupResults,
                filters: {
                    rows: uq.filters,
                    remove: row => {
                        const i = uq.filters.indexOf(row as UserQueryEntity["filters"][number]);
                        if (i >= 0)
                            uq.filters.splice(i, 1);
                    },
                },
                columns: uq.columns.map((col): TokenSlot => ({
                    get: () => col.token,
                    set: t => { col.token = t; },
                    getSummary: () => col.summaryToken,
                    setSummary: t => { col.summaryToken = t; },
                    label: col.displayName,
                    remove: () => { uq.columns.splice(uq.columns.indexOf(col), 1); },
                })),
                orders: uq.orders.map((ord): TokenSlot => ({
                    get: () => ord.token,
                    set: t => { ord.token = t; },
                    remove: () => { uq.orders.splice(uq.orders.indexOf(ord), 1); },
                })),
            });

            if (result.outcome === "Skip")
                return;

            if (result.outcome === "Delete") {
                await deleteUserQuery(ctx, uq);
                return;
            }

            // Signum's own tail: paging that no longer makes sense, and system-time dates that only
            // apply in some modes.
            let touched = result.outcome === "Touched";
            if (uq.appendFilters && uq.filters.length > 0) {
                uq.filters.splice(0, uq.filters.length);
                touched = true;
            }
            // Signum's `uq.ShouldHaveElements` — a per-page count only means something when the query
            // actually pages or takes a first N. altea's entity exposes no such member, so it is
            // computed here from `paginationMode` rather than added to the data layer for one caller.
            const shouldHaveElements = uq.paginationMode === PaginationMode.Paginate
                || uq.paginationMode === PaginationMode.Firsts;

            if (!shouldHaveElements && uq.elementsPerPage != null) {
                uq.elementsPerPage = null;
                touched = true;
            }
            if (shouldHaveElements && uq.elementsPerPage == null) {
                uq.elementsPerPage = toInt(20);
                touched = true;
            }

            if (touched && ctx.mode === "Apply")
                await saveUserQuery(uq);
        } catch (e) {
            ctx.logError(uq, e);
        }
    }

    /** Signum's `SaveUserQuery` — each asset in its OWN transaction, so one bad one does not lose the rest. */
    function saveUserQuery(uq: UserQueryEntity): Promise<void> {
        return ExecutionMode.global(() => Transaction.forceNew(async () => { await uq.save(); }));
    }

    /** Signum's `DeleteUserQuery` — record the decision in Record mode, act on it in Apply mode. */
    async function deleteUserQuery(ctx: TokenSyncContext, uq: UserQueryEntity): Promise<void> {
        if (ctx.mode === "Record")
            ctx.addUserAssetAction(uq, "Delete");
        else
            await ExecutionMode.global(() => Transaction.forceNew(async () => { await uq.delete(); }));
    }
}
