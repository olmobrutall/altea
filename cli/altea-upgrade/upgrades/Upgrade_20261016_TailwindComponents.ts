import { Color, Console } from "@altea/altea-cli-utils";
import { WarningLevel } from "../CodeFile.js";
import type { UpgradeContext } from "../UpgradeContext.js";
import { UpgradeBase } from "../UpgradeRunner.js";
import { ClassMap } from "../tailwind/ClassMap.js";
import { sweepSource, type SweepOptions, type SweepReport } from "../tailwind/ClassSweep.js";
import { CLASS_MAP_PATH, sweepCss } from "../tailwind/sweep.js";

/**
 * Phase 5 of the Bootstrap → Tailwind migration (altea/Tailwind-Plan.md): Bootstrap goes.
 *
 *  - Bootstrap's component classes → altea's semantic ones (`btn btn-primary` → `sf-btn sf-btn-primary`, `card`,
 *    `alert`, `table`, `nav-link`, …; components.css styles them) and the grid (`row` → `sf-row`, `col-sm-6` →
 *    `sm:col-span-6`), in the views and in the stylesheets that select them.
 *  - Only the semantic and grid rows run: the utility rows ran in Upgrade_20261014_TailwindUtilities, and a
 *    second pass would read the Tailwind classes it wrote as Bootstrap ones (`mb-4` → `mb-6`).
 *  - No more bootstrap / react-bootstrap / react-widgets-up; `data-bs-theme` → `data-theme`.
 *
 * It REPORTS what needs a human: columns that only work in a flex row (`col`, `col-auto`), class names built at
 * runtime (`"btn-" + variant`), and Bootstrap variables left in the app's stylesheets.
 */
export default class Upgrade_20261016_TailwindComponents extends UpgradeBase {
    get description(): string { return "Bootstrap component classes → altea semantic sf-* classes; remove Bootstrap"; }

    execute(uctx: UpgradeContext): void {
        for (const entry of ["eastwind/app/main.client.ts", "eastwind/app/publicApi/publicCatalogEntry.client.tsx"]) {
            uctx.changeCodeFile(entry, file => {
                file.replace(/^import "bootstrap\/dist\/css\/bootstrap(\.min)?\.css";\r?\n/m, "");
                file.replace(/^import "react-widgets-up\/styles\.css";\r?\n/m, "");
            }, WarningLevel.Warning);
        }

        uctx.changeCodeFile("eastwind/index.html", file => {
            file.replace(/ = document\.documentElement\.dataset\.bsTheme = /g, " = ");
            file.replace(/data-bs-theme=/g, "data-theme=");
        }, WarningLevel.Warning);

        uctx.changeCodeFile("eastwind/package.json", file => {
            file.removeNpmPackage("bootstrap");
            file.removeNpmPackage("react-bootstrap");
            file.removeNpmPackage("react-widgets-up");
        }, WarningLevel.Warning);

        const map = ClassMap.load(CLASS_MAP_PATH);
        const passes: SweepOptions[] = [
            { apply: ["S", "X"] },
            { apply: ["U"], onlySections: ["Layout and grid"] },
        ];
        const reports: [string, SweepReport][] = [];
        let changed = 0;
        uctx.forEachCodeFile("*.ts,*.tsx,*.css", file => {
            for (const options of passes) {
                const r = file.filePath.endsWith(".css") ? sweepCss(file.content, map, options) : sweepSource(file.filePath, file.content, map, options);
                file.content = r.content;
                changed += r.changed;
                if (options.apply.includes("S"))
                    reports.push(...r.reports.filter(x => x.reason === "manual" || x.reason === "dynamic" || x.reason === "component")
                        .filter(x => !["active", "disabled", "show", "is-invalid"].includes(x.text))
                        .map(x => [file.filePath, x] as [string, SweepReport]));
            }
            if (file.filePath.endsWith(".css")) {
                file.content = file.content
                    .replace(/\[data-bs-theme=(dark|light)\]/g, "[data-theme=$1]")
                    .replace(/--bs-(btn|table|card|gutter)-/g, "--sf-$1-");
                for (const m of file.content.matchAll(/--bs-[a-z0-9-]+/g))
                    reports.push([file.filePath, { line: file.content.slice(0, m.index).split("\n").length, text: m[0], reason: "manual" }]);
            }
        }, { directory: "eastwind/app", directoryWarning: WarningLevel.Warning });

        Console.writeLineColor(Color.green, `  ${changed} Bootstrap component and grid classes rewritten`);
        if (reports.length) {
            Console.writeLineColor(Color.yellow, `  ${reports.length} places to check by hand (flex-only columns, built class names, Bootstrap variables):`);
            for (const [f, r] of reports)
                Console.writeLineColor(Color.yellow, `    ${f}:${r.line}  ${r.text}`);
        }
    }
}
