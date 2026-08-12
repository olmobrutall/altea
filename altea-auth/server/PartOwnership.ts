import type { Schema } from "@altea/altea/server/schema";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { FieldReference, FieldEnum, FieldImplementedBy, FieldEntityArray } from "@altea/altea/server/schema/field";

// Ownership derivation for PART entities (altea's MList replacement). A Part is OWNED by exactly one
// entity and, for authorization, INHERITS that owner's TypeAllowed + TypeConditions — so Parts never carry
// their own rules and never appear in the Type-Auth grid. The owner is discovered structurally from the
// schema: any field whose TARGET is a Part is an owned-part edge, in three shapes —
//   • array / back-reference  (Parent ← Part[]):   the owner's FieldEntityArray whose childType is a Part
//   • forward single ref       (Parent → Part):     the owner's FieldReference to a Part table
//   • forward polymorphic ref  (Parent → IPart):    the owner's FieldImplementedBy with a Part target
// Ownership CHAINS to the nearest non-Part ancestor (e.g. a Dashboard's polymorphic content part →
// PanelPart → Dashboard), which is why manually mirroring a Dashboard's rules onto each IPartEntity impl
// (Signum's pain point) is no longer needed. MULTI-OWNER IS FORBIDDEN: a Part referenced by two different
// owners throws — use `@entity("SharedPart")` (shown in the grid, rules defined manually) for real sharing.

export interface PartEdge { owner: Function; part: Function; }

function isPart(ctor: Function): boolean {
    return getTypeInfo(ctor)?.entityKind === "Part";
}

// Scan every table's fields (+ mixin fields) for owned-part edges (owner → part). Enum FKs (FieldEnum) and
// @implementedByAll are ignored (an enum target is never a Part; byAll can't be enumerated statically).
export function partEdges(schema: Schema): PartEdge[] {
    const edges: PartEdge[] = [];
    const add = (owner: Function, target: Function | undefined): void => {
        if (target != null && isPart(target)) edges.push({ owner, part: target });
    };
    const scan = (owner: Function, ef: { fieldInfo?: { isBackReference?: boolean }; field: unknown }): void => {
        // A @backReference is a child pointing UP to its parent — the reverse of ownership, NOT an owned
        // edge. Skip it, else a part-of-a-part's back-pointer would look like a second owner of the parent.
        if (ef.fieldInfo?.isBackReference)
            return;
        const field = ef.field;
        if (field instanceof FieldEntityArray) add(owner, field.childType as unknown as Function);
        else if (field instanceof FieldEnum) { /* enum side-table, never a Part */ }
        else if (field instanceof FieldReference) add(owner, field.column.referenceTable?.type as unknown as Function | undefined);
        else if (field instanceof FieldImplementedBy) for (const c of field.implementationColumns) add(owner, c.referenceTable?.type as unknown as Function | undefined);
    };
    for (const table of schema.tables.values()) {
        for (const ef of Object.values(table.fields)) scan(table.type as unknown as Function, ef);
        for (const mixin of Object.values(table.mixins)) for (const ef of Object.values(mixin.fields)) scan(table.type as unknown as Function, ef);
    }
    return edges;
}

// part → its ROOT (nearest non-Part owner), from the edge list. PURE (no schema) so it is unit-testable.
// Throws on a multi-owner Part (forbidden) or a cyclic ownership chain.
export function partRoots(edges: PartEdge[]): Map<Function, Function> {
    const owners = new Map<Function, Set<Function>>();
    for (const { owner, part } of edges) {
        let s = owners.get(part);
        if (s == null) owners.set(part, s = new Set());
        s.add(owner);
    }

    const immediate = new Map<Function, Function>();
    for (const [part, set] of owners) {
        if (set.size > 1)
            throw new Error(`Part '${part.name}' has ${set.size} owners (${[...set].map(o => o.name).join(", ")}). A Part may have exactly ONE owner — declare it @entity("SharedPart") and define its auth rules manually instead.`);
        immediate.set(part, [...set][0]);
    }

    // A ctor is a Part (for chaining) iff it is itself an owned key in `immediate`.
    const root = new Map<Function, Function>();
    for (const part of immediate.keys()) {
        const seen = new Set<Function>([part]);
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
export function computePartRoots(schema: Schema): Map<Function, Function> {
    return partRoots(partEdges(schema));
}

// part → the chain of @backReference field names to navigate from the Part UP to its non-Part root
// (e.g. Widget → ["panel", "sample"] so `widget.panel.sample` is the root Sample). ONLY back-reference
// Parts (array/MList children) have this; a forward / polymorphic content Part has no back-pointer, so it
// is absent — its standalone-query filter (a reverse lookup) is not derivable here and is left unfiltered
// (those Parts aren't exposed standalone anyway). Used to rebase the ROOT's TypeCondition onto a standalone
// `table(Part)` query. Throws on a cyclic chain.
export function partParentChains(schema: Schema): Map<Function, string[]> {
    // Each Part's immediate back-reference: { field name, owner ctor }.
    const backref = new Map<Function, { field: string; owner: Function }>();
    for (const table of schema.tables.values()) {
        const owner = table.type as unknown as Function;
        if (!isPart(owner)) continue;
        for (const [name, ef] of Object.entries(table.fields) as [string, { fieldInfo?: { isBackReference?: boolean }; field: unknown }][]) {
            if (ef.fieldInfo?.isBackReference && ef.field instanceof FieldReference) {
                backref.set(owner, { field: name, owner: ef.field.column.referenceTable?.type as unknown as Function });
                break; // an owned Part has a single back-reference to its owner
            }
        }
    }

    const chains = new Map<Function, string[]>();
    for (const part of backref.keys()) {
        const chain: string[] = [];
        const seen = new Set<Function>([part]);
        let cur: Function = part;
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
