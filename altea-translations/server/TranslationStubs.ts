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
 * Only the DESCRIPTION is stubbed, never the plural or the gender. Those are DERIVED from the description
 * on import (`pluralize` / `detectGender`), and an empty attribute is a value: `Gender=""` would suppress
 * the derivation for good, so a description filled in later would no longer bring its gender with it.
 *
 * Every file is REWRITTEN, including one with nothing to stub, because writing is also what PRUNES: a
 * converted file carries types the package does not declare, and `exportXml` only ever writes what the
 * process has.
 */
export namespace TranslationStubs {

    export interface StubResult {
        /** Types that gained a `Description=""`. */
        types: number;
        /** Members that gained one. */
        members: number;
    }

    /** One package in one culture: stub what the sync reports, and rewrite the file either way. */
    export function stubPackage(packageName: string, culture: string): StubResult {
        const result: StubResult = { types: 0, members: 0 };

        // A package's OWN language is written in the code, not in a file — nothing there is outstanding,
        // and rewriting it would only add the humanised defaults back.
        if (culture === defaultCultureOf(packageName))
            return result;

        const target = importXml(packageName, culture);
        const master = importXml(packageName, defaultCultureOf(packageName));

        // No SUPPORT cultures: they exist only to give a translator better source material, and there is
        // no translator here.
        for (const change of getMergeChanges(target, master, [])) {
            // `typeConflict` also fires for a type whose only gap is the plural or the gender; stub the
            // description alone, and only when that is what is missing.
            if (change.typeConflict != undefined
                && (change.type.description == undefined || change.type.description === "")) {
                change.type.description = "";
                result.types++;
            }
            for (const member of change.memberConflicts.keys()) {
                change.type.members.set(member, "");
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

        let types = 0, members = 0;
        for (const packageName of packages)
            for (const culture of settings.cultures) {
                const r = stubPackage(packageName, culture);
                types += r.types; members += r.members;
                if (r.types > 0 || r.members > 0)
                    SafeConsole.writeLine(`  ${packageName} ${culture}: ${r.types} types, ${r.members} members`);
            }

        SafeConsole.writeLine();
        SafeConsole.writeLine(`[translation-stubs] ${types} type descriptions, ${members} members`);
        SafeConsole.writeLine(`  Now search the translations for  Description=""  and fill them in.`);
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
