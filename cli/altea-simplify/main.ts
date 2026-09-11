#!/usr/bin/env node
import { ApplicationContext, Color, Console, parseArguments } from "@altea/altea-cli-utils";
import { Simplify } from "./Simplify.js";
import { Check } from "./Check.js";
import { ModulesXml } from "./ModulesXml.js";

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
        Console.writeLine();
        Console.writeLine("  ..:: altea simplify ::..");
        Console.writeLine();

        const uctx = ApplicationContext.createFromDirectory();
        Console.write("  root         "); Console.writeLineColor(Color.darkGray, uctx.rootFolder);
        Console.write("  application  "); Console.writeLineColor(Color.darkGray, uctx.applicationName);

        // --check validates the file against the sources and changes nothing. It lives here rather
        // than in a script of the application's, so the validator and the executor share one parser and
        // one set of rules — a checker that passed what the executor then mis-read would be worse than
        // no checker.
        if (args.flags.has("check")) {
            const filePath = ModulesXml.locate(uctx.rootFolder, uctx.applicationName);
            if (filePath == undefined)
                throw new Error(`No Modules.xml in ${uctx.applicationName}/.`);

            if (!Check.run(ModulesXml.read(filePath, uctx.rootFolder)))
                process.exit(1);

            process.exit(0);
        }

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
    Console.writeLine();
    Console.writeLineColor(Color.red, `[FAILED] ${(e as Error).message}`);
    if (process.env["ALTEA_UPGRADE_STACK"] === "1")
        Console.writeLineColor(Color.darkGray, (e as Error).stack ?? "");
    process.exit(1);
}

function usage(): void {
    Console.writeLine(`
  altea-simplify [options]

  Lists the application's modules with everything ticked except the ones marked optional="true"; UNTICK a
  module to remove it. Removing one removes everything that depends on it. Each removal is applied and
  committed on its own, from a clean git tree.

  Options:
    --check             validate Modules.xml against the sources and change nothing; exits non-zero on
                        a broken anchor, a missing path or an ambiguous From=
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
