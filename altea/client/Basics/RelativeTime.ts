import { Temporal } from "temporal-polyfill";
import { Clock } from "../../data/utils/clock";

// luxon's `DateTime.toRelative()`, over Temporal + Intl.
//
// Signum reaches for luxon wherever it shows "when did this happen" without a precise timestamp — the alert
// bell, the what's-new dropdown, the cached-dashboard staleness badge. altea has no luxon, and each of those
// had grown its own copy of this function, so it lives here: it is a formatting decision about a
// PlainDateTime and nothing about it belongs to any one module.

/**
 * "3 minutes ago" / "in 2 days" for a stored PlainDateTime, in the viewer's own locale.
 *
 * The unit is chosen the way luxon's `toRelative` chooses it — the largest one whose count is still small —
 * and `numeric: "auto"` is what turns "1 day ago" into "yesterday".
 */
export function toRelativeTime(date: Temporal.PlainDateTime | null | undefined): string {
    if (date == null)
        return "";

    // `Clock.now`, not `Temporal.Now`: a stored PlainDateTime is in the CLOCK's frame (UTC by default,
    // Signum's TimeZoneMode), and Clock lives in the isomorphic data layer so both tiers read the same mode.
    const minutes = Math.round(date.since(Clock.now).total({ unit: "minutes" }));
    const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

    const abs = Math.abs(minutes);
    if (abs < 60) return format.format(minutes, "minute");
    if (abs < 60 * 24) return format.format(Math.round(minutes / 60), "hour");
    if (abs < 60 * 24 * 30) return format.format(Math.round(minutes / (60 * 24)), "day");
    if (abs < 60 * 24 * 365) return format.format(Math.round(minutes / (60 * 24 * 30)), "month");
    return format.format(Math.round(minutes / (60 * 24 * 365)), "year");
}

/** The same, for the ISO STRING a wire DTO carries (a DTO is not an entity, so nothing revives its dates). */
export function toRelativeTimeISO(isoDate: string | null | undefined): string {
    if (isoDate == null || isoDate === "")
        return "";

    return toRelativeTime(Temporal.PlainDateTime.from(isoDate.replace("Z", "")));
}
