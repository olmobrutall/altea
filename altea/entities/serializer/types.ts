// Shared option, context and serializer-contract types for the JSON codec. The
// context/slot/JsonSerializer/FieldPlan shapes are internal (used across the codec's
// modules); only WriteTypes / SerializeOptions / DeserializeOptions are re-exported as
// public API by the barrel.

import type { PrimaryKey, BaseEntity, Entity } from '../entity';

// ---- Options ---------------------------------------------------------------

export type WriteTypes = 'Always' | 'Auto';

export interface SerializeOptions {
    /** Discriminator verbosity; defaults to "Auto". */
    writeTypes?: WriteTypes;
}

export interface DeserializeOptions {
    /**
     * Supplies the authoritative "original" for an existing entity (id present) so the codec
     * applies onto it — overlaying when `modified`, else keeping it and warning on a baseline
     * mismatch. The returned entity is assumed to carry its clean snapshot. Omit for the
     * client-receive path (build fresh + seed the snapshot from the `modified` flag).
     */
    resolve?: (typeName: string, id: PrimaryKey) => Entity | undefined | null;
    /** Overrides the default console.warn for the not-modified consistency tripwire. */
    onWarn?: (message: string) => void;
}

// ---- Contexts --------------------------------------------------------------

export interface SerializationContext {
    writeTypes: WriteTypes;
    path: Set<BaseEntity>;   // cycle guard for full-entity references
}

export interface DeserializationContext {
    idMap: Map<string, Entity>;   // intra-payload identity, keyed "TypeName|id"
    resolve?: DeserializeOptions['resolve'];
    onWarn?: DeserializeOptions['onWarn'];
}

// The containing entity for a value being deserialized. `index != null` marks a part-entity
// collection element (so its @backReference/@rowOrder get recovered from the owner + index).
export interface Slot {
    owner?: Entity;
    index?: number;
}

// ---- Serializer contract ---------------------------------------------------

export interface JsonSerializer {
    toJson(value: unknown, sc: SerializationContext, writeType: boolean, parented?: boolean): unknown;
    fromJson(json: unknown, dc: DeserializationContext, existing: unknown, slot?: Slot): unknown;
}

export interface FieldPlan {
    name: string;
    serializer: JsonSerializer;
    isBackReference: boolean;
    isRowOrder: boolean;
}
