import { Color, Console } from "@altea/altea-cli-utils";
import { WarningLevel } from "../CodeFile.js";
import type { UpgradeContext } from "../UpgradeContext.js";
import { UpgradeBase } from "../UpgradeRunner.js";
import { ClassMap } from "../tailwind/ClassMap.js";
import { sweepSource } from "../tailwind/ClassSweep.js";
import { CLASS_MAP_PATH, sweepCss } from "../tailwind/sweep.js";

/**
 * Bootstrap's form classes → altea's semantic ones (`form-control` → `sf-form-control`, `input-group` →
 * `sf-input-group`, …), in the views and in the stylesheets that select them, and the stylesheet that
 * styles them. altea/Tailwind-ClassMap.md, section *Forms*.
 */
export default class Upgrade_20261015_TailwindFormClasses extends UpgradeBase {
    get description(): string { return "Bootstrap form classes → altea semantic sf-* form classes"; }

    execute(uctx: UpgradeContext): void {
        for (const entry of ["eastwind/app/main.client.ts", "eastwind/app/publicApi/publicCatalogEntry.client.tsx"]) {
            uctx.changeCodeFile(entry, file => {
                file.insertAfterFirstLine(l => l.includes(`import "bootstrap/dist/css/bootstrap.min.css"`),
                    `import "@altea/altea/client/ui/semantic.css";`);
            }, WarningLevel.Warning);
        }

        const map = ClassMap.load(CLASS_MAP_PATH);
        const options = { apply: ["S", "U", "X"] as ("S" | "U" | "X")[], onlySections: ["Forms"] };
        let changed = 0;
        uctx.forEachCodeFile("*.ts,*.tsx,*.css", file => {
            const r = file.filePath.endsWith(".css") ? sweepCss(file.content, map, options) : sweepSource(file.filePath, file.content, map, options);
            file.content = r.content;
            changed += r.changed;
        }, { directory: "eastwind/app", directoryWarning: WarningLevel.Warning });

        Console.writeLineColor(Color.green, `  ${changed} form classes renamed`);
    }
}
