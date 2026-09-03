import "@altea/altea/server"; // installs Entity.save()/delete()
import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import { table } from "@altea/altea/server/table";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { TokenMigrationLogic } from "@altea/altea-user-assets/server/TokenMigrationLogic.server";
import { walkQueryTokens, type TokenSlot } from "@altea/altea-user-assets/server/TokenSyncWalker.server";
import type { TokenSyncContext } from "@altea/altea-user-assets/server/TokenSyncContext.server";
import { UserChartEntity } from "../data/UserChart";

// The UserChart half of Signum's `TokenMigrationLogic.TokenSynchronizing` subscription
// (UserChartLogic.TokenMigration_Sync / ProcessUserChart). The walk is the shared one — see
// @altea/altea-user-assets' TokenSyncWalker.
//
// Two things are specific to a chart:
//  - **its column token lives one level down**, on the `element` (`ChartColumnEmbedded`) that altea wraps
//    each `@part` row around, which is exactly why the walker takes accessor SLOTS rather than a shape.
//  - **a chart column's token may be NULL** (an optional chart-script column that the author left
//    unbound), so those rows are skipped rather than walked.
//  - **there is no `groupResults`** and there are no orders: a chart groups by its own dimension columns,
//    and its ordering is the script's. `groupResults: true` is passed so an AGGREGATE token stays legal,
//    which is what a chart's value columns are.

export namespace UserChartTokenSync {
    /** Registered by ChartLogic.start. */
    export function register(): void {
        TokenMigrationLogic.registerTokenSynchronizing("UserChartLogic.tokenSynchronizing", run);
    }

    async function run(ctx: TokenSyncContext): Promise<void> {
        const list = await ExecutionMode.global(async () =>
            await table(UserChartEntity).toArray() as UserChartEntity[]);

        for (const uc of list)
            await processUserChart(ctx, uc);
    }

    async function processUserChart(ctx: TokenSyncContext, uc: UserChartEntity): Promise<void> {
        if (ctx.mode === "Apply") {
            const known = ctx.knownAction(uc);
            if (known != null) {
                try {
                    if (known === "Delete")
                        await deleteUserChart(ctx, uc);
                } catch (e) {
                    ctx.logError(uc, e);
                }
                return;
            }
        }

        try {
            const queryName = QueryLogic.tryToQueryName(uc.query.key);
            if (queryName == null) {
                SafeConsole.writeLineColor(Color.darkRed,
                    `  UserChart '${uc.displayName}': query '${uc.query.key}' no longer exists`);
                return;
            }

            const result = await walkQueryTokens(ctx, {
                queryKey: uc.query.key,
                queryName,
                // See the header: a chart's value columns ARE aggregates.
                groupResults: true,
                filters: {
                    rows: uc.filters,
                    remove: row => {
                        const i = uc.filters.indexOf(row as UserChartEntity["filters"][number]);
                        if (i >= 0)
                            uc.filters.splice(i, 1);
                    },
                },
                columns: uc.columns
                    .filter(col => col.element.token != null)
                    .map((col): TokenSlot => ({
                        get: () => col.element.token!,
                        set: t => { col.element.token = t; },
                        label: col.element.displayName,
                        // A chart column is POSITIONAL — the script binds column 0, 1, 2 — so removing one
                        // would re-bind every column after it to the wrong role. Clearing the token leaves
                        // the slot in place and unbound, which is a state the chart editor already
                        // renders. Signum removes the row; this is the one place the walk's "remove" means
                        // something different, and the reason is the chart script's positional contract.
                        remove: () => { col.element.token = null; },
                    })),
            });

            if (result.outcome === "Skip")
                return;

            if (result.outcome === "Delete") {
                await deleteUserChart(ctx, uc);
                return;
            }

            if (result.outcome === "Touched" && ctx.mode === "Apply")
                await ExecutionMode.global(() => Transaction.forceNew(async () => { await uc.save(); }));
        } catch (e) {
            ctx.logError(uc, e);
        }
    }

    async function deleteUserChart(ctx: TokenSyncContext, uc: UserChartEntity): Promise<void> {
        if (ctx.mode === "Record")
            ctx.addUserAssetAction(uc, "Delete");
        else
            await ExecutionMode.global(() => Transaction.forceNew(async () => { await uc.delete(); }));
    }
}
