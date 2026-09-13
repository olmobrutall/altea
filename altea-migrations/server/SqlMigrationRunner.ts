import "@altea/altea/server"; // installs save()/toLite()
import * as fs from "node:fs";
import * as path from "node:path";
import { Connector } from "@altea/altea/server/connection/connector";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { Schema } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Replacements } from "@altea/altea/server/sync/synchronizer";
import { SqlPreCommand, ExecuteSqlScriptException } from "@altea/altea/server/sync/sqlPreCommand";
import { existsTable } from "@altea/altea/server/sync/syncTableRead";
import { SqlMigrationEntity, MigrationMessage } from "../data/Migrations";
import { MigrationLogic } from "./MigrationLogic";
import { SafeConsole, Color } from "./SafeConsole";

// Versioned .sql files on disk as the source of truth for the schema. Each file is
// `yyyy.MM.dd-HH.mm.ss_Comment.sql`; applying one records a SqlMigrationEntity row, so the folder and the
// table together say what is pending. The interactive loop can also CREATE the next migration from the
// synchronization script, and squash the history into a fresh initial migration.
//
// A script is written as ONE file, and the `NT_` comment prefix is honoured on the way IN: a file whose
// comment starts with it runs OUTSIDE a transaction, which is how a hand-written CREATE INDEX CONCURRENTLY
// / ALTER TYPE migration is applied.
//
// A failure is REPORTED here and rethrown as an `ExecuteSqlScriptException` — the marker that says "already
// printed", without which the terminal's top-level handler prints it a second time.
//
// Every prompt is async (node readline), so the whole loop is.
//
// Port of Signum.Migrations' SqlMigrationRunner.cs — see port/Migrations.md.

export interface SqlMigrationInfo {
    /** null for a row that is in the DATABASE but has no file. */
    fileName: string | null;
    version: string;
    comment: string;
    isExecuted: boolean;
}

const VERSION_REGEX = /^(?<version>\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2})(_(?<comment>.+))?\.sql$/;

export namespace SqlMigrationRunner {

    /**
     * Settable by the app's terminal before the first call — and every app does set it, because a default
     * relative to the CWD cannot survive being launched from anywhere else (eastwind resolves its own off
     * `import.meta.url`). Lower-case `migrations`, like every other directory in an altea package; Signum's
     * `Migrations` was title-case because a C# project directory is.
     */
    export let migrationsDirectory = path.join("..", "..", "..", "migrations");

    export const databaseNameReplacement = "#DatabaseName#";
    export const initialMigrationComment = "Initial Migration";

    /** The schema is fully synced — nothing pending. */
    export const afterMigrationsCompleted: ((autoRun: boolean) => Promise<void> | void)[] = [];

    /** A new .sql file was just written. */
    export const afterCreatingMigration: ((fileName: string, replacements: Replacements) => Promise<void> | void)[] = [];

    type PromptResult = "Continue" | "Skip" | "Completed";

    /** The interactive loop, or one pass when `autoRun`. */
    export async function sqlMigrations(autoRun = false): Promise<void> {
        for (; ;) {
            const list = readMigrationsDirectory();

            if (!autoRun && list.length === 0) {
                // No migrations yet: either the database is empty (write the initial migration from the
                // generation script) or it already has tables (squash the current schema into one).
                if (!await hasTables()) {
                    if (!await SafeConsole.ask("Create initial migration?"))
                        return;
                    await createInitialMigration();
                } else {
                    if (!await SafeConsole.ask("There are no migrations yet, do you want to squash the current schema in an initial migration?"))
                        return;
                    await squashMigrationHistory();
                }
                continue;
            }

            await setExecuted(list);

            const outcome = await prompt(list, autoRun);
            if (outcome === "Skip")
                return;
            if (outcome === "Completed") {
                for (const handler of afterMigrationsCompleted)
                    await handler(autoRun);
                return;
            }
            if (autoRun)
                return;
        }
    }

    /** The whole schema as one migration file. */
    export async function createInitialMigration(): Promise<{ version: string; comment: string }[]> {
        const script = Schema.current.generationScript();
        if (script == null)
            return [];
        return saveMigrations(script, initialMigrationComment);
    }

