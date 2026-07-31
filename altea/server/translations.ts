import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { DescriptionManager, type LocalizedType, type LocalizedTypes } from "../entities/utils/localization";
import { getModuleLocations } from "../entities/registration";

// Server-side reader for Signum's translation XML files (LocalizedAssembly format) — the Translations
// half of the metadata format. Parsed here (Node) with fast-xml-parser and fed to DescriptionManager;
// the client receives the already-parsed LocalizedTypes as JSON (never the XML), so no XML parser ships
// to the browser. File names follow Signum's `<name>.<culture>.xml` convention (e.g. `Southwind.es.xml`).
//
// Shape parsed:
//   <Translations>
//     <Type Name="OrderEntity" Description="Pedido" [PluralDescription=…] [Gender=…]>
//       <Member Name="OrderDate" Description="Fecha del pedido" />
//     </Type>
//   </Translations>
// A "Type" is any named container (entity/embedded/enum/message/operation/symbol) and Name/Member are
// the C# identifiers (PascalCase, suffixes kept).

// attribute keys kept verbatim (no prefix); Type/Member always arrays even when singular.
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    isArray: name => name === "Type" || name === "Member",
});

export function parseSignumTranslations(xml: string): LocalizedTypes {
    const doc = parser.parse(xml) as { Translations?: { Type?: RawType[] } };
    const result: LocalizedTypes = {};
    for (const t of doc.Translations?.Type ?? []) {
        if (t.Name == null) continue;
        const lt: LocalizedType = { members: {} };
        if (t.Description != null) lt.description = String(t.Description);
        if (t.PluralDescription != null) lt.pluralDescription = String(t.PluralDescription);
        if (t.Gender != null) lt.gender = String(t.Gender);
        for (const m of t.Member ?? [])
            if (m.Name != null && m.Description != null)
                lt.members[String(m.Name)] = String(m.Description);
        result[String(t.Name)] = lt;
    }
    return result;
}

interface RawType {
    Name?: string; Description?: string; PluralDescription?: string; Gender?: string;
    Member?: { Name?: string; Description?: string }[];
}

// Parse an XML string and merge it into a locale.
export function loadSignumTranslations(locale: string, xml: string): void {
    DescriptionManager.addLocalizedTypes(locale, parseSignumTranslations(xml));
}

// Load one XML file for an explicit locale.
export function loadTranslationFile(locale: string, path: string): void {
    loadSignumTranslations(locale, readFileSync(path, "utf8"));
}

// Load every `*.<culture>.xml` file in a directory, inferring the locale from each file name.
export function loadTranslationsFromDir(dir: string): void {
    for (const file of readdirSync(dir)) {
        const m = /\.([A-Za-z]{2}(?:-[A-Za-z]{2})?)\.xml$/.exec(file);
        if (m != null)
            loadTranslationFile(m[1], join(dir, file));
    }
}

// Auto-load translations for every registered module (Signum's per-assembly LocalizedAssembly
// merge). Each package keeps its committed XMLs in a `translations/` folder at its package root
// (a sibling of dist/, NOT in the compiled tree — so tsc never has to copy them). We find that root
// from any registered file's import.meta.url (walking up to its package.json), so nothing depends on
// exports maps or a build-time copy step. Packages with no translations/ folder are simply skipped.
// Call once at server startup, after all entity modules are imported (so the registry is complete).
export function loadRegisteredTranslations(): void {
    for (const loc of getModuleLocations()) {
        if (loc.fileUrl == null) continue;
        const root = packageRootFromFileUrl(loc.fileUrl);
        if (root == null) continue;
        const dir = join(root, "translations");
        if (existsSync(dir))
            loadTranslationsFromDir(dir);
    }
}

// Walk up from a file:// URL to the nearest ancestor holding a package.json — the owning package's
// root directory. null if none is found (e.g. a file outside any package).
function packageRootFromFileUrl(fileUrl: string): string | null {
    let dir = dirname(fileURLToPath(fileUrl));
    for (;;) {
        if (existsSync(join(dir, "package.json"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}
