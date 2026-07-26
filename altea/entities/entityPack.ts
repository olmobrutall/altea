import type { BaseEntity } from './entity';

// Port of Signum's EntityPack: an entity plus the operations the current user may execute on it.
// `canExecute` maps an operation key -> null/allowed, or a reason string when the operation is
// disabled. Sent by the server's entityPack controller and consumed by the operation buttons.
export interface EntityPack<T extends BaseEntity = BaseEntity> {
    entity: T;
    canExecute: { [operationKey: string]: string };
}
