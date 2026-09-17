import { readFileSync, writeFileSync } from "node:fs";
import "@altea/altea/server";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { CultureInfoLogic } from "@altea/altea/server/cultureInfoLogic";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { TranslationPermission } from "../data/Translation";
import { TranslationReplacementLogic } from "./TranslationReplacementLogic";
import { TranslatedInstanceLogic } from "./TranslatedInstanceLogic";
import { TranslationServer } from "./TranslationServer";
import { TranslatedInstanceServer } from "./TranslatedInstanceServer";
import {
    type ITranslator, AlreadyTranslatedTranslator, ReplacerTranslator,
} from "./Translators";
import { PermissionLogic } from "@altea/altea-auth/server/PermissionLogic";

// Port of Signum.Translation's TranslationLogic.cs — the module starter.
//
// Both halves start from here, exactly as Signum does, and both are optional:
//   • CODE translations edit the per-package `translations/*.xml` files (nothing stored);
//   • INSTANCE translations need a table, so they are opt-in via `instances: true`.
//
// altea divergences:
//  - **`countLocalizationHits` is not ported.** Signum counts, per role and culture, how often a member
//    had no translation (`DescriptionManager.NotLocalizedMember`) so the sync page can order by "what
//    users actually hit". altea's resolver has no such event, and adding one would put a counter on the
//    hottest path in the framework for a sorting nicety. The sync pages order by folder instead.
//  - **`SynchronizeTypes` takes a FILE where Signum takes a prompt.** Signum's terminal command asks,
//    type by type, which old name became which new one, then rewrites the files in place. `convertFile`
//    below reads the same answers from a replacement dictionary, which is what makes a port repeatable
//    and reviewable — and lets one key answer TWICE, for the Signum embedded that altea split in two.
//  - **`CopyTranslations` has no counterpart.** It copies the files out of a build output back into the
//    source tree; a package's `translations/` directory IS the source here, nothing is copied at build
//    time, and a renamed type simply loses its entry — which the sync page then offers to re-fill.
//  - the default translator chain is `Replacer(AlreadyTranslated)` — the free, offline one — so the pages
//    are useful before anyone configures an API key. An app adds Azure / DeepL by passing them in.
export namespace TranslationLogic {

    /** Signum's `Translators` — the chain the sync pages ask for suggestions, in order. */
    export let translators: ITranslator[] = [];

    export interface StartOptions {
        /** Extra translators (Azure, DeepL). Each is wrapped in the house-style replacer, as Signum does. */
        translators?: ITranslator[];
        /** Start the INSTANCE half (the TranslatedInstance table + its pages). Default true. */
        instances?: boolean;
        /**
         * Start the REPLACEMENT half (the house-style corrections table, its search page and its two
         * operations). Default true. Signum has no caller for `TranslationReplacementLogic.Start` — the
         * app opts in — and Southwind does not, so its database has no such table and the replacer that
         * wraps each translator there simply finds nothing to correct.
         */
        replacements?: boolean;
        /**
         * The language the stored (untranslated) instance values are written in — Signum's
         * `TranslatedInstanceLogic.Start(sb, () => CultureInfo.GetCultureInfo("en"))`. Defaults to the
         * process's default UI culture.
         */
        defaultCulture?: () => string;
    }

    export function start(sb: SchemaBuilder, options?: StartOptions): void {
        if (sb.alreadyDefined(start))
            return;

        CultureInfoLogic.start(sb);

        // Signum's `PermissionLogic.RegisterTypes(typeof(TranslationPermission))`.
        PermissionLogic.registerContainer(TranslationPermission);

        if (options?.replacements !== false)
            TranslationReplacementLogic.start(sb);

        // Signum wraps each translator in the replacer so the stored house-style corrections apply to
        // every suggestion; the always-available "this string is already translated elsewhere" one goes
        // first, because it is free and usually right.
        translators = [
            new ReplacerTranslator(new AlreadyTranslatedTranslator()),
            ...(options?.translators ?? []).map(t => new ReplacerTranslator(t)),
        ];

        if (options?.instances ?? true)
            TranslatedInstanceLogic.start(sb, options?.defaultCulture ?? (() => CultureInfo.defaultUICulture()));

        if (sb.webBuilder) {
            TranslationServer.start(sb.webBuilder);
            if (options?.instances ?? true)
                TranslatedInstanceServer.start(sb.webBuilder);
        }
    }

