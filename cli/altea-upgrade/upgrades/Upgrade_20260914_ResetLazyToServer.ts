import { UpgradeBase } from "../UpgradeRunner.js";
import type { UpgradeContext } from "../UpgradeContext.js";

/**
 * `ResetLazy` moved from the `data` layer to `server`, where every one of its callers already was — and
 * where it can now name a `RuntimeType`, which is what a cache declares to be readable from inside a query
 * through `.$v` (see altea/server/stablePromise.ts).
 *
 * Only the import specifier changes; the class is the same.
 */
export default class Upgrade_20260914_ResetLazyToServer extends UpgradeBase {
    get description(): string { return "@altea/altea/data/resetLazy → @altea/altea/server/resetLazy"; }

    execute(uctx: UpgradeContext): void {
        uctx.forEachCodeFile("*.ts,*.tsx", file => {
            file.replace(`@altea/altea/data/resetLazy`, `@altea/altea/server/resetLazy`);
        });
    }
}
