import { cleanModified } from "../../entities/changes";
import { Entity, PrimaryKey, BaseEntity, Type } from "../../entities/entity";
import { Lite, LiteImp } from "../../entities/lite";

// Port of Signum's TranslatorBuilder + TranslateResult + ProjectionReader.
// Formats the SQL and compiles the projector into a `(row, retriever) => T`
// function via codegen (`new Function`). Rows are objects keyed by SELECT column
// alias; a ColumnExpression reads `row["<name>"]`. Entity/embedded nodes generate
// calls into the Retriever, which constructs instances, caches by (type,id), and
// takes the clean change-tracking snapshot on load (the Phase-C "retrieve" half).
// The IRetriever surface the generated code targets.
export class Retriever {
    private readonly cache = new Map<string, Entity>();

    // Build-or-reuse a fully-populated entity. `populate` sets the row's columns
    // (and nested references) before the clean snapshot is taken.
    entity(ctor: new () => Entity, id: PrimaryKey | null, populate: (e: any) => void): Entity | null {
        if (id == null) return null;
        const key = ctor.name + ":" + id;
        let e = this.cache.get(key);
        if (e == null) {
            e = new ctor();
            (e as any).id = id;
            e.isNew = false;
            this.cache.set(key, e);
            populate(e);
            cleanModified(e);
        }
        return e;
    }

    // A referenced entity known only by id (no columns loaded). Deferred batch
    // completion is a later step; for now it's an id-only instance.
    stub(ctor: new () => Entity, id: PrimaryKey | null): Entity | null {
        if (id == null) return null;
        const key = ctor.name + ":" + id;
        let e = this.cache.get(key);
        if (e == null) {
            e = new ctor();
            (e as any).id = id;
            e.isNew = false;
            cleanModified(e);
            this.cache.set(key, e);
        }
        return e;
    }

    // A Lite<T> loaded by id (+ optional display string). Builds a thin LiteImp —
    // the full entity is NOT retrieved (that's the point of a lite). `toStr` is the
    // server-computed display string; a proper per-type toString expression is a
    // later tier, so it is usually empty for now.
    lite(ctor: new () => Entity, id: PrimaryKey | null, toStr: string | null): Lite<Entity> | null {
        if (id == null) return null;
        return new LiteImp(id, ctor as unknown as Type<Entity>, toStr ?? "");
    }

    // An embedded value (no identity / no cache). The parent's snapshot inlines it.
    embedded(ctor: new () => BaseEntity, populate: (e: any) => void): BaseEntity {
        const e = new ctor();
        populate(e);
        cleanModified(e);
        return e;
    }
}
