import { cleanModified } from "../../data/changes";
import { Entity, type PrimaryKey, BaseEntity, newInstance, type Type, View, type ViewType } from "../../data/entity";
import { Lite, LiteImp } from "../../data/lite";
import { TypeLogic } from "../typeLogic";
import { Connector } from "../connection/connector";
import { getCacheController } from "../cache";

// Post-retrieve authorization seam (Signum's `EntityEventsGlobal.Retrieved`). Each gate gets the full set
// of freshly-materialised entities AFTER a query completes and may `throw` (e.g. UnauthorizedAccessException)
// to deny the read. The authorization module pushes one that throws when the current role can't Read a
// retrieved type. Async (it consults the role/rule cache). Empty by default. Analogue of `preSaveGates`.
export const postRetrieveGates: ((entities: Entity[]) => void | Promise<void>)[] = [];

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
    // query pipeline). Runs `table(ctor).filter(e => ids.includes(e.id))` into `this`.
    static retrieveListImpl: ((ctor: Type<Entity>, ids: PrimaryKey[], retriever: Retriever) => Promise<void>) | undefined;

    private readonly cache = new Map<string, Entity>();
    private readonly populated = new Set<Entity>();
    private readonly requests = new Map<string, { ctor: Type<Entity>, ids: Map<string, Entity> }>();

    private getOrCreate(ctor: Type<Entity>, id: PrimaryKey): Entity {
        const key = ctor.name + ":" + id;
        let e = this.cache.get(key);
        if (e == null) {
            e = newInstance(ctor);
            (e as any).id = id;
            e.isNew = false;
            this.cache.set(key, e);
        }
        return e;
    }

    // Build-or-reuse an entity and populate it (its columns + nested references). Also
    // completes a previously-stubbed instance: the batch retrieve in `completeAll` reaches
    // its rows here and fills the same object.
    entity(ctor: Type<Entity>, id: PrimaryKey | null, populate: (e: any) => void): Entity | null {
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

    // A raw view row. Unlike `entity`, view rows are NEVER routed through the identity map:
    // a view's representative primary key can be non-unique (altea collapses a composite
    // @viewPrimaryKey — e.g. the EmployeeTerritories junction's (EmployeeID, TerritoryID) —
    // to its FIRST column, so many rows share one id). Deduping by that id would return the
    // first row's object for every sibling row, dropping the distinct columns. Views are
    // read-only and navigate via sub-queries, not FK identity, so each projected row is its
    // own fresh instance (Signum reads view rows the same way).
    //
    // A `View` is NOT an Entity: no id / isNew / change-tracking snapshot. The representative
    // `id` is used SQL-side only (the EntityExpression's externalId for WHERE/JOIN correlation)
    // and never read off the instance — the @viewPrimaryKey stays a normal column binding that
    // `populate` fills under its real field name — so it is ignored here.
    viewRow<V extends View>(ctor: ViewType<V>, _id: PrimaryKey | null, populate: (e: V) => void): V {
        const e = new ctor();
        populate(e);
        return e;
    }

    // A referenced entity known only by id: return the id-only instance and register it
    // for batch completion (unless it's already fully populated).
    stub(ctor: Type<Entity>, id: PrimaryKey | null): Entity | null {
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

    // Signum's post-retrieving pass for EntityEvents<T>.Retrieved: after CompleteAll, every
    // populated instance is fully materialised, so fire Retrieved once per entity (in the
    // active schema). Idempotent-friendly — called once by TranslateResult.execute() at the top
    // level; the recursive batch loads in completeAll share this retriever and don't re-fire.
    async postRetrieved(): Promise<void> {
        const schema = Connector.current().schema;
        for (const e of this.populated)
            schema.entityEvents(e.constructor as Type<Entity>).onRetrieved(e);
        // A Retrieved handler may DERIVE an in-memory value from what was just read — Signum.Files stamps a
        // FilePathEmbedded's routing fields there, and BigStringLogic substitutes a file's content for the
        // embedded's `text`. Those writes land AFTER each instance's clean baseline was taken (materialisation
        // time), so re-take it; otherwise every retrieved entity of such a type reads back as dirty. Same
        // reason executeInto recleans after filling collections.
        this.reclean();
        // Global retrieve gates (Signum's EntityEventsGlobal.Retrieved) — e.g. the type-read auth gate.
        // Run once over the fully-materialised set; a gate may throw to deny the read.
        if (postRetrieveGates.length > 0) {
            const all = [...this.populated];
            for (const gate of postRetrieveGates)
                await gate(all);
        }
    }

    // Signum's RealRetriever.CompleteAll: drain the pending requests, batch-loading each
    // type by id into this same retriever, until none remain (a load can add more).
    async completeAll(): Promise<void> {
        if (Retriever.retrieveListImpl == null)
            return;
        while (this.requests.size > 0) {
            // Largest group first (Signum's MaxBy) — fewer round-trips overall.
            let best: { ctor: Type<Entity>, ids: Map<string, Entity> } | undefined;
            for (const g of this.requests.values())
                if (best == null || g.ids.size > best.ids.size) best = g;
            if (best == null || best.ids.size === 0) {
                for (const [k, g] of this.requests) if (g.ids.size === 0) this.requests.delete(k);
                continue;
            }
            const ctor = best.ctor;
            const stubs = [...best.ids.values()];
            const ids = stubs.map(e => (e as any).id as PrimaryKey);
            this.requests.delete(ctor.name);

            // Signum's RealRetriever.Complete: a CACHED type is filled from memory instead of a
            // `WHERE id IN (…)` round-trip. `EntityCompleter` already left these references as id-only
            // stubs precisely because the cache can complete them (see server/cache.ts). Completing marks
            // each stub populated, so the loop drains exactly as the SQL path does — and a reference the
            // cached row itself carries is stubbed in turn (possibly of a NON-cached type), which the next
            // iteration loads from the database.
            const cc = await getCacheController(ctor);
            if (cc != null) {
                for (const stub of stubs)
                    this.entity(ctor, (stub as any).id as PrimaryKey, e => cc.complete(e, this));
                continue;
            }

            await Retriever.retrieveListImpl(ctor, ids, this);
        }
    }

    // A Lite<T> loaded by id (+ optional display string). Builds a thin LiteImp —
    // the full entity is NOT retrieved (that's the point of a lite). `toStr` is the
    // server-computed display string; a proper per-type toString expression is a
    // later tier, so it is usually empty for now.
    lite(ctor: Type<Entity>, id: PrimaryKey | null, toStr: string | null): Lite<Entity> | null {
        if (id == null) return null;
        return new LiteImp(id, ctor, toStr ?? "");
    }

    // A @implementedByAll reference (id + TypeEntity-id discriminator): resolve the
    // type id to its constructor, then build an id-only stub of that type.
    implementedByAll(id: PrimaryKey | null, typeId: PrimaryKey | null): Entity | null {
        if (id == null || typeId == null) return null;
        const ctor = TypeLogic.tryGetType(typeId);
        if (ctor == null) return null;
        return this.stub(ctor as Type<Entity>, id);
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
    embedded(ctor: Type<BaseEntity>, populate: (e: any) => void): BaseEntity {
        const e = newInstance(ctor);
        populate(e);
        cleanModified(e);
        return e;
    }
}
