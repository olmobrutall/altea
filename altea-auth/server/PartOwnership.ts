import type { Schema } from "@altea/altea/server/schema";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { FieldReference, FieldEnum, FieldImplementedBy, FieldEntityArray } from "@altea/altea/server/schema/field";
import type { Type, Entity } from "@altea/altea/data/entity";

// Ownership derivation for PART entities (altea's MList replacement). A Part is OWNED by exactly one
// entity and, for authorization, INHERITS that owner's TypeAllowed + TypeConditions — so Parts never carry
// their own rules and never appear in the Type-Auth grid. The owner is discovered structurally from the
// schema: any field whose TARGET is a Part is an owned-part edge, in three shapes —
//   • array / back-reference  (Parent ← Part[]):   the owner's FieldEntityArray whose childType is a Part
//   • forward single ref       (Parent → Part):     the owner's FieldReference to a Part table
//   • forward polymorphic ref  (Parent → IPart):    the owner's FieldImplementedBy with a Part target
// Ownership CHAINS to the nearest non-Part ancestor (e.g. a Dashboard's polymorphic content part →
// PanelPart → Dashboard), which is why manually mirroring a Dashboard's rules onto each IPartEntity impl
// is no longer needed. MULTI-OWNER IS FORBIDDEN: a Part referenced by two different
// owners throws — use `@entity("SharedPart")` (shown in the grid, rules defined manually) for real sharing.

export interface PartEdge { owner: Type<Entity>; part: Type<Entity>; }

function isPart(ctor: Type<Entity>): boolean {
    return getTypeInfo(ctor)?.entityKind === "Part";
}

// Scan every table's fields (+ mixin fields) for owned-part edges (owner → part). Enum FKs (FieldEnum) and
// @implementedByAll are ignored (an enum target is never a Part; byAll can't be enumerated statically).
//
// A Part with a @backReference (a collection row, including a virtual collection's standalone rows) names its
// owner itself: the edge comes from that back-reference, and a forward reference to the row from ANY other
// entity is a plain reference, not a second owner (e.g. a career step pointing at the skill group its career
// path owns).
export function partEdges(schema: Schema): PartEdge[] {
    const edges: PartEdge[] = [];

    const backRefOwner = new Map<Type<Entity>, Type<Entity>>();
    for (const [type, table] of schema.tables) {
        if (!isPart(type))
            continue;
        for (const ef of Object.values(table.fields) as { fieldInfo?: { isBackReference?: boolean }; field: unknown }[]) {
            const owner = ef.fieldInfo?.isBackReference && ef.field instanceof FieldReference ? ef.field.column.referenceTable?.entityType : undefined;
            if (owner != null) {
                backRefOwner.set(type, owner);
                edges.push({ owner, part: type });
                break;
            }
        }
    }

    const add = (owner: Type<Entity>, target: Type<Entity> | undefined): void => {
        if (target != null && isPart(target) && !backRefOwner.has(target)) edges.push({ owner, part: target });
    };
    const scan = (owner: Type<Entity>, ef: { fieldInfo?: { isBackReference?: boolean }; field: unknown }): void => {
        // A @backReference is a child pointing UP to its parent — the reverse of ownership, NOT an owned
        // edge. Skip it, else a part-of-a-part's back-pointer would look like a second owner of the parent.
        if (ef.fieldInfo?.isBackReference)
            return;
        const field = ef.field;
        if (field instanceof FieldEntityArray) add(owner, field.childType);
        else if (field instanceof FieldEnum) { /* enum side-table, never a Part */ }
        else if (field instanceof FieldReference) add(owner, field.column.referenceTable?.entityType);
        else if (field instanceof FieldImplementedBy) for (const c of field.implementationColumns) add(owner, c.referenceTable?.entityType);
    };
    for (const [type, table] of schema.tables) {
        for (const ef of Object.values(table.fields)) scan(type, ef);
        for (const mixin of Object.values(table.mixins)) for (const ef of Object.values(mixin.fields)) scan(type, ef);
    }
    return edges;
}

