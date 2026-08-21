import { UserHolder } from "@altea/altea/server/userHolder";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { Temporal } from "@altea/altea/data/basics";
import { SkillCode, Schema as S } from "../SkillCode";

// Port of Signum.Agent's Skills/CurrentServerContextSkill.cs — "what is now, who is asking, in which
// language, at which URL". The one skill the search prompt insists on calling before any date filter.
//
// altea divergences:
//  - `TimeZoneInfo.Local` → `Temporal.Now.timeZoneId()` plus the offset from the current instant.
//  - `UserEntity.Current.Retrieve()` is not needed: `UserHolder.current()` already carries the user's Lite
//    and its Role claim, which is exactly what the two fields report — one fewer database round-trip per
//    call, and it works in a request that has no database access.
//  - `CultureInfo.CurrentCulture` / `CurrentUICulture` → altea's per-request culture scope.
export class CurrentServerContextSkill extends SkillCode {

    /** Signum's `CurrentServerContextSkill.UrlLeft` — the application's public URL prefix. */
    static urlLeft: (() => string | null) | undefined;

    constructor() {
        super();

        this.shortDescription = "Returns the server context including date information, user information and url of the application";
        this.isAllowed = () => true;

        this.registerTool({
            name: "GetCurrentServerContext",
            description: "Returns the current local date/time, UTC date/time, and server time zone",
            returnType: "CurrentServerContext",
            parameters: S.args({}),
            invoke: async () => {
                const instant = Temporal.Now.instant();
                const timeZoneId = Temporal.Now.timeZoneId();
                const zoned = instant.toZonedDateTimeISO(timeZoneId);
                const user = UserHolder.current();

                return {
                    dateInfo: {
                        localDateTime: zoned.toPlainDateTime().toString(),
                        utcDateTime: instant.toString(),
                        timeZoneId,
                        timeZoneOffsetUtc: zoned.offset,
                    },
                    userInfo: {
                        userId: user?.user?.id?.toString() ?? null,
                        userLiteKey: user?.user?.key() ?? null,
                        userName: user?.user?.toString() ?? null,
                        userRole: (user?.claims?.["Role"] as { toString(): string } | undefined)?.toString() ?? null,
                    },
                    culture: {
                        currentCulture: CultureInfo.currentCulture(),
                        currentUICulture: CultureInfo.currentUICulture(),
                    },
                    urlPrefix: CurrentServerContextSkill.urlLeft?.() ?? null,
                };
            },
        });
    }
}