    /** Warm the instance cache's sync snapshot — call after `schema.initialize()`, like CultureInfoLogic. */
    export async function warmUp(): Promise<void> {
        await TranslatedInstanceLogic.warmUp();
    }

    // ---- Converting another framework's translation file ------------------------------------------------

    /** What {@link convertFile} did, for the operator to read. */
    export interface ConvertResult {
        /** `<Type>` snippets read from the source. */
        read: number;
        /** …of those, how many had a dictionary entry. */
        renamed: number;
        /** Extra copies emitted because a key appears more than once. */
        duplicated: number;
        /** Source type names with no entry, copied through unchanged. */
        unmapped: string[];
    }

    /**
     * Copy one translation file to another, renaming the TYPES on the way — Signum's `SynchronizeTypes`
     * with its interactive prompt replaced by a file, which is what makes a port repeatable.
     *
     * Deliberately a TEXT copy, not a parse-and-rebuild: everything the dictionary does not name comes out
     * byte for byte as it went in, so a converted file still diffs cleanly against the one it came from.
     *
     * The dictionary is GLOBAL — one file for a whole port, not one per module — and a key may repeat:
     *
     *     QueryColumnEmbedded -> UserQueryEntity_Column
     *     QueryColumnEmbedded -> UserChartEntity_Column
     *
     * A repeated key emits the snippet ONCE PER TARGET, because altea routinely splits one of Signum's
     * shared embeddeds into a row entity per owner, and each one is described under its own name. That
     * deliberately writes more than the receiving package declares; the first synchronization drops the
     * rest, since `exportXml` only ever writes what the process actually has. Over-writing and letting the
     * sync simplify is the cheap direction — the expensive one is a translation that silently never lands.
     *
     * A name with no entry is copied through unchanged, which is the common case: most types kept their
     * name. The result lists them so the operator can see what the dictionary still owes.
     *
     * The TARGET IS OVERWRITTEN. Point it at a file the source alone should define.
     */
    export function convertFile(sourceFile: string, targetFile: string, dictionaryFile: string): ConvertResult {
        const dictionary = parseDictionary(readFileSync(dictionaryFile, "utf8"));
        const result: ConvertResult = { read: 0, renamed: 0, duplicated: 0, unmapped: [] };

        // Each `<Type …/>` or `<Type …>…</Type>` on its own line, with its indentation, so a duplicate
        // lands in the same column as the original.
        const converted = readFileSync(sourceFile, "utf8").replace(
            /^([ \t]*)(<Type\s[^>]*?(?:\/>|>[\s\S]*?<\/Type>))/gm,
            (whole, indent: string, block: string) => {
                const name = /^<Type\s[^>]*?\bName="([^"]*)"/.exec(block)?.[1];
                if (name == undefined)
                    return whole;

                result.read++;
                const targets = dictionary.get(name);
                if (targets == undefined) {
                    result.unmapped.push(name);
                    return whole;
                }

                result.renamed++;
                result.duplicated += targets.length - 1;
                return targets
                    .map(t => indent + block.replace(/^(<Type\s[^>]*?\bName=")[^"]*(")/, `$1${t}$2`))
                    .join("\n");
            });

        writeFileSync(targetFile, converted, "utf8");
        result.unmapped = [...new Set(result.unmapped)].sort();
        return result;
    }

    /** `Old -> New` per line; `#` comments and blank lines ignored. A repeated key keeps every target. */
    function parseDictionary(text: string): Map<string, string[]> {
        const result = new Map<string, string[]>();
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.replace(/#.*$/, "").trim();
            if (line === "")
                continue;
            const m = /^(\S+)\s*->\s*(\S+)$/.exec(line);
            if (m == undefined)
                throw new Error(`Not a 'Old -> New' line in the replacement dictionary: '${raw.trim()}'`);
            (result.get(m[1]) ?? result.set(m[1], []).get(m[1])!).push(m[2]);
        }
        return result;
    }
}
