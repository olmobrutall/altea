import type { SchemaBuilder } from "@altea/altea/server/schema";

// Side effect: REGISTERS `HtmlEditorMessage`, which is the whole reason this module exists (see below).
import "../data/HtmlEditor";

// The package's server entry. It creates no table and registers no permission — the HTML editor is a UI
// control, and Signum's Signum.HtmlEditor has no Start at all, only HtmlToPlainText.cs.
//
// It exists because of ONE altea divergence. A `msg()` container registers when its MODULE is imported, and
// the translation sync reads the LIVE registry — where Signum scans an assembly for `[Description]` enums
// whether or not anything loaded the type. So a container that only CLIENT code imports is invisible to the
// terminal, and `stub-translations` then rewrites the package's file without it, deleting its translations
// silently: the file just comes back shorter. Before this, @altea/altea-html-editor answered "not a package
// that declares anything localizable" and the 11 strings Signum ships German for had nowhere to land.
//
// The registration used to ride on a side-effect import inside `HtmlToPlainText.ts`. That worked only
// because @altea/altea-office-template's PlainExcelGenerator imports `htmlToText` and PlainExcelLogic is
// started — so the messages of a UI package were registered, in effect, by the excel exporter. An app that
// used the editor without ever exporting a spreadsheet lost them again, and nothing said so. Naming the
// dependency is the point: an application that offers the editor starts this, the way it starts every other
// module, and the registration no longer depends on which unrelated feature happens to be switched on.
export namespace HtmlEditorLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Nothing further today. The import above has already done the work, and `start` is what makes it a
        // decision the application states rather than a side effect of the import graph.
    }
}
