import "@altea/altea/server"; // installs save()/toLite()
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import * as Database from "@altea/altea/server/Database";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { SystemTime, SystemTimeJoinModeKeys } from "@altea/altea/server/systemTime";
import { exploreModifiables, forwardReferences } from "@altea/altea/server/graphExplorer";
import { DirectedGraph } from "@altea/altea/server/directedGraph";
import { Entity, type Type, type PrimaryKey } from "@altea/altea/data/entity";
import { Temporal } from "@altea/altea/data/basics";
import { TimeMachinePermission } from "../data/TimeMachine";
import { TimeMachineServer } from "./TimeMachineServer";
import { PermissionLogic } from "@altea/altea-auth/server/PermissionLogic";

// The module starter plus the two RESTORE helpers. An application calls them from its own operation; the
// module ships no button of its own.
//
// Port of Signum.TimeMachine's TimeMachineLogic.cs — see docs/port/TimeMachine.md.
export namespace TimeMachineLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        PermissionLogic.registerContainer(TimeMachinePermission);

        if (sb.webBuilder)
            TimeMachineServer.start(sb.webBuilder);
    }

    /**
     * Read the row as it was at `lastVersion` and save it over the CURRENT one, so the history gains a new
     * version that happens to equal an old one (nothing is rewritten — a restore, not a rollback).
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
     * Find the instant the row was deleted, step just before it, and re-insert everything in its graph
     * that no longer exists. Returns the restored entity together with the instant it was read at.
     */
    export async function restoreDeletedEntity<T extends Entity>(
        type: Type<T>, id: PrimaryKey): Promise<{ entity: T; date: Temporal.PlainDateTime }> {

        // `max` is typed for scalar values only (a Temporal is not one), hence ORDER BY + first.
        const lastVersion = await SystemTime.override(new SystemTime.All(SystemTimeJoinModeKeys.AllCompatible), () =>
            table(type)
                .filter(a => a.id == id)
                .orderByDescending(a => a.systemPeriod().max)
                .map(a => a.systemPeriod().max)
                .firstOrNull());

        if (lastVersion == null)
            throw new Error(`No deleted version of ${type.name} ${id} was found in the history table`);

        // The deletion's period bound is EXCLUSIVE of the version we want, so step back inside it.
        const date = toPlainDateTime(lastVersion).subtract({ microseconds: 10 });

        return { entity: await restoreDeletedEntityAsOf(type, id, date), date };
    }

    /** The explicit-instant overload. */
    export async function restoreDeletedEntityAsOf<T extends Entity>(
        type: Type<T>, id: PrimaryKey, lastVersion: Temporal.PlainDateTime | Temporal.Instant): Promise<T> {

        return await Transaction.create(async () => {
            const entity = await SystemTime.override(new SystemTime.AsOf(lastVersion), () =>
                Database.retrieve(type, id));

            await restoreEntityGraph(entity);

            return entity;
        });
    }

    // Walk the graph in save (dependency) order and re-insert every entity that is no longer in the
    // database, keeping its original id.
    //
    // The graph is built here rather than through `saveDependencyGraph`, which only edges targets that are
    // `isNew` — every entity read back from history is a CLEAN, id-carrying instance, so that graph would
    // have no edges at all and a referenced row could be inserted after the row pointing at it. Edging
    // every forward reference and taking `compilationOrder` (dependencies first) is what this needs.
    async function restoreEntityGraph(root: Entity): Promise<void> {
        const entities = [...exploreModifiables([root])].filter((m): m is Entity => m instanceof Entity);
        const inGraph = new Set(entities);
        const graph = DirectedGraph.generate(entities, e => forwardReferences(e).filter(t => inGraph.has(t)));

        for (const item of graph.compilationOrder()) {
            if (await exists(item))
                continue;

            // isNew with the id kept: the insert path writes an explicit id into an identity PK.
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

    // Force the row to be written even though nothing on it differs from its snapshot. Changes are
    // tracked against a snapshot taken at retrieval, so dropping it is what makes the entity dirty.
    function setSelfModified(entity: Entity): void {
        entity._snapshot = true;
    }

    function toPlainDateTime(bound: Temporal.PlainDateTime | Temporal.Instant): Temporal.PlainDateTime {
        return bound instanceof Temporal.Instant
            ? bound.toZonedDateTimeISO("UTC").toPlainDateTime()
            : bound;
    }
}
