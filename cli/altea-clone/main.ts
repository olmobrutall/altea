#!/usr/bin/env node
import { Color, Console } from "../altea-upgrade/Console.js";
import { UpgradeContext } from "../altea-upgrade/UpgradeContext.js";
import { Clone } from "./Clone.js";
import { parseArguments } from "../altea-upgrade/Arguments.js";

/**
 * `altea-clone` — copy this altea application into a NEW project, renamed.
 *
 * Signum's `ApplicationRenamer` renames a checkout in place; this creates a new repository beside it, so
 * the source application survives and the new one starts with a clean history.
 */

const args = parseArguments(process.argv.slice(2));

try {
    if (args.flags.has("help") || args.flags.has("h")) {
        usage();
    } else {
        Console.writeLine();
        Console.writeLine("  ..:: altea clone ::..");
        Console.writeLine();

        const uctx = UpgradeContext.createFromDirectory();
        Console.write("  root         "); Console.writeLineColor(Color.darkGray, uctx.rootFolder);
        Console.write("  application  "); Console.writeLineColor(Color.darkGray, uctx.applicationName);

        await Clone.run(uctx, {
            name: args.values.get("name") ?? args.positional[0],
            directory: args.values.get("directory") ?? args.positional[1],
            dryRun: args.flags.has("dry-run"),
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
  altea-clone [--name <name>] [--directory <path>] [options]

  Copies this application into <directory>/<name>: a fresh git repository, the altea submodule pinned to
  the same commit this workspace has, and the application renamed in file names and in content. Asks for
  anything not given.

  Options:
    --name <name>       the new application's name (lower-case; a package AND a directory name)
    --directory <path>  where to create it; defaults to this workspace's parent
    --dry-run           print what would happen and create nothing
    --yes, -y           skip the confirmation (for a scripted run)

  Environment:
    ALTEA_UPGRADE_STACK=1  print a stack trace on failure
`);
}
