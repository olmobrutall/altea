import "@altea/altea/server"; // installs Entity.save()/delete()
import { type FluentOperations } from "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { Schema } from "@altea/altea/server/schema";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { Connector } from "@altea/altea/server/connection/connector";
import { Replacements } from "@altea/altea/server/sync/synchronizer";
import type { AutoReplacementContext, Selection } from "@altea/altea/server/sync/synchronizer";
import { StringDistance } from "@altea/altea/server/sync/stringDistance";
import { table } from "@altea/altea/server/table";
import { Temporal } from "@altea/altea/data/basics";
import { UserHolder } from "@altea/altea/server/userHolder";
import { Clock } from "@altea/altea/data/utils/clock";
import { UserEntity } from "@altea/altea-auth/data/User";
import type { Lite } from "@altea/altea/data/lite";
import {
    DynamicRenameEntity, DynamicSqlMigrationEntity, DynamicSqlMigrationMessage, DynamicSqlMigrationOperation,
} from "../data/DynamicSqlMigration";

// Port of Signum.Dynamic's SqlMigrations/DynamicSqlMigrationLogic.cs — generate the pending schema-diff
// script from the admin UI, review it, execute it, and keep a record of who ran it and when.
//
// altea divergences, documented inline:
//  - `DynamicRenameEntity` IS ported, and `generateScript` answers the synchronizer's rename questions
//    from the unapplied rows exactly as Signum's `Create` does. In Signum those rows are written by the
//    dynamic-TYPE editor (Roslyn, unported), so this port has no automatic writer — they are recorded by
//    hand or through `addDynamicRename`. That is worth having on its own: a rename recorded ONCE is then
//    answered by every later synchronization of that database, from the panel or from the terminal, instead
//    of being re-asked and eventually mis-answered as drop + add.
//    THREE of Signum's five strategies port. Tables, Columns and Enums are keyed by buckets altea has
//    (`Replacements.keyTables` / `keyColumnsForTable` / `keyEnumsForTable`). Its Properties and Operations
//    strategies are keyed by `PropertyRouteLogic.PropertiesFor` and `DynamicTypeLogic.TypeNameKey` — the
//    first needs a PropertyRouteEntity table altea does not have, the second a constant of the unported
//    compiled half — so a rename under those buckets falls through to the no-rename default.
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

        // A rename row has no operations in Signum either — it is written by code and read by the
        // synchronizer.
        //
        // Signum also registers an `IsApplied` EXPRESSION so the panel can show it as a column. That is a
        // correlated EXISTS against ANOTHER TABLE inside a quoted body, and altea has no established way to
        // write one (every `withQuoted` member in the workspace returns an IQuery, or tests a COLLECTION
        // member with `.some`). `unappliedRenames` below answers the same question with one extra read
        // instead of inventing a lowering that might silently not translate.
        sb.include(DynamicRenameEntity)
            .withQuery();
    }

    /** Record a rename so later synchronizations answer it themselves. */
    export async function addDynamicRename(replacementKey: string, oldName: string, newName: string): Promise<void> {
        await DynamicRenameEntity.create({ replacementKey, oldName, newName }).save();
    }

    /**
     * The pending schema diff, or undefined when there is nothing to do. Signum's Create body, minus the
     * rename auto-replacements (see the header).
     */
    export async function generateScript(): Promise<string | undefined> {
        const lastRenames = await unappliedRenames();

        const replacements = new Replacements();
        replacements.interactive = false; // there is no console on the other end of an HTTP request
        replacements.autoReplacement = ctx => autoReplacement(ctx, lastRenames);

        const script = await Schema.current.synchronizationScript(replacements);
        if (script == null)
            return undefined;

        return "-- Generated from the Dynamic panel. Renames recorded as DynamicRename were applied;\n"
            + "-- every OTHER ambiguous rename was resolved as DROP + ADD, so a rename that must PRESERVE\n"
            + "-- data has to be recorded first (or run from an interactive `terminal sync`).\n\n"
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

    function registerDynamicSqlMigrationOperations(op: FluentOperations<DynamicSqlMigrationEntity>): void {
        op.withConstruct(DynamicSqlMigrationOperation.Create, {
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

/**
 * The recorded renames no later migration has consumed, oldest first, so a chain
 * (a -> b -> c) is replayed in the order it happened.
 *
 * Signum expresses "not applied" as `IsApplied`, an EXISTS per row; here it is the same question asked
 * once — a rename is spent when a migration was generated after it, so the newest migration's date is the
 * cutoff. One extra read, and it lowers to an ordinary indexed comparison.
 */
async function unappliedRenames(): Promise<DynamicRenameEntity[]> {
    const newestMigration = await table(DynamicSqlMigrationEntity)
        .orderByDescending(m => m.creationDate)
        .firstOrNull() as DynamicSqlMigrationEntity | null;

    const all = await table(DynamicRenameEntity)
        .orderBy(r => r.creationDate)
        .toArray() as DynamicRenameEntity[];

    if (newestMigration == null)
        return all;

    const cutoff = newestMigration.creationDate;
    return all.filter(r => Temporal.PlainDateTime.compare(r.creationDate, cutoff) > 0);
}

// ---- the rename strategies -----------------------------------------------------------------------------

/**
 * Answer ONE of the synchronizer's rename questions from the recorded renames, or null to leave it to the
 * caller's default. Dispatches on the bucket, exactly as Signum's `Create` does — see the header for the
 * two buckets that do not port.
 */
function autoReplacement(ctx: AutoReplacementContext, lastRenames: DynamicRenameEntity[]): Selection | null {
    const newName =
        ctx.replacementKey.startsWith(Replacements.keyEnumsForTable("")) ? nearestByDistance(ctx) :
            ctx.replacementKey.startsWith(Replacements.keyColumnsForTable("")) ? chainedBySegment(ctx, lastRenames, "_") :
                ctx.replacementKey === Replacements.keyTables ? chainedWhole(ctx, lastRenames, Replacements.keyTables) :
                    null;

    // A bucket with no strategy, or a chain that did not land on an offered name, falls through to the
    // no-rename default — drop + add, which is what the panel documents in the script header.
    return { oldValue: ctx.oldValue, newValue: newName };
}

/** An enum MEMBER is matched by nearest spelling. An enum row is seeded,
 *  so guessing wrong costs a re-seed, not data — which is why this one guesses at all. */
function nearestByDistance(ctx: AutoReplacementContext): string | null {
    const candidates = ctx.newValues ?? [];
    if (candidates.length === 0)
        return null;

    const sd = new StringDistance();
    return candidates.reduce((best, nv) =>
        sd.levenshteinDistance(nv, ctx.oldValue) < sd.levenshteinDistance(best, ctx.oldValue) ? nv : best);
}

/** Replay the chain over the WHOLE name (a table). */
function chainedWhole(ctx: AutoReplacementContext, lastRenames: DynamicRenameEntity[], replacementKey: string): string | null {
    let current = ctx.oldValue;
    for (const r of lastRenames)
        if (r.replacementKey === replacementKey && r.oldName === current)
            current = r.newName;

    return ctx.newValues?.includes(current) ? current : null;
}

/** A column name is COMPOSED (an embedded's members are
 *  `owner_member`), so the chain is replayed per SEGMENT — renaming `address` fixes `address_city` too. */
function chainedBySegment(ctx: AutoReplacementContext, lastRenames: DynamicRenameEntity[], separator: string): string | null {
    const table = ctx.replacementKey.slice(Replacements.keyColumnsForTable("").length);
    const keys = new Set([Replacements.keyColumnsForTable(table)]);
    const relevant = lastRenames.filter(r => keys.has(r.replacementKey));

    let segments = ctx.oldValue.split(separator);
    for (const r of relevant)
        if (segments.includes(r.oldName))
            segments = segments.map(seg => seg === r.oldName ? r.newName : seg);

    const current = segments.join(separator);
    return ctx.newValues?.includes(current) ? current : null;
}
