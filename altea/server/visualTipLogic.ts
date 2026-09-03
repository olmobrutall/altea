import "./fluentOperations"; // FluentInclude.withDelete
import "./dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "./schema";
import { table } from "./table";
import { SymbolLogic } from "./symbolLogic";
import { ExecutionMode } from "./executionMode";
import { UserHolder } from "./userHolder";
import { Clock } from "../data/utils/clock";
import {
    VisualTipSymbol, VisualTipConsumedEntity, VisualTipConsumedOperation, SearchVisualTip,
} from "../data/visualTip";

// Port of Signum's Basics/VisualTipLogic.cs — the registry of declared tips, and the per-user record of
// which ones have been read.
//
// altea divergences:
//  - Signum's `RegisterType(typeof(SomeVisualTipContainer))` reflects over a static class's fields.
//    TypeScript has no such reflection, so `registerVisualTips(...)` takes the symbols themselves — the
//    same shape `TourTriggerLogic.registerTourTriggers` already has, and what altea uses wherever Signum
//    walks a symbol container.
//  - `SymbolLogic<VisualTipSymbol>.Start(sb, () => VisualTipSymbols)` becomes
//    `SymbolLogic.start(sb, VisualTipSymbol, …)`: the erased generic is the first argument.
//  - `GetConsumed` returns the KEYS rather than the symbols. Signum projects to keys in its controller;
//    doing it here keeps the wire shape in one place and means nothing materialises a symbol just to
//    read its key.

export namespace VisualTipLogic {

    const visualTips = new Set<VisualTipSymbol>();

    /**
     * Signum's `isVisualTipConsumeEnabled` — when it answers false, `getConsumed` returns NULL rather than
     * a list, and the client then treats every tip as unread (the icon keeps beating and nothing is
     * recorded). That is the "demo mode" switch: a shared screenshot account should not accumulate a
     * personal reading history.
     */
    export let isConsumeEnabled: (() => boolean) | undefined;

    export function start(sb: SchemaBuilder, options?: { isConsumeEnabled?: () => boolean }): void {
        if (sb.alreadyDefined(start))
            return;

        isConsumeEnabled = options?.isConsumeEnabled;

        sb.include(VisualTipConsumedEntity)
            .withUniqueIndex(e => [e.visualTip, e.user])
            .withDelete(VisualTipConsumedOperation.Delete)
            .withQuery();

        SymbolLogic.start(sb, VisualTipSymbol, () => registeredVisualTips());

        // The four the SearchControl itself carries (Signum's `RegisterType(typeof(SearchVisualTip))`).
        registerVisualTips(
            SearchVisualTip.SearchHelp,
            SearchVisualTip.GroupHelp,
            SearchVisualTip.FilterHelp,
            SearchVisualTip.ColumnHelp);
    }

    export function registeredVisualTips(): VisualTipSymbol[] {
        return [...visualTips];
    }

    /** Signum's `RegisterVisualTipSymbol` / `RegisterType`, taking the symbols directly — see the header. */
    export function registerVisualTips(...tips: VisualTipSymbol[]): void {
        for (const tip of tips) {
            if (tip == null || tip.key == null || tip.key === "")
                throw new Error("registerVisualTips: the tip has no key (declare it with `init()`)");
            visualTips.add(tip);
        }
    }

    /**
     * Signum's `GetConsumed` — which tips the CURRENT user has already read, or null when consuming is
     * disabled (see isConsumeEnabled).
     *
     * `ExecutionMode.global`, as Signum does: the row belongs to the user reading it, and asking them to
     * hold read permission on a bookkeeping table would make the help itself a privilege.
     */
    export async function getConsumed(): Promise<string[] | null> {
        if (isConsumeEnabled != null && !isConsumeEnabled())
            return null;

        const user = UserHolder.currentUserLite();
        if (user == null)
            return [];

        return await ExecutionMode.global(async () =>
            await table(VisualTipConsumedEntity)
                .filter(vt => vt.user.is(user))
                .map(vt => vt.visualTip.key)
                .toArray());
    }

    /** Signum's `Consume(symbolKey)` — record that the current user has read this tip, once. */
    export async function consume(symbolKey: string): Promise<void> {
        const user = UserHolder.currentUserLite();
        if (user == null)
            return;

        await ExecutionMode.global(async () => {
            const symbol = SymbolLogic.toSymbol(VisualTipSymbol, symbolKey);

            // `count` rather than an `any`: altea's Query has no such method, and one COUNT is the same
            // single round trip Signum's `Any()` is.
            const already = await table(VisualTipConsumedEntity)
                .filter(vt => vt.user.is(user) && vt.visualTip.is(symbol))
                .count();

            if (already > 0)
                return;

            await VisualTipConsumedEntity.create({
                user,
                visualTip: symbol,
                consumedOn: Clock.now,
            }).save();
        });
    }
}