    /**
     * Write `script` as `<version>_<comment>.sql`.
     *
     * Always ONE file: altea's SqlPreCommand carries no no-transaction marker to split around (see the
     * header).
     */
    export function saveMigrations(script: SqlPreCommand, comment: string): { version: string; comment: string }[] {
        const version = versionStamp(new Date());
        const finalComment = removeInvalidChars(comment);
        const fileName = `${version}${finalComment === "" ? "" : "_" + finalComment}.sql`;

        fs.mkdirSync(migrationsDirectory, { recursive: true });
        fs.writeFileSync(path.join(migrationsDirectory, fileName), script.plainSql(), "utf8");

        return [{ version, comment: finalComment }];
    }

    /** The .sql files, parsed and ordered by version. */
    export function readMigrationsDirectory(silent = false): SqlMigrationInfo[] {
        if (!fs.existsSync(migrationsDirectory)) {
            if (silent)
                return [];
            fs.mkdirSync(migrationsDirectory, { recursive: true });
            SafeConsole.writeLineColor(Color.white, MigrationMessage.Directory0AutoGenerated.niceToString(migrationsDirectory));
            return [];
        }

        if (!silent) {
            SafeConsole.writeLine();
            SafeConsole.writeLineColor(Color.darkGray, MigrationMessage.ReadingMigrationsFrom0.niceToString(migrationsDirectory));
        }

        const files = fs.readdirSync(migrationsDirectory).filter(f => f.toLowerCase().endsWith(".sql"));
        const matches = files.map(f => ({ fileName: f, match: VERSION_REGEX.exec(f) }));

        const errors = matches.filter(m => m.match == null);
        if (errors.length > 0)
            throw new Error("Some scripts in the migrations directory have an invalid format "
                + "(yyyy.MM.dd-HH.mm.ss_OptionalComment.sql)\n" + errors.map(e => e.fileName).join("\n"));

        return matches
            .map(m => ({
                fileName: path.join(migrationsDirectory, m.fileName),
                version: m.match!.groups!["version"]!,
                comment: m.match!.groups!["comment"] ?? "",
                isExecuted: false,
            }))
            .sort((a, b) => a.version.localeCompare(b.version));
    }

    /** Join the folder against the SqlMigration table. */
    async function setExecuted(migrations: SqlMigrationInfo[]): Promise<void> {
        if (!await hasTables())
            return;

        await MigrationLogic.ensureMigrationTable(SqlMigrationEntity);

        const rows = (await ExecutionMode.global(() => table(SqlMigrationEntity).toArray()) as SqlMigrationEntity[])
            .sort((a, b) => a.versionNumber.localeCompare(b.versionNumber));

        const first = migrations[0];
        const byVersion = new Map(migrations.map(m => [m.version, m]));

        for (const row of rows) {
            // Rows OLDER than the first file on disk are ignored (a squashed history).
            if (first != undefined && first.version.localeCompare(row.versionNumber) > 0)
                continue;

            const m = byVersion.get(row.versionNumber);
            if (m != undefined) {
                m.isExecuted = true;
            } else {
                migrations.push({
                    fileName: null,
                    comment: ">> In Database Only << " + (row.comment ?? ""),
                    version: row.versionNumber,
                    isExecuted: true,
                });
            }
        }

        migrations.sort((a, b) => a.version.localeCompare(b.version));
    }

