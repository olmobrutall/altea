import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { Localization } from "../entities/utils/localization";
type LocalizedType = Localization.LocalizedType;
type LocalizedTypes = Localization.LocalizedTypes;

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
    Localization.addLocalizedTypes(locale, parseSignumTranslations(xml));
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

// Resolve the application's single translations directory (Signum's one output folder per app). The
// deployment controls one path, so this is robust across dev/Docker/bundling — no dependency on
// node_modules layout or per-module resolution. Precedence:
//   1. the explicit `dir` argument (a host that already knows its layout),
//   2. env TRANSLATIONS_DIR (absolute, or relative to the base root),
//   3. `<base>/translations`, where base = env TRANSLATIONS_ROOT ?? process.cwd().
// In Docker: set WORKDIR to the app root and COPY translations there (or set TRANSLATIONS_ROOT to a
// mounted volume). altea-translation writes each module's `<Module>.<culture>.xml` into this one dir.
export function resolveTranslationsDir(dir?: string): string {
    if (dir != null && dir !== "")
        return dir;
    const base = process.env["TRANSLATIONS_ROOT"] || process.cwd();
    const configured = process.env["TRANSLATIONS_DIR"];
    if (configured != null && configured !== "")
        return isAbsolute(configured) ? configured : resolve(base, configured);
    return join(base, "translations");
}

// Load every module's translations from the app's single translations directory (all files merge via
// addLocalizedTypes; filename/alpha order sets precedence — name the app's file so it sorts last if a
// key must win). No-op if the directory does not exist. Call once at server startup.
export function loadAppTranslations(dir?: string): string | undefined {
    const resolved = resolveTranslationsDir(dir);
    if (!existsSync(resolved))
        return undefined;
    loadTranslationsFromDir(resolved);
    return resolved;
}
