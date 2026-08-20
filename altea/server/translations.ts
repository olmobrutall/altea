import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { Metadata } from "../data/metadata";
import type { TypeMetadata } from "../data/metadata";

// Server-side reader for Signum's translation XML files (LocalizedAssembly format) — the per-culture
// half of the metadata blob. Parsed here (Node) with fast-xml-parser into TypeMetadata and merged into
// the Metadata store; the client only ever receives the assembled blob as JSON, so no XML parser ships
// to the browser. File names follow Signum's `<name>.<culture>.xml` convention (e.g. `Southwind.es.xml`).
//
// A translation file names ONLY the pieces it translates, so the TypeMetadata it yields is partial: the
// `kind` is a placeholder ("Entity") that the metadata builder overwrites from the real registry, and
// absent members simply fall back to the humanised identifier.
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

export function parseSignumTranslations(xml: string): Record<string, TypeMetadata> {
    const doc = parser.parse(xml) as { Translations?: { Type?: RawType[] } };
    const result: Record<string, TypeMetadata> = {};
    for (const t of doc.Translations?.Type ?? []) {
        if (t.Name == null) continue;
        const tm: TypeMetadata = { kind: "Entity", fields: {} };
        if (t.Description != null) tm.niceName = String(t.Description);
        if (t.PluralDescription != null) tm.nicePluralName = String(t.PluralDescription);
        if (t.Gender != null) tm.gender = String(t.Gender);
        for (const m of t.Member ?? [])
            if (m.Name != null && m.Description != null)
                tm.fields[String(m.Name)] = { niceName: String(m.Description) };
        result[String(t.Name)] = tm;
    }
    return result;
}

interface RawType {
    Name?: string; Description?: string; PluralDescription?: string; Gender?: string;
    Member?: { Name?: string; Description?: string }[];
}

// Parse an XML string and merge it into a locale.
export function loadSignumTranslations(locale: string, xml: string): void {
    Metadata.merge(locale, parseSignumTranslations(xml));
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
// Metadata.merge; filename/alpha order sets precedence — name the app's file so it sorts last if a
// key must win). No-op if the directory does not exist. Call once at server startup.
export function loadAppTranslations(dir?: string): string | undefined {
    const resolved = resolveTranslationsDir(dir);
    if (!existsSync(resolved))
        return undefined;
    loadTranslationsFromDir(resolved);
    return resolved;
}
