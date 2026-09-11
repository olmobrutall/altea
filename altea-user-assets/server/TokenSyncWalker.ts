import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import { SubTokensOptions } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import type { QueryFilterBaseEntity, QueryTokenEmbedded } from "../data/Queries";
import { FilterOperation, type FilterOperationKeys } from "@altea/altea/data/dynamicQueries";
import { Enum } from "@altea/altea/data/enum";
import { QueryTokenSynchronizer, type FixTokenResult } from "./QueryTokenSynchronizer";
import type { TokenSyncContext } from "./TokenSyncContext";

// The per-asset token walk: filters, columns (and their summary tokens), orders, and the filter VALUES —
// see port/UserAssets.md.
//
// ONE walk, shared by every subscriber, because every stored row is a `@part` row over the shared
// `QueryFilterBaseEntity` and matching column/order shapes. A subscriber keeps only what is genuinely its
// own — a chart's parameters, a template's text nodes, a user query's paging and system time.
//
// Note which asymmetries are deliberate: a filter may be REMOVED while a column's summary token is merely
// CLEARED, a value fix RE-RUNS the value check, and Skip/Delete abandon the whole asset immediately.

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
    /** Grouping is what makes aggregates legal in a token. */
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
                    remainingText: ` ${operationName(filter.operation)} ${filter.valueString ?? ""}`,
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
                    // dropping the column.
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
    // renamed, an enum member that is gone). A repaired value must be RE-VALIDATED, which is what the
    // `for(;;)` and the `continue retry` below are for.
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
                        continue retry; // re-check the repaired value
                    case "FixTokenInstead": {
                        const t = await QueryTokenSynchronizer.fixToken(ctx, item.token.tokenString,
                            target.queryName,
                            SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement | SubTokensOptions.CanAggregate,
                            {
                                remainingText: ` ${operationName(item.operation)} ${item.valueString ?? ""}`,
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
                            `New filter operation for: ${item.token.tokenString} ${operationName(item.operation)} ${item.valueString ?? ""}?`,
                            ...Enum.values(FilterOperation));
                        if (picked != null) {
                            // A reflected enum FIELD holds the ORDINAL (see the enum convention), so the
                            // picked NAME has to be converted — assigning the name stores a string the
                            // column cannot hold and every later comparison misses.
                            item.operation = Enum.toValue(FilterOperation, picked as FilterOperationKeys);
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

/**
 * The filter operation as its member NAME. A reflected enum field holds the ORDINAL, so interpolating it
 * directly prints `0` where the prompt means to say `EqualTo`.
 */
function operationName(operation: FilterOperation | null): string {
    return operation == null ? "" : Enum.toName(FilterOperation, operation);
}

/** The operations whose value is a `|`-separated list. */
function isListOrPair(operation: unknown): boolean {
    return operation === FilterOperation.IsIn || operation === FilterOperation.IsNotIn;
}
