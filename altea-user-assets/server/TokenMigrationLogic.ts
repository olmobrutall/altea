import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import type { Replacements } from "@altea/altea/server/sync/synchronizer";
import { TokenMigrationEntity } from "../data/TokenMigration";
import { TokenMigrationFile } from "./TokenMigrationFile";
import type { TokenSyncContext } from "./TokenSyncContext";

// Port of Signum.UserAssets' TokenMigrations/TokenMigrationLogic.cs — see port/UserAssets.md.
//
// The registry and the file bookkeeping: the subscriber event, the file naming, the directory listing.
// The RUNNER that drives a session is TokenMigrationRunner.
//
// `migrationsDirectory` is a SETTABLE slot rather than a read of `SqlMigrationRunner.migrationsDirectory`,
// because this package must not depend on @altea/altea-migrations — a user-assets app need not have
// migrations at all. The app points both at one directory (see eastwind's Starter), which is what keeps a
// `.tokens.json` beside the `.sql` migration that caused it.

/** Whether a migration file carries token decisions or only query renames. */
export type MigrationKind = "Tokens" | "Query";

export interface MigrationInfo {
    /** null for a version that is in the DATABASE but has no file any more. */
    fileName: string | null;
    version: string;
    comment: string;
    kind: MigrationKind;
    isExecuted: boolean;
}

export namespace TokenMigrationLogic {
    /**
     * A subscriber walks ITS entities, consults the context to
     * resolve or record each stale token, and either captures decisions (Record, nothing saved) or
     * replays them (Apply, saved per entity).
     *
     * Fired exactly ONCE per session with every subscriber in turn, so one recorded file covers every
     * kind of asset.
     */
    export const tokenSynchronizing: { name: string; handler: (ctx: TokenSyncContext) => Promise<void> }[] = [];

    /** Register a subscriber. `name` is printed as the step runs, so a long session says where it is. */
    export function registerTokenSynchronizing(name: string, handler: (ctx: TokenSyncContext) => Promise<void>): void {
        tokenSynchronizing.push({ name, handler });
    }

    export const tokensFileExtension = ".tokens.json";
    export const queryFileExtension = ".query.json";

    /**
     * One regex for both file kinds; the `kind` group tells them apart. A `.tokens.json` normally carries
     * token/value/member/global renames and per-entity actions; a `.query.json` normally carries only the
     * `types` bucket (the query renames a schema sync resolved).
     */
    const migrationFileRegex =
        /(?<version>\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2})(_(?<comment>.+))?\.(?<kind>tokens|query)\.json/;

    /**
     * Where the `.tokens.json` / `.query.json` files live — the same directory as the SQL migrations, so
     * a token migration sits beside the schema change that caused it. The APP sets this (see the header
     * on why it is a slot).
     */
    export let migrationsDirectory: () => string = () => {
        throw new Error("TokenMigrationLogic.migrationsDirectory is not set. Point it at the app's "
            + "Migrations directory (the same one SqlMigrationRunner uses) before starting token migrations.");
    };

    let started = false;
    export function isStarted(): boolean { return started; }

    export function assertStarted(): void {
        if (!started)
            throw new Error("TokenMigrationLogic is not started. Call TokenMigrationLogic.start in your application startup.");
    }

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // The server registration takes
        // none (no QueryDescription), so those are CLIENT default columns.
        sb.include(TokenMigrationEntity).withQuery();

        started = true;
    }

    /**
     * Drain the QUERY renames a just-created SQL migration resolved
     * into a sibling `.query.json`.
     *
     * This is what makes a query rename survive: the schema sync knows `OldQuery` became `NewQuery`, and
     * that fact has to be on disk before the token pass can use it, because by then the old name is gone
     * from the schema entirely.
     */
    export function afterMigrationCreated(fullFileName: string, rep: Replacements): void {
        const file = new TokenMigrationFile();
        file.loadTypes(rep);

        if (file.isEmpty)
            return;

        // Beside the migration, which is where the file belongs and where readMigrationsDirectory looks.
        const withoutExtension = basename(fullFileName).replace(/\.sql$/i, "");
        const fullPath = join(dirname(fullFileName), withoutExtension + queryFileExtension);

        file.print();
        file.save(fullPath);
    }

    /** Every subscriber, in registration order, named as it runs. */
    export async function fireTokenSynchronizing(ctx: TokenSyncContext): Promise<void> {
        for (const { name, handler } of tokenSynchronizing) {
            SafeConsole.writeColor(Color.white, name);
            await handler(ctx);
            SafeConsole.writeLine();
        }
    }

    /**
     * Every migration file, both kinds, sorted by version.
     */
    export function readMigrationsDirectory(silent = false): MigrationInfo[] {
        const dir = migrationsDirectory();

        if (!existsSync(dir)) {
            if (!silent)
                SafeConsole.writeLineColor(Color.darkGray, "Migrations directory does not exist: " + dir);
            return [];
        }

        const infos: MigrationInfo[] = [];
        for (const name of readdirSync(dir)) {
            const match = migrationFileRegex.exec(name);
            if (match?.groups == null)
                continue;

            infos.push({
                fileName: join(dir, name),
                version: match.groups["version"]!,
                comment: match.groups["comment"] ?? "",
                kind: match.groups["kind"] === "tokens" ? "Tokens" : "Query",
                isExecuted: false,
            });
        }

        infos.sort((a, b) => a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
        return infos;
    }
}
