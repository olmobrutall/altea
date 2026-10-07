import "@altea/altea/server"; // installs Entity.save()/delete()
import { type FluentOperations } from "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { Schema } from "@altea/altea/server/schema";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { Connector } from "@altea/altea/server/connection/connector";
import { Replacements } from "@altea/altea/server/sync/synchronizer";
import { WebConsoleServer } from "@altea/altea/server/webConsole";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";
import { UserHolder } from "@altea/altea/server/userHolder";
import { Clock } from "@altea/altea/data/utils/clock";
import { StartParameters } from "@altea/altea/data/utils/startParameters";
import { EvalPanelPermission } from "@altea/altea-eval/data/EvalPanelPermission";
import { UserEntity } from "@altea/altea-auth/data/User";
import type { Lite } from "@altea/altea/data/lite";
import {
    DynamicSqlMigrationCommand, DynamicSqlMigrationEntity, DynamicSqlMigrationMessage, DynamicSqlMigrationOperation,
} from "../data/DynamicSqlMigration";

// Port of Signum.Dynamic's SqlMigrations/DynamicSqlMigrationLogic.cs — generate the pending schema-diff
// script from the admin UI, review it, execute it, and keep a record of who ran it and when.
//
// altea divergences:
//  - No DynamicRenameEntity. Signum records renames as the type editor saves and replays them, because
//    its panel cannot ASK; here the script is generated through the web console (core
//    server/webConsole.ts), so the synchronizer asks its rename questions in the browser exactly as it
//    does in `terminal sync`. `Create` then just receives the script.
//  - `Execute` runs the script inside ONE transaction and then re-initializes the schema caches, which is
//    what the terminal's `synchronize` does — Signum executes statement-by-statement through its own
//    `SqlPreCommand` runner and does not re-initialize.
export namespace DynamicSqlMigrationLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Signum registers all four operations as graph ops rather than through withSave / withDelete,
        // because its Delete carries a guard (a migration that has already run cannot be removed).
        sb.include(DynamicSqlMigrationEntity)
            .withOperations(registerDynamicSqlMigrationOperations)
            .withQuery();

        // Where Create gets its script: the synchronizer asking its rename questions in the browser.
        if (sb.webBuilder != null)
            WebConsoleServer.start(sb.webBuilder);
        WebConsoleServer.registerCommand({
            name: DynamicSqlMigrationCommand.Generate,
            isAllowed: () => PermissionLogic.isAuthorized(EvalPanelPermission.ViewDynamicPanel),
            run: () => generateScript(true),
        });
    }

    /**
     * The pending schema diff, or null when there is nothing to do. `interactive` asks the rename
     * questions on the current console (the browser, when run as a web console command); otherwise an
     * ambiguous rename is an error rather than a silent DROP + ADD.
     *
     * No transaction: the questions may wait for minutes, and the diff only reads.
     */
    export async function generateScript(interactive: boolean): Promise<string | null> {
        const replacements = new Replacements();
        replacements.interactive = interactive;

        const script = await Schema.current.synchronizationScript(replacements);
        return script?.plainSql() ?? null;
    }

    /**
     * Run a stored script as ONE transaction, then refresh the schema caches (the terminal's `sync` tail).
     *
     * The script goes to the connector as a single command rather than statement-by-statement: what is
     * stored is TEXT a person may have edited, so there is no SqlPreCommand tree left to walk. Signum splits
     * on `GO` batches here; altea's executeNonQuery has no batch splitting at all (see the note in
     * sync/schemaAssets), and both dialects accept a `;`-separated script in one command.
     */
    export async function executeScript(script: string): Promise<void> {
        await Transaction.create(async () => {
            await Connector.current().executeNonQuery(script);
        });

        // A migration may have inserted / renamed / removed types — re-read the type caches from the
        // committed state, exactly as the terminal does after applying a sync script. The mismatches
        // tolerated at startup are re-collected by it: whatever the script fixed is gone from the panel.
        StartParameters.ignoredDatabaseMismatches?.splice(0);
        await Schema.current.initialize();
    }

    function currentUserLite(): Lite<UserEntity> {
        const user = UserHolder.currentUserLite();
        if (user == null)
            throw new Error("DynamicSqlMigration requires a logged-in user");
        return user as Lite<UserEntity>;
    }

    function registerDynamicSqlMigrationOperations(op: FluentOperations<DynamicSqlMigrationEntity>): void {
        // The script comes from the web console command (args[0]); without one it is generated here,
        // where nobody can answer a rename question.
        op.withConstruct(DynamicSqlMigrationOperation.Create, {
            construct: async (args): Promise<DynamicSqlMigrationEntity> => {
                const script = typeof args[0] === "string" ? args[0] : await generateScript(false);

                return DynamicSqlMigrationEntity.create({
                    creationDate: Clock.now,
                    createdBy: currentUserLite(),
                    comment: "",
                    script: script ?? "",
                });
            },
        });

        op.withSave(DynamicSqlMigrationOperation.Save);

        op.withDelete(DynamicSqlMigrationOperation.Delete, {
            canDelete: m => m.executionDate == null
                ? null
                : DynamicSqlMigrationMessage.TheMigrationIsAlreadyExecuted.niceToString(),
            delete: async m => { await m.delete(); },
        });

        op.withExecute(DynamicSqlMigrationOperation.Execute, {
            canBeModified: true,
            canExecute: m => m.executionDate == null
                ? null
                : DynamicSqlMigrationMessage.TheMigrationIsAlreadyExecuted.niceToString(),
            execute: async m => {
                await executeScript(m.script);
                m.executionDate = Clock.now;
                m.executedBy = currentUserLite();
            },
        });
    }
}
