import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, quoted, legacyPropertyRoute } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { Lite } from "@altea/altea/data/lite";
import { Temporal } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import type { PermissionSymbol } from "./Rules";
import { UserEntity } from "./User";

// Port of Signum.Authorization's SessionLog/SessionLog.cs — see port/Auth.md.
//
// Who logged in, from where, and for how long.
// One row per login, opened when a user logs in and closed when they log out.
//
// Starting the module is the app's choice (Southwind's `SessionLogLogic.Start(sb)`), and which roles are
// recorded is then a PERMISSION question: a login is logged only if the user's role is authorized for
// `SessionLogPermission.TrackSession`.
//
// Read that gate precisely — it is an authorization check, NOT an explicit grant. A role with no rule for
// the permission falls back to the role's own default, so an unrestricted role
// IS tracked as soon as the module starts, and it is a RESTRICTED role that has to be granted the
// permission to appear. Verified against eastwind's own roles in probeSessionLog. To track nobody by
// default, deny the permission to the roles that should not be recorded — or do not start the module.
//
// altea divergences, documented inline:
//  - `[DateTimePrecisionValidator(DateTimePrecision.Seconds)]` has no altea counterpart (the call
//    @altea/altea-sms already made), so the two dates are TRUNCATED where they are assigned —
//    SessionLogLogic's `truncSeconds`.
//  - `Duration` is a `@quoted` member returning a plain `number | null`, so it is a real query column
//    (@altea/altea-rest and -view-log make the same move for theirs).

@reflect
@entity("System", "Transactional")
export class SessionLogEntity extends Entity {
    user: Lite<UserEntity>;

    sessionStart: Temporal.PlainDateTime;

    sessionEnd: Temporal.PlainDateTime | null;

    sessionTimeOut: boolean = false;

    @stringLengthValidator({ max: 100 })
    userHostAddress: string | null;

    @stringLengthValidator({ max: 300 })
    userAgent: string | null;

    /**
     * The session's length in seconds, null while it
     * is still open.
     *
     * `@quoted` so it is an orderable / filterable column on the search page ("whose sessions are longest",
     * "which sessions never closed"), the shape @altea/altea-rest's `durationMilliseconds` uses. A plain
     * `number` lowers through `since().total()`; the nullable ternary becomes a CASE WHEN.
     */
    @legacyPropertyRoute("Duration")
    @quoted
    durationSeconds(): number | null {
        return this.sessionEnd != null ? this.sessionEnd.since(this.sessionStart).total({ unit: "seconds" }) : null;
    }

    toString(): string {
        return `${this.user?.toString() ?? ""} (${this.sessionStart?.toString() ?? ""}-${this.sessionEnd?.toString() ?? ""})`;
    }
}

/** A role is tracked only if it is granted this. */
export namespace SessionLogPermission {
    export const TrackSession: PermissionSymbol = init();
}

export const SessionLogMessage = {
    // The caption of the `Duration` token over durationSeconds() (registered in SessionLogLogic).
    // Signum translates it as the entity's `Duration` PROPERTY; a `@quoted` method is not a PropertyRoute
    // here, so it has no <Member> entry to hold a translation — `stub-translations` builds a type's member
    // list from PropertyRoute.memberPaths, i.e. from FIELDS — and a message is the localizable home that
    // leaves. It used to be `nicePropertyName(a => a.durationSeconds())`, which silently humanised to
    // "Duration seconds" in every culture.
    Duration: msg(),
};
