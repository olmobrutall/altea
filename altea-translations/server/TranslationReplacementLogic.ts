import "@altea/altea/server"; // installs save()/toLite()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import "@altea/altea/server/fluentOperations"; // FluentInclude.withSave / withDelete
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { CultureInfoLogic } from "@altea/altea/server/cultureInfoLogic";
import {
    TranslationReplacementEntity, TranslationReplacementOperation,
} from "../data/Translation";

// Port of Signum.Translation's TranslationReplacementLogic.cs — the house-style corrections applied on top
// of whatever an automatic translator returns ("it keeps saying X; we say Y").
//
// altea divergences:
//  - the lazy is ASYNC (altea's ResetLazy is — see CLAUDE.md), so `packFor` awaits it; the callers are the
//    translator decorator and the feedback path, both already async.
//  - the regex is built from the keys LOWER-CASED and matched case-insensitively, with the dictionary
//    keyed the same way — Signum keys its dictionary with an InvariantCultureIgnoreCase comparer, which
//    TypeScript's Map has no counterpart for.
export namespace TranslationReplacementLogic {

    export interface TranslationReplacementPack {
        /** wrong (LOWER-CASED) → right. */
        dictionary: Map<string, string>;
        regex: RegExp;
    }

    let replacementsLazy: ResetLazy<Map<string, TranslationReplacementPack>> = null!;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(TranslationReplacementEntity)
            .withSave(TranslationReplacementOperation.Save)
            .withDelete(TranslationReplacementOperation.Delete)
            .withQuery();

        replacementsLazy = sb.globalLazy(async () => {
            const all = await table(TranslationReplacementEntity).toArray();
            const byCulture = new Map<string, TranslationReplacementPack>();
            for (const culture of new Set(all.map(a => a.cultureInfo.name))) {
                const rows = all.filter(a => a.cultureInfo.name === culture);
                const dictionary = new Map(rows.map(r => [r.wrongTranslation.toLowerCase(), r.rightTranslation]));
                const regex = new RegExp(rows.map(r => escapeRegex(r.wrongTranslation)).join("|"), "gi");
                byCulture.set(culture, { dictionary, regex });
            }
            return byCulture;
        }, { invalidateWith: [TranslationReplacementEntity] });
    }

    /** The corrections registered for a culture, or undefined when there are none. */
    export async function packFor(culture: string): Promise<TranslationReplacementPack | undefined> {
        if (replacementsLazy == null)
            return undefined; // the module was not started
        return (await replacementsLazy.value()).get(culture);
    }

    /**
     * Signum's `ReplacementFeedback`: remember a correction the translator should make from now on. Runs
     * under ExecutionMode.global (Signum's `OperationLogic.AllowSave`) — the correction is a side effect of
     * translating, not a row the user asked to create.
     */
    export async function replacementFeedback(culture: string, wrongTranslation: string, rightTranslation: string): Promise<void> {
        if (wrongTranslation.trim() === "")
            throw new Error("replacementFeedback: the wrong translation is empty");
        if (rightTranslation.trim() === "")
            throw new Error("replacementFeedback: the right translation is empty");

        await ExecutionMode.global(async () => {
            const ci = CultureInfoLogic.getCulture(culture);

            const exists = await table(TranslationReplacementEntity)
                .some(a => a.cultureInfo.is(ci) && a.wrongTranslation == wrongTranslation);
            if (exists)
                return;

            await TranslationReplacementEntity.create({
                cultureInfo: ci,
                wrongTranslation,
                rightTranslation,
            }).save();
        });
    }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
