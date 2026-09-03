import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import { SubTokensOptions } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import type { QueryFilterBaseEntity, QueryTokenEmbedded } from "../data/Queries";
import { FilterOperation } from "@altea/altea/data/dynamicQueries";
import { QueryTokenSynchronizer, type FixTokenResult } from "./QueryTokenSynchronizer.server";
import type { TokenSyncContext } from "./TokenSyncContext.server";

// The per-asset token walk: filters, columns (and their summary tokens), orders, and the filter VALUES.
//
// **This is one function where Signum has four.** `UserQueryLogic.ProcessUserQuery`,
// `UserChartLogic.ProcessUserChart`, `EmailTemplateLogic` and `WordTemplateLogic` each carry their own
// ~200-line copy of this same walk, because in Signum the row types (QueryFilterEmbedded,
// QueryColumnEmbedded, QueryOrderEmbedded) are EMBEDDED inside four unrelated MLists with no common
// handle. In altea they are `@part` rows over a shared `QueryFilterBaseEntity` and matching column/order
// shapes, so the walk can be written once and each subscriber keeps only what is genuinely its own —
// a chart's own parameters, a template's own text nodes, a user query's paging and system time.
//
// The behaviour is Signum's, decision for decision: which SubTokensOptions each position gets, that a
// filter may be REMOVED but a column's summary token is merely cleared, that a value fix RE-RUNS the
// value check (Signum's `goto retry`), and that Skip/Delete abandon the whole asset immediately.

/** What the walk concluded about the asset. */
export type WalkOutcome = "Nothing" | "Touched" | "Skip" | "Delete" | "Regenerate";

export interface WalkResult {
    outcome: WalkOutcome;
    /** Human-readable, one per change — what the runner prints and the developer reviews. */
    changes: string[];
}

/** A collection of rows the walk may repair or drop. */
export interface RowSet<R> {
    rows: R[];
    /** Drop this row from the asset (splice IN PLACE, so the saver's snapshot diff sees it). */
    remove(row: R): void;
}

/**
 * One column or order the walk may repair. The four modules keep their token in different PLACES — a
 * user query's column has `token` directly, a chart's wraps it in `element` — so the caller supplies
 * accessors rather than a shape, and a repair writes back where it actually lives.
 */
export interface TokenSlot {
    get(): QueryTokenEmbedded;
    set(token: QueryTokenEmbedded): void;
    /** Only a column has one; an order passes nothing. */
    getSummary?: () => QueryTokenEmbedded | null;
    setSummary?: (token: QueryTokenEmbedded | null) => void;
    /** Printed with the decision, so the developer knows WHICH column is being asked about. */
    label?: string | null;
    /** Drop this row from the asset (splice IN PLACE, so the saver's snapshot diff sees it). */
    remove(): void;
}

export interface WalkTarget {
    /** For the messages, and as the `queryKey` half of a filter-value subKey. */
    queryKey: string;
    queryName: QueryName;
    /** Signum's `uq.GroupResults` — grouping is what makes aggregates legal in a token. */
    groupResults: boolean;

    filters?: RowSet<QueryFilterBaseEntity>;
    columns?: TokenSlot[];
    orders?: TokenSlot[];
}

/**
 * Walk one asset's stored tokens. Returns `Nothing` when everything still resolves — the common case,
 * and why a pass over thousands of assets is cheap.
 */
