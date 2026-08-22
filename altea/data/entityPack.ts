import type { BaseEntity } from './entity';

// Port of Signum's EntityPack: an entity plus the operations the current user may execute on it.
// `canExecute` maps an operation key -> null/allowed, or a reason string when the operation is
// disabled. Sent by the server's entityPack controller and consumed by the operation buttons.
export interface EntityPack<T extends BaseEntity = BaseEntity> {
    entity: T;
    canExecute: { [operationKey: string]: string };
    // Signum's `EntityPackTS.extension` — an open bag a module fills server-side (Signum's
    // `EntityPackTS.AddExtension` event, altea's `registerEntityPackExtension`) so its widgets can decide
    // what to render WITHOUT a second round-trip. @altea/altea-tour's `hasTour` is the first entry.
    // Absent when no module contributed anything.
    extension?: { [key: string]: unknown };
}

// Signum's `isEntityPack` type guard: an object carrying both `entity` and `canExecute`. Check
// `canExecute` (a plain property) BEFORE `.entity`: reading `.entity` on a thin Lite throws ("not
// loaded"), so a Lite must be rejected without ever touching its `.entity` getter.
export function isEntityPack(obj: unknown): obj is EntityPack {
    return obj != null && (obj as EntityPack).canExecute !== undefined && (obj as EntityPack).entity !== undefined;
}
