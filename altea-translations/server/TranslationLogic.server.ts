import "@altea/altea/server";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { CultureInfoLogic } from "@altea/altea/server/cultureInfoLogic";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { TranslationPermission } from "../data/Translation";
import { TranslationReplacementLogic } from "./TranslationReplacementLogic.server";
import { TranslatedInstanceLogic } from "./TranslatedInstanceLogic.server";
import { TranslationServer } from "./TranslationServer.server";
import { TranslatedInstanceServer } from "./TranslatedInstanceServer.server";
import {
    type ITranslator, AlreadyTranslatedTranslator, ReplacerTranslator,
} from "./Translators.server";

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
//  - **`SynchronizeTypes` / `CopyTranslations` are not ported.** They are Signum's TERMINAL commands for
//    rewriting the XML files after a type rename, and for copying the files out of a build output back
//    into the source tree. altea has neither problem: a package's `translations/` directory IS the source
//    (nothing is copied at build time), and a renamed type simply loses its entry, which the sync page
//    then offers to re-fill.
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

        // Signum's `PermissionLogic.RegisterTypes(typeof(TranslationPermission))`: in altea a symbol is
        // seeded merely by being declared and imported, so referencing it here is the registration.
        void TranslationPermission.TranslateCode;
        void TranslationPermission.TranslateInstances;

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
}