    /** The state machine of the interactive loop. */
    async function prompt(migrations: SqlMigrationInfo[], autoRun: boolean): Promise<PromptResult> {
        draw(migrations, undefined);

        if (migrations.some(m => m.isExecuted && m.fileName == null)) {
            const str = MigrationMessage.ThereAreFreshExecutedMigrationsThatAreNotInTheFolderGetLatestVersion.niceToString();
            if (autoRun)
                throw new Error(str);
            SafeConsole.writeLineColor(Color.red, str);
            return "Skip";
        }

        // A pending migration OLDER than an executed one is a merge conflict (two branches added migrations).
        const afterFirstPending = migrations.slice(migrations.findIndex(m => !m.isExecuted) + 1);
        if (migrations.some(m => !m.isExecuted) && afterFirstPending.some(m => m.isExecuted)) {
            const str = MigrationMessage.PossibleMergeConflictThereAreOldMigrationsInTheFolderThatHaveNotBeenExecuted.niceToString();
            if (autoRun)
                throw new Error(str);
            SafeConsole.writeLineColor(Color.red, str);
            SafeConsole.writeLine();
            SafeConsole.writeLine(`Write '${Color.white("force")}' to execute them anyway`);
            if (await SafeConsole.askString("") !== "force")
                return "Skip";
        }

        const pending = migrations.filter(m => !m.isExecuted);

        if (pending.length === 0) {
            if (autoRun)
                return "Completed";

            if (!await SafeConsole.ask(MigrationMessage.CreateNewMigration.niceToString()))
                return "Completed";

            const replacements = new Replacements();
            replacements.interactive = SafeConsole.isInteractive();
            const script = await Schema.current.synchronizationScript(replacements);

            if (script == null) {
                SafeConsole.writeLineColor(Color.green, MigrationMessage.NoChangesFound.niceToString());
                return "Completed";
            }

            SafeConsole.writeLineColor(Color.yellow, MigrationMessage.SomeChangesFoundHereIsTheScript.niceToString());
            SafeConsole.writeLine();
            SafeConsole.writeLineColor(Color.darkGray, indent(script.plainSql(), 4));
            SafeConsole.writeLine();

            const comment = await SafeConsole.askString(MigrationMessage.CommentForTheNewMigration.niceToString() + " ");
            const [saved] = saveMigrations(script, comment);
            const fullFileName = path.join(migrationsDirectory, `${saved.version}${saved.comment === "" ? "" : "_" + saved.comment}.sql`);

            for (const handler of afterCreatingMigration)
                await handler(fullFileName, replacements);

            return "Continue";
        }

        if (!autoRun && !await SafeConsole.ask(MigrationMessage.Run0Migrations.niceToString(pending.length)))
            return "Skip";

        const start = Date.now();
        try {
            for (const mi of pending) {
                draw(migrations, mi);
                await execute(mi);
            }
        } catch (e) {
            // `execute` has already printed it. Interactively, loop back to the list so the fixed script
            // can be retried; a deploy has nobody to ask, so it fails the process.
            if (autoRun || !(e instanceof ExecuteSqlScriptException))
                throw e;

            return "Continue";
        }
        await resetCache();
        SafeConsole.writeLine(`Elapsed time: ${Math.round((Date.now() - start) / 1000)}s`);

        return autoRun ? "Completed" : "Continue";
    }

    /** Run one file, then record it. `NT_` runs outside a transaction (see the header). */
    async function execute(mi: SqlMigrationInfo): Promise<void> {
        const title = mi.version + (mi.comment === "" ? "" : ` (${mi.comment})`);
        const text = fs.readFileSync(mi.fileName!, "utf8");
        // A `#DatabaseName#` token cannot be substituted: there are no database-qualified names here and
        // the Connector exposes no database name, so a script carrying it cannot be executed faithfully —
        // say so rather than run something that means a different thing.
        if (text.includes(databaseNameReplacement))
            throw new Error(`Migration '${mi.version}' contains ${databaseNameReplacement}, which altea does not `
                + "support (there are no database-qualified names to rewrite). Edit the script to use plain names.");
        const script = text;

        const run = async (): Promise<void> => {
            SafeConsole.writeLineColor(Color.darkGray, `Executing ${title} ...`);
            try {
                await Connector.current().executeNonQuery(script);
            } catch (e) {
                // The file text is executed directly, so the failing-statement report is here.
                SafeConsole.writeLine();
                SafeConsole.writeLineColor(Color.darkRed, `${(e as Error)?.name ?? "Error"}: `);
                SafeConsole.writeLineColor(Color.red, (e as Error)?.message ?? String(e));
                SafeConsole.writeLineColor(Color.darkRed, (e as Error)?.stack ?? "");
                SafeConsole.writeLine();
                throw new ExecuteSqlScriptException((e as Error)?.message ?? String(e), { cause: e });
            }

            await MigrationLogic.ensureMigrationTable(SqlMigrationEntity);
            await SqlMigrationEntity.create({ versionNumber: mi.version, comment: mi.comment }).save();
            mi.isExecuted = true;
        };

        if (mi.comment.startsWith("NT_"))
            await run(); // no transaction: the statements manage their own (CREATE INDEX CONCURRENTLY, …)
        else
            await Transaction.forceNew(run);
    }

