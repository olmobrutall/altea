import { UpgradeBase } from "../UpgradeRunner.js";
import type { UpgradeContext } from "../UpgradeContext.js";

/**
 * `CultureInfoLogic.warmUp()` is gone: every reader asks `CultureInfoLogic` for the cultures and it loads
 * them on demand, so nothing has to be warmed at startup. The starter's call is removed.
 *
 * If your own code read the cultures synchronously, those readers are now async
 * (`getCulture` / `tryGetCulture` / `applicationCultures`), or take the resolved `CultureLookup` that
 * `CultureInfoLogic.lookup()` hands back — for a loop that has to stay synchronous.
 */
export default class Upgrade_20260914_CultureInfoLogicWarmUpRemoved extends UpgradeBase {
    get description(): string { return "CultureInfoLogic.warmUp() is no longer needed"; }

    execute(uctx: UpgradeContext): void {
        uctx.forEachCodeFile("*.ts", file => {
            file.removeAllLines(l => l.includes("CultureInfoLogic.warmUp()"));
        });
    }
}