export async function walkQueryTokens(ctx: TokenSyncContext, target: WalkTarget): Promise<WalkResult> {
    const changes: string[] = [];
    let touched = false;

    // Signum: `uq.GroupResults ? (CanElement | CanAggregate) : CanElement`.
    const options = target.groupResults
        ? SubTokensOptions.CanElement | SubTokensOptions.CanAggregate
        : SubTokensOptions.CanElement;

    const done = (outcome: WalkOutcome): WalkResult => ({ outcome, changes });

    // ---- filters: the token ----------------------------------------------------------------------
    if (target.filters != null && target.filters.rows.length > 0) {
        for (const filter of [...target.filters.rows]) {
            if (filter.token == null)
                continue; // a GROUP row carries no token of its own

            const fixed = await QueryTokenSynchronizer.fixTokenEmbedded(ctx, filter.token, target.queryName,
                options | SubTokensOptions.CanAnyAll,
                {
                    remainingText: ` ${filter.operation ?? ""} ${filter.valueString ?? ""}`,
                    allowRemoveToken: true,
                    allowReGenerate: false,
                });

            switch (fixed.result) {
                case "Nothing": break;
                case "RemoveToken":
                    target.filters.remove(filter); touched = true; changes.push("filter removed"); break;
                case "Fix":
                    filter.token = fixed.token; touched = true;
                    changes.push("filter -> " + fixed.token!.tokenString); break;
                case "SkipEntity": return done("Skip");
                case "DeleteEntity": return done("Delete");
                case "RegenerateEntity": return done("Regenerate");
                default: break;
            }
        }
    }

    // ---- columns: the token, then the summary token ----------------------------------------------
    if (target.columns != null && target.columns.length > 0) {
        const columnOptions = options | SubTokensOptions.CanManual | SubTokensOptions.CanToArray
            | SubTokensOptions.CanSnippet | SubTokensOptions.CanOperation;

        for (const col of [...target.columns]) {
            const fixed = await QueryTokenSynchronizer.fixTokenEmbedded(ctx, col.get(), target.queryName,
                columnOptions,
                {
                    remainingText: col.label != null && col.label !== "" ? ` '${col.label}'` : null,
                    allowRemoveToken: true,
                    allowReGenerate: false,
                });

            switch (fixed.result) {
                case "Nothing": break;
                case "RemoveToken":
                    col.remove(); touched = true; changes.push("column removed"); break;
                case "Fix":
                    col.set(fixed.token!); touched = true;
                    changes.push("column -> " + fixed.token!.tokenString); break;
                case "SkipEntity": return done("Skip");
                case "DeleteEntity": return done("Delete");
                case "RegenerateEntity": return done("Regenerate");
                default: break;
            }

            const summary = col.getSummary?.();
            if (summary != null) {
                const sum = await QueryTokenSynchronizer.fixTokenEmbedded(ctx, summary, target.queryName,
                    options | SubTokensOptions.CanAggregate,
                    {
                        remainingText: col.label != null && col.label !== "" ? ` '${col.label}' (Summary)` : null,
                        allowRemoveToken: true,
                        allowReGenerate: false,
                    });

                switch (sum.result) {
                    case "Nothing": break;
                    // A summary is an EXTRA on a column, so removing it clears the field rather than
                    // dropping the column — Signum makes the same distinction.
                    case "RemoveToken":
                        col.setSummary!(null); touched = true; changes.push("summary token removed"); break;
                    case "Fix":
                        col.setSummary!(sum.token); touched = true;
                        changes.push("summary -> " + sum.token!.tokenString); break;
                    case "SkipEntity": return done("Skip");
                    case "DeleteEntity": return done("Delete");
                    case "RegenerateEntity": return done("Regenerate");
                    default: break;
                }
            }
        }
    }

    // ---- orders ----------------------------------------------------------------------------------
    if (target.orders != null && target.orders.length > 0) {
        for (const ord of [...target.orders]) {
            const fixed = await QueryTokenSynchronizer.fixTokenEmbedded(ctx, ord.get(), target.queryName,
                options, { allowRemoveToken: true, allowReGenerate: false });

            switch (fixed.result) {
                case "Nothing": break;
                case "RemoveToken":
                    ord.remove(); touched = true; changes.push("order removed"); break;
                case "Fix":
                    ord.set(fixed.token!); touched = true;
                    changes.push("order -> " + fixed.token!.tokenString); break;
                case "SkipEntity": return done("Skip");
                case "DeleteEntity": return done("Delete");
                case "RegenerateEntity": return done("Regenerate");
                default: break;
            }
        }
    }

    // ---- filter VALUES ---------------------------------------------------------------------------
    // A token can resolve perfectly while its value no longer means anything (a Lite whose type was
    // renamed, an enum member that is gone). Signum loops with `goto retry` after each fix, because a
    // repaired value must be re-validated; that is the `for(;;)` here.
    if (target.filters != null) {
        for (const item of [...target.filters.rows]) {
            if (item.isGroup || item.token == null)
                continue;

            let resolvedToken;
            try {
                resolvedToken = QueryLogic.getToken(target.queryName, item.token.tokenString,
                    options | SubTokensOptions.CanAnyAll);
            } catch {
                continue; // the token itself is still broken; nothing to say about its value
            }

            retry: for (;;) {
                const fixed = await QueryTokenSynchronizer.fixValue(ctx, target.queryKey,
                    item.token.tokenString, resolvedToken, item.valueString,
                    {
                        allowRemoveToken: true,
                        isListOrPair: isListOrPair(item.operation),
                        fixInstead: true,
                    });

                switch (fixed.result) {
                    case "Nothing": break retry;
                    case "RemoveToken":
                        target.filters.remove(item); touched = true;
                        changes.push("filter value removed"); break retry;
                    case "Fix":
                        item.valueString = fixed.valueString; touched = true;
                        changes.push("filter value -> " + fixed.valueString);
                        continue retry; // Signum's `goto retry`: re-check the repaired value
                    case "FixTokenInstead": {
                        const t = await QueryTokenSynchronizer.fixToken(ctx, item.token.tokenString,
                            target.queryName,
                            SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement | SubTokensOptions.CanAggregate,
                            {
                                remainingText: ` ${item.operation ?? ""} ${item.valueString ?? ""}`,
                                allowRemoveToken: true,
                                allowReGenerate: false,
                            });
                        if (t.result === "RemoveToken") {
                            target.filters.remove(item); touched = true; changes.push("filter removed"); break retry;
                        }
                        if (t.result === "Fix" && t.token != null) {
                            item.token.tokenString = t.token.fullKey();
                            resolvedToken = t.token;
                            touched = true; changes.push("filter -> " + t.token.fullKey());
                            continue retry;
                        }
                        if (t.result === "SkipEntity") return done("Skip");
                        if (t.result === "DeleteEntity") return done("Delete");
                        break retry;
                    }
                    case "FixOperationInstead": {
                        const picked = await SafeConsole.askOptions(
                            `New filter operation for: ${item.token.tokenString} ${item.operation} ${item.valueString}?`,
                            ...Object.keys(FilterOperation));
                        if (picked != null) {
                            item.operation = picked as never;
                            touched = true;
                            changes.push("filter operation -> " + picked);
                        }
                        continue retry;
                    }
                    case "SkipEntity": return done("Skip");
                    case "DeleteEntity": return done("Delete");
                    default: break retry;
                }
                break;
            }
        }
    }

    if (!touched)
        return done("Nothing");

    SafeConsole.writeLineColor(Color.darkGreen, "    " + changes.join(", "));
    return done("Touched");
}

/** Signum's `FilterOperation.IsListOrPair()` — the operations whose value is a `|`-separated list. */
function isListOrPair(operation: unknown): boolean {
    return operation === FilterOperation.IsIn || operation === FilterOperation.IsNotIn;
}