    /** After DDL, re-read the metadata caches (types, symbols, global lazies). */
    async function resetCache(): Promise<void> {
        await Schema.current.initialize();
    }

    /** Verify the DB matches the model, drop the history, write one initial. */
    export async function squashMigrationHistory(): Promise<void> {
        SafeConsole.writeLine();
        SafeConsole.writeLine("Squash Migration History resets all the SQL Migration history into one Initial Migration");
        SafeConsole.writeLine("This operation doesn't change your database schema, but deletes your migration history (if any).");
        SafeConsole.writeLine();

        // A single pass whose remaining script (if any) is shown: `synchronizationScript` is already
        // complete, so there is nothing to loop for.
        const replacements = new Replacements();
        replacements.interactive = SafeConsole.isInteractive();
        const pendingSync = await Schema.current.synchronizationScript(replacements);
        if (pendingSync != null) {
            SafeConsole.writeLineColor(Color.yellow, "The database is NOT synchronized with the model; sync it first:");
            SafeConsole.writeLineColor(Color.darkGray, indent(pendingSync.plainSql(), 4));
            return;
        }
        SafeConsole.writeLineColor(Color.green, "Perfectly Synchronized!");

        const files = fs.existsSync(migrationsDirectory)
            ? fs.readdirSync(migrationsDirectory).map(f => path.join(migrationsDirectory, f))
            : [];
        SafeConsole.writeLineColor(files.length === 0 ? Color.green : Color.yellow,
            `${files.length} files found in the migration directory (${migrationsDirectory})`);

        await MigrationLogic.ensureMigrationTable(SqlMigrationEntity);
        const executed = await ExecutionMode.global(() => table(SqlMigrationEntity).toArray()) as SqlMigrationEntity[];
        SafeConsole.writeLineColor(executed.length === 0 ? Color.green : Color.yellow,
            `${executed.length} executed migrations in the database`);

        if (files.length > 0 || executed.length > 0) {
            SafeConsole.writeLine();
            if (await SafeConsole.askOptions("Confirm that you want to remove all the migrations by writing 'squash'", "squash") !== "squash")
                return;

            for (const f of files) {
                fs.unlinkSync(f);
                SafeConsole.writeLineColor(Color.red, "File deleted: " + f);
            }
            for (const row of executed)
                await row.delete();
        }

        SafeConsole.writeLine("Generating Initial Migration file...");
        const versions = await createInitialMigration();
        for (const v of versions)
            await SqlMigrationEntity.create({ versionNumber: v.version, comment: v.comment }).save();

        SafeConsole.writeLineColor(Color.green, "Initial Migration saved and marked as executed");
    }

    /** The folder/database join, colour-coded. */
    function draw(migrationsInOrder: SqlMigrationInfo[], current: SqlMigrationInfo | undefined): void {
        SafeConsole.writeLine();
        for (const mi of migrationsInOrder) {
            const color = mi === current ? Color.green
                : mi.fileName != null && mi.isExecuted ? Color.darkGreen
                    : mi.fileName == null && mi.isExecuted ? Color.red
                        : Color.white;
            const prefix = mi.isExecuted ? "- " : mi === current ? "->" : "  ";
            SafeConsole.writeLineColor(color, `${prefix}${mi.version} ${mi.comment}`);
        }
        SafeConsole.writeLine();
    }

    /** Is this database non-empty? */
    async function hasTables(): Promise<boolean> {
        const schema = Connector.current().schema;
        for (const t of schema.tables.values()) {
            if (await ExecutionMode.global(() => existsTable(t.name)))
                return true;
        }
        return false;
    }
}

// ---- small helpers -------------------------------------------------------------------------------------

/** The migration's version stamp. */
function versionStamp(now: Date): string {
    const p = (n: number, len = 2): string => String(n).padStart(len, "0");
    return `${now.getFullYear()}.${p(now.getMonth() + 1)}.${p(now.getDate())}`
        + `-${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}`;
}

/** Strip what a file name cannot hold. */
function removeInvalidChars(comment: string): string {
    return comment.replace(/[\\/:*?"<>|]/g, "").trim();
}

function indent(text: string, spaces: number): string {
    const pad = " ".repeat(spaces);
    return text.split("\n").map(l => pad + l).join("\n");
}
