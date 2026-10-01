import { determinersFor } from "@altea/altea/data/utils/naturalLanguage";
import { SafeConsole } from "@altea/altea/server/safeConsole";
import { defaultCultureOf, exportXml, importXml, localizablePackages } from "./LocalizedPackage";
import { getMergeChanges } from "./TranslationSynchronizer";

/**
 * The SYNC, with the translators left out and the answer written to the file instead of to a page: every
 * name it reports as outstanding gets an empty placeholder.
 *
 *     <Member Name="Action" Description="" />
 *
 * The point is WHO translates. The sync page's other route is a machine translator — Azure or DeepL, one
 * string at a time with nothing around it. Something reading the FILE has the type the member belongs to,
 * its siblings, the package it came from and the English it renders, which is most of what separates
 * "Aktion" from the wrong one of four German words for it. So this mode hands the context over: stub, then
 * fill in every `Description=""`.
 *
 * It is the sync and not a second opinion about it: `getMergeChanges` is the same function the page calls,
 * so a stub appears exactly where the page would have asked. What it does NOT do is call
 * `getPackageChanges`, which both runs the translators and truncates to a character budget — the page
 * shows one screenful at a time ([9/27]); a file wants all of it.
 *
 * A stub is not a translation. `isTypeCompleted` and `memberConflict` both read "" as missing, so the page
 * still reports the same work, and an unfilled stub disappears again on the next ordinary save.
 *
 * EVERY slot the sync is waiting on gets one — the description, the plural AND the gender — because a slot
 * with no placeholder cannot be filled by editing the file, and that is the whole mode. This reverses the
 * original "description only", whose reasoning (an empty attribute is a value, so `Gender=""` suppresses
 * the `detectGender` derivation for good) was right about the mechanism and wrong about the cost: German
 * gender is derivable only from a handful of suffixes, so `detectGender` returns nothing for most German
 * nouns, and 71 of the 73 incomplete types across the workspace were waiting on the gender ALONE. Stubbing
 * the description they already had changed nothing, and the status page stayed Pending for good.
 *
 * What the suppression costs is real but small and visible: fill in `Description="Bestellung"` and leave
 * `Gender=""`, and the gender no longer arrives by itself — but the type then still reads as incomplete,
 * so the page asks again rather than silently settling for a wrong article. Fill in all of what a stubbed
 * type offers.
 *
 * A DERIVED plural or gender is not a gap and is not stubbed: the sync does not ask for it, and writing
 * `PluralDescription=""` over a plural `pluralize` already produces would be inventing work. In practice
 * that means a German type normally gains `Gender=""` alone.
 *
 * Every file is REWRITTEN, including one with nothing to stub, because writing is also what PRUNES: a
 * converted file carries types the package does not declare, and `exportXml` only ever writes what the
 * process has.
 */
export namespace TranslationStubs {

    export interface StubResult {
        /** Types that gained at least one empty type-level attribute. */
        types: number;
        /** Type-level attributes stubbed, counted one by one (a type can contribute up to three). */
        attributes: number;
        /** Members that gained a `Description=""`. */
        members: number;
    }

    /** One package in one culture: stub what the sync reports, and rewrite the file either way. */
    export function stubPackage(packageName: string, culture: string): StubResult {
        const result: StubResult = { types: 0, attributes: 0, members: 0 };

        // A package's OWN language is written in the code, not in a file — nothing there is outstanding,
        // and rewriting it would only add the humanised defaults back.
        if (culture === defaultCultureOf(packageName))
            return result;

        const target = importXml(packageName, culture);
        const master = importXml(packageName, defaultCultureOf(packageName));

        // Gender is only asked for where the language HAS determiners — the same guard `isTypeCompleted`
        // applies, so an English-side type never grows a `Gender=""` nobody will ever fill.
        const hasGenders = determinersFor(culture).length > 0;

        // No SUPPORT cultures: they exist only to give a translator better source material, and there is
        // no translator here.
        for (const change of getMergeChanges(target, master, [])) {
            const lt = change.type;

            // `typeConflict` fires for a type missing ANY of its three type-level labels; stub exactly the
            // ones that are missing, which is `isTypeCompleted`'s condition read slot by slot.
            if (change.typeConflict != undefined) {
                let stubbed = 0;
                if (lt.options.hasDescription && (lt.description ?? "") === "") { lt.description = ""; stubbed++; }
                if (lt.options.hasPluralDescription && (lt.pluralDescription ?? "") === "") { lt.pluralDescription = ""; stubbed++; }
                if (lt.options.hasGender && hasGenders && (lt.gender ?? "") === "") { lt.gender = ""; stubbed++; }
                if (stubbed > 0) {
                    result.types++;
                    result.attributes += stubbed;
                }
            }
            for (const member of change.memberConflicts.keys()) {
                lt.members.set(member, "");
                result.members++;
            }
        }

        exportXml(target, { keepEmpty: true });
        return result;
    }

    export interface StubSettings {
        /** The cultures to stub. A package's own culture is skipped whatever this says. */
        cultures: string[];
        /** Only these packages. Omitted means every package that declares something localizable. */
        packages?: string[];
    }

    export function stubAll(settings: StubSettings): void {
        const packages = settings.packages ?? localizablePackages();
        SafeConsole.writeLine(`[translation-stubs] ${packages.length} packages, cultures ${settings.cultures.join(" ")}`);

        let types = 0, attributes = 0, members = 0;
        for (const packageName of packages)
            for (const culture of settings.cultures) {
                const r = stubPackage(packageName, culture);
                types += r.types; attributes += r.attributes; members += r.members;
                if (r.types > 0 || r.members > 0)
                    SafeConsole.writeLine(`  ${packageName} ${culture}: ${r.types} types (${r.attributes} attributes), ${r.members} members`);
            }

        SafeConsole.writeLine();
        SafeConsole.writeLine(`[translation-stubs] ${types} types / ${attributes} type attributes, ${members} members`);
        SafeConsole.writeLine(`  Now search the translations for  =""  and fill every one of them in.`);
    }

    /**
     * The whole terminal command, so an application contributes one call.
     *
     *   <cmd>                    every package
     *   <cmd> @altea/altea-auth  …only these
     */
    export function runCommand(args: string[], settings: StubSettings): void {
        const packages = args.filter(a => !a.startsWith("--"));
        const known = new Set(localizablePackages());
        const unknown = packages.filter(p => !known.has(p));
        if (unknown.length > 0) {
            SafeConsole.writeLine(`Not a package that declares anything localizable: ${unknown.join(", ")}`);
            return;
        }
        stubAll({ ...settings, packages: packages.length > 0 ? packages : settings.packages });
    }
}
