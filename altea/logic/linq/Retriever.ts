import { cleanModified } from "../../entities/changes";
import { Entity, type PrimaryKey, BaseEntity, type Type } from "../../entities/entity";
import { Lite, LiteImp } from "../../entities/lite";
import { TypeLogic } from "../typeLogic";

// Port of Signum's TranslatorBuilder + TranslateResult + ProjectionReader.
// Formats the SQL and compiles the projector into a `(row, retriever) => T`
// function via codegen (`new Function`). Rows are objects keyed by SELECT column
// alias; a ColumnExpression reads `row["<name>"]`. Entity/embedded nodes generate
// calls into the Retriever, which constructs instances, caches by (type,id), and
// takes the clean change-tracking snapshot on load (the Phase-C "retrieve" half).
// The IRetriever surface the generated code targets.
// Port of Signum's RealRetriever: an identity map plus a set of pending "requests"
// (referenced rows known only by id — IBA targets, cycle-broken and AvoidExpand
// references). After the main query is read, `completeAll` batch-loads each pending
// type (`WHERE id IN (…)`) into the SAME identity map, populating the stub instances
// in place, and loops until nothing is pending (a batch load can surface new stubs).
export class Retriever {
    // Injected by table.ts to break the import cycle (this file must not import the
    // query pipeline). Runs `table(ctor).filter(e => ids.contains(e.id))` into `this`.
    static retrieveListImpl: ((ctor: new () => Entity, ids: PrimaryKey[], retriever: Retriever) => Promise<void>) | undefined;

    private readonly cache = new Map<string, Entity>();
    private readonly populated = new Set<Entity>();
    private readonly requests = new Map<string, { ctor: new () => Entity, ids: Map<string, Entity> }>();

    private getOrCreate(ctor: new () => Entity, id: PrimaryKey): Entity {
        const key = ctor.name + ":" + id;
        let e = this.cache.get(key);
        if (e == null) {
            e = new ctor();
            (e as any).id = id;
            e.isNew = false;
            this.cache.set(key, e);
        }
        return e;
    }

    // Build-or-reuse an entity and populate it (its columns + nested references). Also
    // completes a previously-stubbed instance: the batch retrieve in `completeAll` reaches
    // its rows here and fills the same object.
    entity(ctor: new () => Entity, id: PrimaryKey | null, populate: (e: any) => void): Entity | null {
        if (id == null) return null;
        const e = this.getOrCreate(ctor, id);
        if (!this.populated.has(e)) {
            this.populated.add(e);
            this.requests.get(ctor.name)?.ids.delete(String(id));
            populate(e);
            cleanModified(e);
        }
        return e;
    }

    // A referenced entity known only by id: return the id-only instance and register it
    // for batch completion (unless it's already fully populated).
    stub(ctor: new () => Entity, id: PrimaryKey | null): Entity | null {
        if (id == null) return null;
        const e = this.getOrCreate(ctor, id);
        if (!this.populated.has(e)) {
            cleanModified(e);
            let group = this.requests.get(ctor.name);
            if (group == null)
                this.requests.set(ctor.name, group = { ctor, ids: new Map() });
            group.ids.set(String(id), e);
        }
        return e;
    }

    // Re-take the clean change-tracking snapshot of every populated entity. Called after a
    // lazy MList collection is filled in place (post main query): the snapshot taken when the
    // entity was materialised predates the fill, so without this the freshly-retrieved entity
    // reads as dirty. Signum's `retriever.ModifiablePostRetrieving` per filled MList — altea's
    // snapshot inlines a collection as an id-list, so re-cleaning the owner suffices.
    reclean(): void {
        for (const e of this.populated)
            cleanModified(e);
    }

    // Signum's RealRetriever.CompleteAll: drain the pending requests, batch-loading each
    // type by id into this same retriever, until none remain (a load can add more).
    async completeAll(): Promise<void> {
        if (Retriever.retrieveListImpl == null)
            return;
        while (this.requests.size > 0) {
            // Largest group first (Signum's MaxBy) — fewer round-trips overall.
            let best: { ctor: new () => Entity, ids: Map<string, Entity> } | undefined;
            for (const g of this.requests.values())
                if (best == null || g.ids.size > best.ids.size) best = g;
            if (best == null || best.ids.size === 0) {
                for (const [k, g] of this.requests) if (g.ids.size === 0) this.requests.delete(k);
                continue;
            }
            const ctor = best.ctor;
            const ids = [...best.ids.values()].map(e => (e as any).id as PrimaryKey);
            this.requests.delete(ctor.name);
            await Retriever.retrieveListImpl(ctor, ids, this);
        }
    }

    // A Lite<T> loaded by id (+ optional display string). Builds a thin LiteImp —
    // the full entity is NOT retrieved (that's the point of a lite). `toStr` is the
    // server-computed display string; a proper per-type toString expression is a
    // later tier, so it is usually empty for now.
    lite(ctor: new () => Entity, id: PrimaryKey | null, toStr: string | null): Lite<Entity> | null {
        if (id == null) return null;
        return new LiteImp(id, ctor as unknown as Type<Entity>, toStr ?? "");
    }

    // A @implementedByAll reference (id + TypeEntity-id discriminator): resolve the
    // type id to its constructor, then build an id-only stub of that type.
    implementedByAll(id: PrimaryKey | null, typeId: PrimaryKey | null): Entity | null {
        if (id == null || typeId == null) return null;
        const ctor = TypeLogic.tryGetType(typeId);
        if (ctor == null) return null;
        return this.stub(ctor as new () => Entity, id);
    }

    // A Lite<T> over a @implementedByAll reference: a thin LiteImp of the concrete
    // type named by the discriminator id.
    liteImplementedByAll(id: PrimaryKey | null, typeId: PrimaryKey | null, toStr: string | null): Lite<Entity> | null {
        if (id == null || typeId == null) return null;
        const ctor = TypeLogic.tryGetType(typeId);
        if (ctor == null) return null;
        return new LiteImp(id, ctor as unknown as Type<Entity>, toStr ?? "");
    }

    // The runtime type of an @implementedByAll reference (Signum's Schema.GetType):
    // resolve the TypeEntity-id discriminator back to its constructor — altea's
    // analogue of a C# `Type`. Returns null for a null/unknown discriminator.
    type(typeId: PrimaryKey | null): Function | null {
        if (typeId == null) return null;
        return TypeLogic.tryGetType(typeId) ?? null;
    }

    // An embedded value (no identity / no cache). The parent's snapshot inlines it.
    embedded(ctor: new () => BaseEntity, populate: (e: any) => void): BaseEntity {
        const e = new ctor();
        populate(e);
        cleanModified(e);
        return e;
    }
}
