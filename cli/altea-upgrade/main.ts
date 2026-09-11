#!/usr/bin/env node
import { Color, Console } from "./Console.js";
import { UpgradeContext } from "./UpgradeContext.js";
import { UpgradeRunner } from "./UpgradeRunner.js";

/**
 * `altea-upgrade` — apply the pending SOURCE upgrades to an altea application.
 *
 * Port of Signum.Upgrade's `Program`. Run it from anywhere inside the workspace: the root is found by
 * walking up for the directory holding both `pnpm-workspace.yaml` and `altea/`.
 *
 * Its two siblings are separate CLIs, because they answer different questions and a developer reaches for
 * them at different moments: `altea-clone` (start a new application from this one) and `altea-simplify`
 * (remove the optional modules it does not need). Both build on this package's toolkit.
 */

const args = new Set(process.argv.slice(2));

try {
    if (args.has("--help") || args.has("-h")) {
        usage();
    } else {
        Console.writeLine();
        Console.writeLine("  ..:: altea upgrade ::..");
        Console.writeLine();

        const uctx = UpgradeContext.createFromDirectory();
        Console.write("  root         "); Console.writeLineColor(Color.darkGray, uctx.rootFolder);
        Console.write("  application  "); Console.writeLineColor(Color.darkGray, uctx.applicationName);
        Console.writeLineColor(Color.darkGray,
            "\n  Applies the pending upgrades to this application's source. Review every change.");

        await (await UpgradeRunner.discover()).run(uctx);
    }
    process.exit(0);
} catch (e) {
    Console.writeLine();
    Console.writeLineColor(Color.red, `[FAILED] ${(e as Error).message}`);
    if (process.env["ALTEA_UPGRADE_STACK"] === "1")
        Console.writeLineColor(Color.darkGray, (e as Error).stack ?? "");
    process.exit(1);
}

function usage(): void {
    Console.writeLine(`
  altea-upgrade

  Runs this application's pending source upgrades, one at a time: each runs from a CLEAN git tree, you
  review the diff, and it is committed under the upgrade's name. Which have run is recorded in
  AlteaUpgrade.txt at the repository root — commit it.

  See also:  altea-clone     start a new application from this one
             altea-simplify  remove the optional modules this application does not need

  Environment:
    ALTEA_UPGRADE_STACK=1  print a stack trace on failure
`);
}
