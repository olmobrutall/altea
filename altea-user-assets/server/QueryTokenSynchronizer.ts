import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import { Replacements } from "@altea/altea/server/sync/synchronizer";
import { StringDistance } from "@altea/altea/server/sync/stringDistance";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { SubTokensOptions, SubTokensOptionsAll, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { cleanTypeName } from "@altea/altea/data/registration";
import { getKey, type QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { QueryTokenEmbedded } from "../data/Queries";
import type { TokenSyncContext } from "./TokenSyncContext";
import { appendValue, filterValueSubKey, valuesOf, type StringOrArray } from "./TokenMigrationFile";

// Port of Signum.UserAssets' Queries/QueryTokenSynchronizer.cs — the engine that takes a STORED token
// string that no longer resolves and either repairs it from recorded history or asks what to do.
//
// The interesting part is `tryResolveParts`: it walks the token's segments against the LIVE schema, and
// at each position consults the rename history for the position's own bucket — keyed by the QUERY at the
// root and by the current TYPE further in. History is chain-composed file by file rather than flattened,
// so `V1: A→B` + `V2: B→C` lands at C in one pass, and each file is looked up under the name its key had
// at that file's era (TokenSyncContext.computeEraSubKeys). A multi-candidate entry is tried in order,
// recursing so the first candidate that resolves ALL the way wins.
//
// altea divergences, documented inline:
//  - **`QueryDescription` is gone**, so every entry point takes the `QueryName` instead and resolution
//    goes through the root token: Signum's `QueryUtils.SubToken(result, qd, options, part)` becomes
//    `(result ?? rootToken).subToken(part, options)`. `result == null` still means "at the query root",
//    so the shape of the algorithm is unchanged.
//  - **staleness is DISCOVERED, not read off the entity.** Signum's retrieve fills
//    `QueryTokenEmbedded.ParseException`, and `FixToken` short-circuits when it is null. In altea `token`
//    and `parseException` are `@column(false) @serialize(false)` and CLIENT-filled, so the server has no
//    such flag: `fixToken` simply tries to resolve the string, and a throw IS the staleness signal. That
//    is strictly more reliable — the flag cannot be stale — and it is why there is no `forceChange`
//    fast path to protect.
//  - Signum's `DelayedConsole` (buffer the entity/field headers, flush only if something is actually
//    asked) is NOT ported: it exists to keep a quiet run quiet, and altea's callers already print one
//    line per asset. The headers are passed as `remainingText` and printed with the decision.
//  - every prompt is ASYNC, so this whole module is.
//  - `FilterValueConverter.IsValidExpression` has no counterpart; see `isValidValue`.

/** Signum's `FixTokenResult`. */
export type FixTokenResult =
    | "Nothing"
    | "Fix"
    | "RemoveToken"
    | "SkipEntity"
    | "DeleteEntity"
    | "RegenerateEntity"
    | "FixTokenInstead"
    | "FixOperationInstead";

/** Signum's `UserAssetTokenAction` — what the interactive picker came back with. */
type UserAssetTokenAction = "Confirm" | "RemoveToken" | "SkipEntity" | "DeleteEntity" | "ReGenerateEntity";

export interface FixTokenOptions {
    /** The text printed after the token — the filter's operation/value, a column's display name, … */
    remainingText?: string | null;
    allowRemoveToken: boolean;
    allowReGenerate: boolean;
}

export namespace QueryTokenSynchronizer {

    /** The root token of a query, which is where a token string starts resolving. */
    function rootTokenOf(queryName: QueryName): QueryToken {
        // `getToken(queryName, "")` is the root itself — the one call that cannot fail for a query that
        // exists, and the counterpart of Signum handing `qd` around.
        return QueryLogic.getToken(queryName, "", SubTokensOptionsAll);
    }

    /**
     * Resolve one segment. Signum's `QueryUtils.SubToken(result, qd, options, part)`, where a null
     * `result` means "at the query root".
     */
    function subToken(result: QueryToken | null, queryName: QueryName, options: SubTokensOptions, part: string): QueryToken | undefined {
        try {
            return (result ?? rootTokenOf(queryName)).subToken(part, options);
        } catch {
            // A token the current ROLE may not read throws rather than answering undefined; for a
            // migration that is the same thing as "does not resolve".
            return undefined;
        }
    }

    /** Signum's `QueryUtils.SplitRegex.Split`, which for altea is `getToken`'s own split. */
    function splitToken(tokenString: string): string[] {
        return tokenString.split(".").filter(p => p.length > 0);
    }

    function cleanTypeNameOf(token: QueryToken): string {
        const ctor = token.type.getFunction?.();
        return ctor != null ? cleanTypeName(ctor as never) : token.type.typeName;
    }

    // ---------- Public entry points ----------

    /**
     * Signum's `FixToken(ctx, ref token, qd, …)` — repair a stored `QueryTokenEmbedded` in place.
     *
     * Returns `Nothing` when the token still resolves (the common case, and the reason a run over
     * thousands of assets is fast).
     */
    export async function fixTokenEmbedded(
        ctx: TokenSyncContext,
        token: QueryTokenEmbedded,
        queryName: QueryName,
        options: SubTokensOptions,
        opts: FixTokenOptions,
    ): Promise<{ result: FixTokenResult; token: QueryTokenEmbedded | null }> {
        // See the header: altea discovers staleness rather than reading a flag.
        if (resolves(token.tokenString, queryName, options))
            return { result: "Nothing", token };

        const fixed = await fixToken(ctx, token.tokenString, queryName, options, opts);
        if (fixed.result === "Fix" && fixed.token != null) {
            const replacement = QueryTokenEmbedded.create({ tokenString: fixed.token.fullKey() });
            return { result: "Fix", token: replacement };
        }
        return { result: fixed.result, token: null };
    }

    /** Whether a token string resolves against the live schema as-is. */
    export function resolves(tokenString: string, queryName: QueryName, options: SubTokensOptions): boolean {
        try {
            QueryLogic.getToken(queryName, tokenString, options);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Signum's `FixToken(ctx, original, out token, qd, …)` — resolve `original` against history + the
     * live schema, prompting only in Record mode.
     */
    export async function fixToken(
        ctx: TokenSyncContext,
        original: string,
        queryName: QueryName,
        options: SubTokensOptions,
        opts: FixTokenOptions,
    ): Promise<{ result: FixTokenResult; token: QueryToken | null }> {
        const remainingText = opts.remainingText ?? "";

        const parsed = tryParseRememberToken(ctx, original, queryName, options, opts.allowRemoveToken);
        if (parsed.found) {
            if (parsed.token == null) {
                // Recorded as removed — only reachable when the caller allows it.
                SafeConsole.writeColor(Color.darkRed, "  " + original);
                SafeConsole.writeColor(Color.darkRed, " (token removed)");
                SafeConsole.writeLine(remainingText);
                return { result: "RemoveToken", token: null };
            }

            if (parsed.token.fullKey() !== original) {
                SafeConsole.writeColor(Color.darkRed, "  " + original);
                SafeConsole.write(" -> ");
                SafeConsole.writeColor(Color.darkGreen, parsed.token.fullKey());
            }
            SafeConsole.writeLine(remainingText);
            return { result: "Fix", token: parsed.token };
        }

        if (!ctx.canPrompt)
            throw new Error(`Cannot resolve token '${original}' against the current schema. `
                + `Apply mode does not prompt — record a decision for it first.`);

        let current = parsed.token;
        for (;;) {
            const picked = await selectInteractive(current, queryName, options, remainingText, opts);
            current = picked.token;
            switch (picked.action) {
                case "DeleteEntity":
                    SafeConsole.writeLineColor(Color.red, "Entity deleted");
                    return { result: "DeleteEntity", token: null };
                case "ReGenerateEntity":
                    if (!opts.allowReGenerate)
                        throw new Error("Unexpected Regenerate");
                    SafeConsole.writeLineColor(Color.magenta, "Entity Regenerated");
                    return { result: "RegenerateEntity", token: null };
                case "RemoveToken":
                    if (!opts.allowRemoveToken)
                        throw new Error("Unexpected RemoveToken");
                    // "" is the recorded form of "this token was removed" (see tryResolveParts).
                    recordTokenRename(ctx, getKey(queryName), /* isQuery */ true, original, "");
                    SafeConsole.writeColor(Color.darkRed, "  " + original);
                    SafeConsole.writeColor(Color.darkRed, " (token removed)");
                    SafeConsole.writeLine(remainingText);
                    return { result: "RemoveToken", token: null };
                case "SkipEntity":
                    SafeConsole.writeLineColor(Color.darkYellow, "Entity skipped");
                    return { result: "SkipEntity", token: null };
                case "Confirm":
                    remember(ctx, original, current!, queryName);
                    SafeConsole.writeColor(Color.darkRed, "  " + original);
                    SafeConsole.write(" -> ");
                    SafeConsole.writeColor(Color.darkGreen, current!.fullKey());
                    SafeConsole.writeLine(remainingText);
                    return { result: "Fix", token: current };
            }
        }
    }

    /**
     * Signum's `FixValue` — repair a stored filter VALUE string whose meaning depended on something that
     * moved (a Lite whose type was renamed, an enum member, a free-text value).
     */
    export async function fixValue(
        ctx: TokenSyncContext,
        queryKey: string,
        tokenString: string,
        token: QueryToken,
        valueString: string | null,
        opts: { allowRemoveToken: boolean; isListOrPair: boolean; fixInstead: boolean },
    ): Promise<{ result: FixTokenResult; valueString: string | null }> {
        if (isValidValue(valueString, token))
            return { result: "Nothing", valueString };

        // A list value is "a|b|c": recurse per item and recompose, so one bad member does not condemn
        // the whole filter.
        if (opts.isListOrPair && valueString != null && valueString.includes("|")) {
            const parts: string[] = [];
            for (const str of valueString.split("|")) {
                const inner = await fixValue(ctx, queryKey, tokenString, token, str,
                    { ...opts, isListOrPair: false });

                if (inner.result === "DeleteEntity" || inner.result === "SkipEntity"
                    || inner.result === "RemoveToken" || inner.result === "FixTokenInstead"
                    || inner.result === "FixOperationInstead")
                    return { result: inner.result, valueString };

                parts.push(inner.valueString ?? "");
            }
            return { result: "Fix", valueString: parts.join("|") };
        }

        // Recorded (queryKey, tokenString, oldValue) → newValue, chained file by file with the queryKey
        // unwound to its era name in each — so an entry stored under the pre-rename query key still hits.
        const eraQueryKeys = ctx.computeEraSubKeys(queryKey);
        let current = valueString ?? "";
        let advanced = false;
        for (let fi = 0; fi < ctx.historyAndRecordingsCount; fi++) {
            const subKey = filterValueSubKey(eraQueryKeys[fi]!, tokenString);
            const d = ctx.getHistoryAndRecording(fi).tryGetDictionary("FilterValue", subKey);
            const v = d?.[current];
            if (v != null) {
                current = v;
                advanced = true;
            }
        }
        if (advanced)
            return { result: "Fix", valueString: current };

        // A Lite value is "Type;id": rewrite the type segment when that type was renamed.
        if (token.type.lite === true && valueString != null) {
            const m = /^(?<type>[^;]+);(?<id>.+)$/.exec(valueString);
            const typeString = m?.groups?.["type"];
            if (typeString != null && !registeredTypeNames().includes(typeString)) {
                const newTypeString = await askTypeReplacement(ctx, typeString);
                if (newTypeString != null && newTypeString !== "")
                    return { result: "Fix", valueString: valueString.replace(typeString, newTypeString) };
            }
        }

        const auto = Replacements.globalAutoReplacement;
        if (auto != null) {
            const sel = auto({ replacementKey: "FixValue", oldValue: valueString ?? "", newValues: [] });
            if (sel?.newValue != null) {
                const oldVal = valueString ?? "";
                if (ctx.recording != null && oldVal !== sel.newValue)
                    ctx.recording.getOrCreateDictionary("FilterValue", filterValueSubKey(queryKey, tokenString))[oldVal] = sel.newValue;
                return { result: "Fix", valueString: sel.newValue };
            }
        }

        if (ctx.recording == null)
            throw new Error(`Cannot fix value '${valueString}' for '${tokenString}' in Apply mode `
                + `(no interactive prompt allowed).`);

        SafeConsole.writeLineColor(Color.white, `Value '${valueString}' is not valid for ${token.type.typeName}.`);
        SafeConsole.writeLineColor(Color.yellow, "- s: Skip entity");
        if (opts.allowRemoveToken)
            SafeConsole.writeLineColor(Color.darkRed, "- r: Remove token");
        SafeConsole.writeLineColor(Color.red, "- d: Delete entity");
        if (opts.fixInstead) {
            SafeConsole.writeLineColor(Color.blue, "- t: Fix Token Instead");
            SafeConsole.writeLineColor(Color.cyan, "- o: Fix Operation Instead");
        }
        SafeConsole.writeLineColor(Color.green, "- freeText: New value");

        const answer = await SafeConsole.askString("");
        const a = answer.toLowerCase();
        if (a === "s") return { result: "SkipEntity", valueString };
        if (opts.allowRemoveToken && a === "r") return { result: "RemoveToken", valueString };
        if (opts.fixInstead) {
            if (a === "t") return { result: "FixTokenInstead", valueString };
            if (a === "o") return { result: "FixOperationInstead", valueString };
        }
        if (a === "d") return { result: "DeleteEntity", valueString };

        const originalValue = valueString ?? "";
        ctx.recording.getOrCreateDictionary("FilterValue", filterValueSubKey(queryKey, tokenString))[originalValue] = answer;
        return { result: "Fix", valueString: answer };
    }

    /**
     * Signum's `FilterValueConverter.IsValidExpression`. altea has no server-side filter-value converter
     * (parsing is client-side — see data/FilterValueString), so validity is judged the way the value is
     * actually USED: a Lite must name a type that still exists, an enum member must still exist, and
     * anything else is accepted. Narrower than Signum's, and deliberately so — a false "invalid" here
     * would prompt a developer about a value that is fine.
     */
    function isValidValue(valueString: string | null, token: QueryToken): boolean {
        if (valueString == null || valueString === "")
            return true;

        if (token.type.lite === true) {
            const m = /^(?<type>[^;]+);(?<id>.+)$/.exec(valueString);
            const typeString = m?.groups?.["type"];
            // Not in "Type;id" shape at all (a [CurrentUser] expression, say) — not ours to judge.
            if (typeString == null)
                return true;
            return registeredTypeNames().includes(typeString);
        }

        const enumObject = token.type.getEnum?.();
        if (enumObject != null) {
            // A stored enum value is the member NAME (see the enum convention in CLAUDE.md).
            return Object.keys(enumObject).includes(valueString);
        }

        return true;
    }

    /** Signum's `TypeLogic.NameToType.Keys` — every clean name the database knows. */
    function registeredTypeNames(): string[] {
        return TypeLogic.allTypeEntities().map(t => t.cleanName);
    }

    // ---------- Internal resolution ----------

    function tryParseRememberToken(
        ctx: TokenSyncContext,
        tokenString: string,
        queryName: QueryName,
        options: SubTokensOptions,
        allowRemoveToken: boolean,
    ): { found: boolean; token: QueryToken | null } {
        const state = { token: null as QueryToken | null };
        const found = tryResolveParts(ctx, splitToken(tokenString), 0, state, queryName, options, allowRemoveToken);
        return { found, token: state.token };
    }

    /**
     * Signum's `TryResolveParts` — resolve `parts[start..]` against history and the live schema, leaving
     * the final token in `state.token`.
     *
     * The history check comes BEFORE trying `subToken`, and that ordering is load-bearing: for a
     * multi-part rename like `B.X` → `X` recorded on the parent type, `B` may still resolve on its own,
     * and advancing past it would leave the walk looking for `X` in the wrong type's bucket.
     */
    function tryResolveParts(
        ctx: TokenSyncContext,
        parts: string[],
        start: number,
        state: { token: QueryToken | null },
        queryName: QueryName,
        options: SubTokensOptions,
        allowRemoveToken: boolean,
    ): boolean {
        for (let i = start; i < parts.length; i++) {
            const part = parts[i]!;

            let remaining = parts.slice(i).join(".");
            const originalRemaining = remaining;
            let consumedOriginalParts = 0;

            const liveSubKey = state.token == null ? getKey(queryName) : cleanTypeNameOf(state.token);
            const eraSubKeys = ctx.computeEraSubKeys(liveSubKey);

            // The first file offering SEVERAL candidates, so the branch can be taken after the chain
            // walk has finished composing.
            let multiOld: string | null = null;
            let multiValues: string[] | null = null;
            let remainingBeforeMulti = remaining;

            for (let fi = 0; fi < ctx.historyAndRecordingsCount; fi++) {
                const file = ctx.getHistoryAndRecording(fi);
                const dic: Record<string, StringOrArray> | undefined = state.token == null
                    ? file.tokensByQuery?.[eraSubKeys[fi]!]
                    : file.tokensByType?.[eraSubKeys[fi]!];

                if (dic == null)
                    continue;

                // LONGEST key first, so `B.X` wins over `B` when both are recorded.
                const old = Object.keys(dic)
                    .sort((a, b) => b.length - a.length)
                    .find(s => remaining === s || remaining.startsWith(s + "."));
                if (old == null)
                    continue;

                const oldPartsCount = old.length === 0 ? 0 : splitToken(old).length;
                if (consumedOriginalParts === 0)
                    consumedOriginalParts = oldPartsCount;

                // "" means "the token was removed". It only means that at the query ROOT, and only when
                // the caller allows removal; anywhere else it is not a usable candidate.
                const allValues = valuesOf(dic[old]);
                const effectiveValues = (state.token != null || !allowRemoveToken)
                    ? allValues.filter(v => v !== "")
                    : allValues;

                if (effectiveValues.length === 0)
                    continue;

                if (effectiveValues.length > 1 && multiOld == null) {
                    multiOld = old;
                    multiValues = effectiveValues;
                    remainingBeforeMulti = remaining;
                }

                // Chain-compose on the FIRST candidate, so a later file can chain onto it.
                const newKey = effectiveValues[0]!;
                if (remaining === old)
                    remaining = newKey;
                else
                    remaining = newKey !== ""
                        ? newKey + remaining.substring(old.length)
                        : remaining.substring(old.length + 1);
            }

            if (remaining !== originalRemaining) {
                if (multiValues != null) {
                    // Try each candidate, recursing so the trailing original parts and any later files
                    // are resolved for that branch too. The first branch that resolves FULLY wins.
                    const trailingCount = parts.length - i - consumedOriginalParts;
                    const trailingParts = parts.slice(parts.length - trailingCount);

                    for (const candidate of multiValues) {
                        const candRemaining = remainingBeforeMulti === multiOld
                            ? candidate
                            : candidate !== ""
                                ? candidate + remainingBeforeMulti.substring(multiOld!.length)
                                : remainingBeforeMulti.substring(multiOld!.length + 1);

                        const candParts = candRemaining !== "" ? splitToken(candRemaining) : [];
                        const suffix = [...candParts, ...trailingParts];

                        const branch = { token: state.token };
                        if (tryResolveParts(ctx, suffix, 0, branch, queryName, options, allowRemoveToken)) {
                            state.token = branch.token;
                            return true;
                        }
                    }
                    return false;
                }

                const subParts = remaining !== "" ? splitToken(remaining) : [];
                const trailingOriginalParts = parts.length - i - consumedOriginalParts;
                const newKeyPartCount = subParts.length - trailingOriginalParts;

                for (let j = 0; j < newKeyPartCount; j++) {
                    const next = subToken(state.token, queryName, options, subParts[j]!);
                    if (next == null)
                        return false;
                    state.token = next;
                }

                i += consumedOriginalParts - 1;
                continue;
            }

            // No recorded rename — try the live schema directly.
            const direct = subToken(state.token, queryName, options, part);
            if (direct != null) {
                state.token = direct;
                continue;
            }

            // The "Entity." prefix fallback, valid only at the query root: a token stored rootless
            // ("Name") against a query whose column is under Entity.
            if (state.token == null) {
                const entity = subToken(null, queryName, options, "Entity");
                const viaEntity = entity == null ? undefined : subToken(entity, queryName, options, part);
                if (viaEntity != null) {
                    state.token = viaEntity;
                    continue;
                }
            }

            const auto = Replacements.globalAutoReplacement;
            if (auto != null && state.token != null) {
                const sel = auto({
                    replacementKey: "QueryToken",
                    oldValue: part,
                    newValues: state.token.subTokens(options).map((a: QueryToken) => a.key),
                });
                if (sel?.newValue != null) {
                    const replaced = subToken(state.token, queryName, options, sel.newValue);
                    if (replaced != null) {
                        state.token = replaced;
                        continue;
                    }
                }
            }

            return false;
        }

        return true;
    }

    /**
     * Signum's `Remember` — persist a confirmed rename, recorded as narrowly as possible.
     *
     * The common PREFIX and SUFFIX of the old and new token paths are stripped first, so what is stored
     * is the segment that actually moved, keyed by the type it moved WITHIN (or by the query when it
     * moved at the root). That is what makes one recorded decision cover every asset whose token happens
     * to pass through the same place.
     */
    function remember(ctx: TokenSyncContext, oldTokenString: string, newToken: QueryToken, queryName: QueryName): void {
        const tokenChain: QueryToken[] = [];
        for (let t: QueryToken | undefined = newToken; t != null; t = t.parent)
            tokenChain.unshift(t);

        const oldParts = splitToken(oldTokenString);
        const newParts = splitToken(newToken.fullKey());

        let pos = -1;
        while (oldParts.length > 0 && newParts.length > 0 && oldParts[0] === newParts[0]) {
            oldParts.shift();
            newParts.shift();
            pos++;
        }
        while (oldParts.length > 0 && newParts.length > 0
            && oldParts[oldParts.length - 1] === newParts[newParts.length - 1]) {
            oldParts.pop();
            newParts.pop();
        }

        if (pos === -1)
            recordTokenRename(ctx, getKey(queryName), /* isQuery */ true, oldParts.join("."), newParts.join("."));
        else
            recordTokenRename(ctx, cleanTypeNameOf(tokenChain[pos]!), /* isQuery */ false, oldParts.join("."), newParts.join("."));
    }

    /**
     * Signum's `RecordTokenRename` — APPEND a candidate rather than overwrite, so context-specific
     * answers accumulate (the same old token can resolve one way for a filter and another for a
     * template) and `tryResolveParts` gets to try them in order.
     */
    function recordTokenRename(ctx: TokenSyncContext, key: string, isQuery: boolean, old: string, replacement: string): void {
        if (ctx.recording == null)
            throw new Error("recordTokenRename is only valid in Record mode.");

        const dict = ctx.recording.getOrCreateTokenDictionary(key, isQuery);
        dict[old] = appendValue(dict[old], replacement);
    }

    /**
     * Signum's `AskTypeReplacement` — a Lite type rename, which lives in the same `types` bucket that
     * query renames do (a query key IS essentially a type's clean name).
     */
    function askTypeReplacement(ctx: TokenSyncContext, oldTypeName: string): Promise<string | null> {
        return ctx.askRename("Types", null, oldTypeName, registeredTypeNames(), new StringDistance());
    }

    // ---------- The interactive picker ----------

    /**
     * Signum's `SelectInteractive` — walk the developer down the token tree one level at a time.
     *
     * Signum draws its own numbered sub-token list with cursor arithmetic; this delegates the LIST to
     * `Replacements.selectInteractive`, the prompt the schema synchronizer already uses, and keeps only
     * the extra verbs that are specific to a stored asset (skip / delete / regenerate / remove).
     */
    async function selectInteractive(
        token: QueryToken | null,
        queryName: QueryName,
        options: SubTokensOptions,
        remainingText: string,
        opts: FixTokenOptions,
    ): Promise<{ action: UserAssetTokenAction; token: QueryToken | null }> {
        let current = token;

        for (;;) {
            SafeConsole.writeLine();
            SafeConsole.writeLineColor(Color.white,
                `  Choose a token for '${current?.fullKey() ?? getKey(queryName)}'${remainingText}`);
            SafeConsole.writeLineColor(Color.yellow, "- s: Skip entity");
            SafeConsole.writeLineColor(Color.red, "- d: Delete entity");
            if (opts.allowRemoveToken)
                SafeConsole.writeLineColor(Color.darkRed, "- r: Remove token");
            if (opts.allowReGenerate)
                SafeConsole.writeLineColor(Color.magenta, "- g: Regenerate entity");
            if (current != null)
                SafeConsole.writeLineColor(Color.green, "- c: Confirm " + current.fullKey());
            SafeConsole.writeLineColor(Color.gray, "- t: Pick a sub-token");
            if (current?.parent != null)
                SafeConsole.writeLineColor(Color.gray, "- u: Up one level");

            const answer = (await SafeConsole.askString("")).toLowerCase();

            if (answer === "s") return { action: "SkipEntity", token: current };
            if (answer === "d") return { action: "DeleteEntity", token: current };
            if (answer === "r" && opts.allowRemoveToken) return { action: "RemoveToken", token: current };
            if (answer === "g" && opts.allowReGenerate) return { action: "ReGenerateEntity", token: current };
            if (answer === "c" && current != null) return { action: "Confirm", token: current };
            if (answer === "u" && current?.parent != null) { current = current.parent; continue; }

            if (answer === "t") {
                const subs = (current ?? rootTokenOf(queryName)).subTokens(options);
                if (subs.length === 0) {
                    SafeConsole.writeLineColor(Color.darkGray, "  (no sub-tokens here)");
                    continue;
                }
                const picked = await new Replacements().selectInteractive(
                    current?.fullKey() ?? getKey(queryName),
                    subs.map((s: QueryToken) => s.key),
                    "QueryToken",
                    new StringDistance());
                if (picked != null) {
                    const next = subToken(current, queryName, options, picked);
                    if (next != null)
                        current = next;
                }
                continue;
            }

            SafeConsole.writeLineColor(Color.red, "  Unrecognised answer");
        }
    }
}