// part → its ROOT (nearest non-Part owner), from the edge list. PURE (no schema) so it is unit-testable.
// Throws on a multi-owner Part (forbidden) or a cyclic ownership chain.
export function partRoots(edges: PartEdge[]): Map<Type<Entity>, Type<Entity>> {
    const owners = new Map<Type<Entity>, Set<Type<Entity>>>();
    for (const { owner, part } of edges) {
        let s = owners.get(part);
        if (s == null) owners.set(part, s = new Set());
        s.add(owner);
    }

    const immediate = new Map<Type<Entity>, Type<Entity>>();
    for (const [part, set] of owners) {
        if (set.size > 1)
            throw new Error(`Part '${part.name}' has ${set.size} owners (${[...set].map(o => o.name).join(", ")}). A Part may have exactly ONE owner — declare it @entity("SharedPart") and define its auth rules manually instead.`);
        immediate.set(part, [...set][0]);
    }

    // A ctor is a Part (for chaining) iff it is itself an owned key in `immediate`.
    const root = new Map<Type<Entity>, Type<Entity>>();
    for (const part of immediate.keys()) {
        const seen = new Set<Type<Entity>>([part]);
        let cur = part;
        for (;;) {
            const owner = immediate.get(cur)!;
            if (!immediate.has(owner)) { root.set(part, owner); break; } // owner is a non-Part → the root
            if (seen.has(owner)) throw new Error(`Cyclic part ownership involving '${owner.name}'`);
            seen.add(owner);
            cur = owner;
        }
    }
    return root;
}

// part → root over the live schema (the wiring TypeAuthLogic uses at initialize).
export function computePartRoots(schema: Schema): Map<Type<Entity>, Type<Entity>> {
    return partRoots(partEdges(schema));
}

// part → the chain of @backReference field names to navigate from the Part UP to its non-Part root
// (e.g. Widget → ["panel", "sample"] so `widget.panel.sample` is the root Sample). ONLY back-reference
// Parts (array/MList children) have this; a forward / polymorphic content Part has no back-pointer, so it
// is absent — its standalone-query filter (a reverse lookup) is not derivable here and is left unfiltered
// (those Parts aren't exposed standalone anyway). Used to rebase the ROOT's TypeCondition onto a standalone
// `table(Part)` query. Throws on a cyclic chain.
export function partParentChains(schema: Schema): Map<Type<Entity>, string[]> {
    // Each Part's immediate back-reference: { field name, owner ctor }.
    const backref = new Map<Type<Entity>, { field: string; owner: Type<Entity> }>();
    for (const [owner, table] of schema.tables) {
        if (!isPart(owner)) continue;
        for (const [name, ef] of Object.entries(table.fields) as [string, { fieldInfo?: { isBackReference?: boolean }; field: unknown }][]) {
            if (ef.fieldInfo?.isBackReference && ef.field instanceof FieldReference) {
                backref.set(owner, { field: name, owner: ef.field.column.referenceTable!.entityType });
                break; // an owned Part has a single back-reference to its owner
            }
        }
    }

    const chains = new Map<Type<Entity>, string[]>();
    for (const part of backref.keys()) {
        const chain: string[] = [];
        const seen = new Set<Type<Entity>>([part]);
        let cur: Type<Entity> = part;
        for (;;) {
            const br = backref.get(cur);
            if (br == null) break;         // cur is a non-Part (root) OR a Part without a back-reference
            chain.push(br.field);
            if (!isPart(br.owner)) break;  // owner is the root → done
            if (seen.has(br.owner)) throw new Error(`Cyclic part ownership involving '${br.owner.name}'`);
            seen.add(br.owner);
            cur = br.owner;
        }
        chains.set(part, chain);
    }
    return chains;
}
