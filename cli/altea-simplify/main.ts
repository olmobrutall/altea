#!/usr/bin/env node
import { Color, SafeConsole } from "@altea/altea/server/safeConsole";
import { UpgradeContext } from "@altea/altea-upgrade/UpgradeContext";
import { parseArguments } from "@altea/altea-upgrade/Arguments";
import { Simplify } from "./Simplify.js";

/**
 * `altea-simplify` — remove the optional modules an application does not need, following its `Modules.xml`.
 *
 * Signum has no counterpart in its repository: its `Modules.xml` is read by the wizard that stamps out a
 * new Southwind, and that wizard lives elsewhere. This is that executor.
 */

const args = parseArguments(process.argv.slice(2));

try {
    if (args.flags.has("help") || args.flags.has("h")) {
        usage();
    } else {
        SafeConsole.writeLine();
        SafeConsole.writeLine("  ..:: altea simplify ::..");
        SafeConsole.writeLine();

        const uctx = UpgradeContext.createFromDirectory();
        SafeConsole.write("  root         "); SafeConsole.writeLineColor(Color.darkGray, uctx.rootFolder);
        SafeConsole.write("  application  "); SafeConsole.writeLineColor(Color.darkGray, uctx.applicationName);

        await Simplify.run(uctx, {
            keep: args.values.has("keep") ? splitList(args.values.get("keep")!) : undefined,
            remove: args.values.has("remove") ? splitList(args.values.get("remove")!) : undefined,
            dryRun: args.flags.has("dry-run"),
            singleCommit: args.flags.has("single-commit"),
            yes: args.flags.has("yes") || args.flags.has("y"),
        });
    }
    process.exit(0);
} catch (e) {
    SafeConsole.writeLine();
    SafeConsole.writeLineColor(Color.red, `[FAILED] ${(e as Error).message}`);
    if (process.env["ALTEA_UPGRADE_STACK"] === "1")
        SafeConsole.writeLineColor(Color.darkGray, (e as Error).stack ?? "");
    process.exit(1);
}

function usage(): void {
    SafeConsole.writeLine(`
  altea-simplify [options]

  Lists the application's modules with everything ticked except the ones marked optional="true"; UNTICK a
  module to remove it. Removing one removes everything that depends on it. Each removal is applied and
  committed on its own, from a clean git tree.

  Options:
    --keep a,b,c        keep exactly these modules and remove the rest (skips the selector)
    --remove x,y        remove these, on top of the ones marked optional (skips the selector)
    --dry-run           print what would happen and change nothing
    --single-commit     one commit for the whole selection instead of one per module
    --yes, -y           skip the confirmation (for a scripted run)

  Environment:
    ALTEA_UPGRADE_STACK=1  print a stack trace on failure
`);
}

function splitList(value: string): string[] {
    return value.split(",").map(v => v.trim()).filter(v => v !== "");
}
