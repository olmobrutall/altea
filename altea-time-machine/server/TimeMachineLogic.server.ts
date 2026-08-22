import "@altea/altea/server"; // installs save()/toLite()
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import * as Database from "@altea/altea/server/Database";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { SystemTime, SystemTimeJoinMode } from "@altea/altea/server/systemTime";
import { exploreModifiables, forwardReferences } from "@altea/altea/server/graphExplorer";
import { DirectedGraph } from "@altea/altea/server/directedGraph";
import { Entity, type Type, type PrimaryKey } from "@altea/altea/data/entity";
import { Temporal } from "@altea/altea/data/basics";
import { TimeMachinePermission } from "../data/TimeMachine";
import { TimeMachineServer } from "./TimeMachineServer.server";

// Port of Signum.TimeMachine's TimeMachineLogic.cs — the module starter plus the two RESTORE helpers
// (an application calls them from an operation; the module ships no button of its own, exactly as
// Signum does).
//
// altea divergences:
//  - **`Administrator.SaveDisableIdentity` has no counterpart, and needs none.** altea's insert path
//    already writes an explicit id into an identity PK with `OVERRIDING SYSTEM VALUE` / `SET
//    IDENTITY_INSERT` whenever an entity is `isNew` but already carries an `id` (server/save.ts,
//    `identityOverride`). So "re-insert this deleted row under its original id" is just `isNew = true`
//    with the id left alone.
//  - **the MList re-insertion block is GONE.** Signum has to reach past the entity model to put the
//    MList element ROWS back (`BulkInserter.BulkInsertMListTable(disableMListIdentity: true)`, its own
//    "not tested" comment attached), because an MList row is not an entity. altea has no MList: a
//    collection is `@part` child ENTITIES with their own ids, so they are ordinary members of the graph
//    and the same isNew/id restore covers them. The VirtualMList branch goes with it for the same
//    reason — altea's `@part` collections ARE Signum's virtual MLists.
export namespace TimeMachineLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Signum's `PermissionLogic.RegisterTypes(typeof(TimeMachinePermission))`: in altea a symbol is
        // seeded merely by being declared and imported, so referencing it here is the registration.
        void TimeMachinePermission.ShowTimeMachine;

        if (sb.webBuilder)
            TimeMachineServer.start(sb.webBuilder);
    }

    /**
     * Signum's `RestoreOlderVersion<T>`: read the row as it was at `lastVersion` and save it over the
     * CURRENT one, so the history gains a new version that happens to equal an old one (nothing is
     * rewritten — this is a restore, not a rollback).
     *
     * The current `ticks` are read first and stamped onto the retrieved instance: the retrieved copy
     * carries the concurrency stamp it had back THEN, which would make the update fail its optimistic
     * check.
     */
    export async function restoreOlderVersion<T extends Entity>(
        type: Type<T>, id: PrimaryKey, lastVersion: Temporal.PlainDateTime | Temporal.Instant): Promise<T> {

        return await Transaction.create(async () => {
            const entity = await SystemTime.override(new SystemTime.AsOf(lastVersion), () =>
                Database.retrieve(type, id));

            const ticks = await table(type).filter(a => a.id == id).map(a => a.ticks).single();

            entity.ticks = ticks;
            setSelfModified(entity);
            await entity.save();

            return entity;
        });
    }

    /**
     * Signum's `RestoreDeletedEntity<T>(id, out DateTime date)`: find the instant the row was deleted,
     * step just before it, and re-insert everything in its graph that no longer exists.
     *
     * Returns the restored entity together with the instant it was read at, which is what Signum hands
     * back through its `out` parameter.
     */
    export async function restoreDeletedEntity<T extends Entity>(
        type: Type<T>, id: PrimaryKey): Promise<{ entity: T; date: Temporal.PlainDateTime }> {

        // Signum writes `.Max(a => a.SystemPeriod().Max)`; altea's `max` selector is typed for scalar
        // values only (a Temporal is not one), so the same thing is expressed as an ORDER BY + first.
        const lastVersion = await SystemTime.override(new SystemTime.All(SystemTimeJoinMode.AllCompatible), () =>
            table(type)
                .filter(a => a.id == id)
                .orderByDescending(a => a.systemPeriod().max)
                .map(a => a.systemPeriod().max)
                .firstOrNull());

        if (lastVersion == null)
            throw new Error(`No deleted version of ${type.name} ${id} was found in the history table`);

        // Signum's `lastVersion.AddMicroseconds(-10)`: the deletion's period bound is EXCLUSIVE of the
        // version we want, so step back inside it.
        const date = toPlainDateTime(lastVersion).subtract({ microseconds: 10 });

        return { entity: await restoreDeletedEntityAsOf(type, id, date), date };
    }

    /** Signum's `RestoreDeletedEntity<T>(id, lastVersion)` — the explicit-instant overload. */
    export async function restoreDeletedEntityAsOf<T extends Entity>(
        type: Type<T>, id: PrimaryKey, lastVersion: Temporal.PlainDateTime | Temporal.Instant): Promise<T> {

        return await Transaction.create(async () => {
            const entity = await SystemTime.override(new SystemTime.AsOf(lastVersion), () =>
                Database.retrieve(type, id));

            await restoreEntityGraph(entity);

            return entity;
        });
    }

    // Signum's private `RestoreEntity`: walk the graph in save (dependency) order and re-insert every
    // entity that is no longer in the database, keeping its original id.
    //
    // The graph is built here rather than through `saveDependencyGraph`, which only edges targets that
    // are `isNew` — every entity read back from history is a CLEAN, id-carrying instance, so that graph
    // would have no edges at all and the referenced rows could be inserted after the ones pointing at
    // them. Edging every forward reference and taking `compilationOrder` (dependencies first) is the
    // shape Signum's `GraphExplorer.FromRoot(entity).CompilationOrder()` has.
    async function restoreEntityGraph(root: Entity): Promise<void> {
        const entities = [...exploreModifiables([root])].filter((m): m is Entity => m instanceof Entity);
        const inGraph = new Set(entities);
        const graph = DirectedGraph.generate(entities, e => forwardReferences(e).filter(t => inGraph.has(t)));

        for (const item of graph.compilationOrder()) {
            if (await exists(item))
                continue;

            // isNew with the id kept = Signum's SaveDisableIdentity (see the header).
            setSelfModified(item);
            item.isNew = true;
            await item.save();
        }
    }

    async function exists(entity: Entity): Promise<boolean> {
        const type = entity.constructor as Type<Entity>;
        const id = entity.id;
        return await table(type).some(a => a.id == id);
    }

    // Signum's `Entity.SetSelfModified()` — force the row to be written even though nothing on it
    // differs from its snapshot. altea tracks changes against a snapshot taken at retrieval, so
    // dropping the snapshot is what makes the entity dirty.
    function setSelfModified(entity: Entity): void {
        (entity as unknown as { _snapshot?: unknown })._snapshot = true;
    }

    function toPlainDateTime(bound: Temporal.PlainDateTime | Temporal.Instant): Temporal.PlainDateTime {
        return bound instanceof Temporal.Instant
            ? bound.toZonedDateTimeISO("UTC").toPlainDateTime()
            : bound;
    }
}
