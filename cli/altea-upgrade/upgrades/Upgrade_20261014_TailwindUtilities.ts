import { Color, Console } from "@altea/altea-cli-utils";
import { WarningLevel } from "../CodeFile.js";
import type { UpgradeContext } from "../UpgradeContext.js";
import { UpgradeBase } from "../UpgradeRunner.js";
import { ClassMap } from "../tailwind/ClassMap.js";
import { sweepSource, type SweepReport } from "../tailwind/ClassSweep.js";
import { CLASS_MAP_PATH } from "../tailwind/sweep.js";

/**
 * Phase 0 of the Bootstrap → Tailwind migration (altea/Tailwind-Plan.md): wires Tailwind in beside
 * Bootstrap and rewrites every Bootstrap UTILITY class to its Tailwind translation. Component classes
 * (`btn`, `form-control`, the grid) are reported, not touched — later upgrades own them.
 */
export default class Upgrade_20261014_TailwindUtilities extends UpgradeBase {
    get description(): string { return "Tailwind beside Bootstrap; Bootstrap utility classes → Tailwind"; }

    execute(uctx: UpgradeContext): void {
        uctx.changeCodeFile("eastwind/package.json", file => {
            file.addNpmPackage("@tailwindcss/vite", "^4.3.3", true);
        }, WarningLevel.Warning);

        uctx.changeCodeFile("eastwind/vite.client.config.ts", file => {
            file.insertAfterFirstLine(l => l.includes(`from "@vitejs/plugin-react"`),
                `import tailwindcss from "@tailwindcss/vite";\nimport { alteaLegacyCssLayer, alteaUiDeps } from "@altea/altea/vite.mjs";`);
            file.replace(/plugins: \[/, "plugins: [alteaLegacyCssLayer(), alteaUiDeps(), tailwindcss(), ");
        });

        uctx.createCodeFile("eastwind/app/tailwind.css",
            `/* The app's one Tailwind entry: altea's theme plus this application's own sources. */\n` +
            `@import "@altea/altea/client/ui/theme.css";\n\n@source "./";\n`, WarningLevel.Warning);

        for (const entry of ["eastwind/app/main.client.ts", "eastwind/app/publicApi/publicCatalogEntry.client.tsx"]) {
            uctx.changeCodeFile(entry, file => {
                const bootstrap = (l: string): boolean => l.includes(`import "bootstrap/dist/css/bootstrap.min.css"`);
                file.insertBeforeFirstLine(bootstrap, `import "@altea/altea/client/ui/fontAwesome";`);
                file.insertAfterFirstLine(l => /^import ".*site\.css";/.test(l), `import "${entry.includes("publicApi") ? ".." : "."}/tailwind.css";`);
            }, WarningLevel.Warning);
        }

        uctx.changeCodeFile("eastwind/index.html", file => {
            file.replace(`document.documentElement.dataset.bsTheme = dark ? "dark" : "light";`,
                `document.documentElement.dataset.theme = document.documentElement.dataset.bsTheme = dark ? "dark" : "light";`);
        }, WarningLevel.Warning);

        const map = ClassMap.load(CLASS_MAP_PATH);
        const reports: [string, SweepReport][] = [];
        let changed = 0;
        uctx.forEachCodeFile("*.ts,*.tsx", file => {
            const r = sweepSource(file.filePath, file.content, map, { apply: ["U", "X"], skipSections: ["Layout and grid"] });
            file.content = r.content;
            changed += r.changed;
            reports.push(...r.reports.filter(x => x.reason === "dynamic" || x.reason === "outside-class-context").map(x => [file.filePath, x] as [string, SweepReport]));
        }, { directory: "eastwind/app", directoryWarning: WarningLevel.Warning });

        Console.writeLineColor(Color.green, `  ${changed} Bootstrap utility classes rewritten`);
        if (reports.length) {
            Console.writeLineColor(Color.yellow, `  ${reports.length} places to check by hand (built class names, or class strings outside a class context):`);
            for (const [f, r] of reports)
                Console.writeLineColor(Color.yellow, `    ${f}:${r.line}  ${r.text}`);
        }
    }
}
