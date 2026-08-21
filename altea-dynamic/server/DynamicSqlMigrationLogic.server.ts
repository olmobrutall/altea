import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { Schema } from "@altea/altea/server/schema";
import { graph } from "@altea/altea/server/graphBuilder";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { Connector } from "@altea/altea/server/connection/connector";
import { Replacements } from "@altea/altea/server/sync/synchronizer";
import { UserHolder } from "@altea/altea/server/userHolder";
import { Clock } from "@altea/altea/data/utils/clock";
import { UserEntity } from "@altea/altea-auth/data/User";
import type { Lite } from "@altea/altea/data/lite";
import {
    DynamicSqlMigrationEntity, DynamicSqlMigrationMessage, DynamicSqlMigrationOperation,
} from "../data/DynamicSqlMigration";

// Port of Signum.Dynamic's SqlMigrations/DynamicSqlMigrationLogic.cs — generate the pending schema-diff
// script from the admin UI, review it, execute it, and keep a record of who ran it and when.
//
// altea divergences, documented inline:
//  - Signum's `Create` installs a `Replacements.GlobalAutoReplacement` built from unapplied
//    `DynamicRenameEntity` rows, which its dynamic-TYPE editor writes on every rename. That editor needs
//    Roslyn and does not port, so nothing would ever write a rename row: `DynamicRenameEntity` is not ported
//    and `Create` runs the synchronizer with the same NO-RENAME auto-replacement the terminal uses headless
//    (drop + add). A rename that must preserve data is a job for an interactive `terminal sync`, and the
//    generated script says so in a leading comment.
//  - `Execute` runs the script inside ONE transaction and then re-initializes the schema caches, which is
//    what the terminal's `synchronize` does — Signum executes statement-by-statement through its own
//    `SqlPreCommand` runner and does not re-initialize.
export namespace DynamicSqlMigrationLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(DynamicSqlMigrationEntity)
            .withSave(DynamicSqlMigrationOperation.Save)
            .withDelete(DynamicSqlMigrationOperation.Delete)
            .withQuery();

        graph(DynamicSqlMigrationEntity, g => {

            g.Construct(DynamicSqlMigrationOperation.Create, {
                construct: async (): Promise<DynamicSqlMigrationEntity> => {
                    const script = await generateScript();

                    return DynamicSqlMigrationEntity.create({
                        creationDate: Clock.now,
                        createdBy: currentUserLite(),
                        comment: "",
                        script: script ?? "",
                    });
                },
            });

            g.Execute(DynamicSqlMigrationOperation.Save, {
                canBeNew: true,
                canBeModified: true,
                execute: () => { /* nothing beyond the save itself (Signum's plain Save) */ },
            });

            g.Execute(DynamicSqlMigrationOperation.Execute, {
                canBeModified: true,
                // Signum's `CanExecute = a => a.ExecutionDate == null ? null : …AlreadyExecuted`.
                canExecute: m => m.executionDate == null
                    ? null
                    : DynamicSqlMigrationMessage.TheMigrationIsAlreadyExecuted.niceToString(),
                execute: async m => {
                    await executeScript(m.script);
                    m.executionDate = Clock.now;
                    m.executedBy = currentUserLite();
                },
            });
        });
    }

    /**
     * The pending schema diff, or undefined when there is nothing to do. Signum's Create body, minus the
     * rename auto-replacements (see the header).
     */
    export async function generateScript(): Promise<string | undefined> {
        const replacements = new Replacements();
        replacements.interactive = false; // there is no console on the other end of an HTTP request
        replacements.autoReplacement = ({ oldValue }) => ({ oldValue, newValue: null });

        const script = await Schema.current.synchronizationScript(replacements);
        if (script == null)
            return undefined;

        return "-- Generated from the Dynamic panel. Every ambiguous rename was resolved as DROP + ADD:\n"
            + "-- a rename that must PRESERVE data has to be run from an interactive `terminal sync`.\n\n"
            + script.plainSql();
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
        // committed state, exactly as the terminal does after applying a sync script.
        await Schema.current.initialize();
    }

    function currentUserLite(): Lite<UserEntity> {
        const user = UserHolder.currentUserLite();
        if (user == null)
            throw new Error("DynamicSqlMigration requires a logged-in user");
        return user as Lite<UserEntity>;
    }
}
