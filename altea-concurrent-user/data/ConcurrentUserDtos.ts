import type { Lite } from "@altea/altea/data/lite";
import type { UserEntity } from "@altea/altea-auth/data/User";

/**
 * The shape the widget renders.
 *
 * `startTime` is an ISO STRING, not a Temporal. A DTO crosses the wire as an untyped `CustomType`, so the
 * serializer has no field metadata to revive a Temporal from; typing it as one would hand the widget a
 * string that fails only later, when the widget calls a Temporal method on it.
 */
export interface ConcurrentUserResponse {
    user: Lite<UserEntity>;
    startTime: string;
    connectionID: string;
    isModified: boolean;
}
