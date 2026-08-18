import { TypeLogic } from "@altea/altea/server/typeLogic";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import { QueryAuthLogic } from "@altea/altea-auth/server/QueryAuthLogic";
import { TypeAllowedBasic } from "@altea/altea-auth/data/Rules";

// The authorization adapters the generators use.
//
// Signum filtered inline with SYNCHRONOUS predicates — `Schema.Current.IsAllowed(type, inUserInterface:
// true) == null` and `QueryLogic.Queries.QueryAllowed(qn, true)` — passed straight into
// `OmniboxUtils.Matches(values, filter, …)`. altea's authorization reads a ResetLazy rule cache and is
// therefore ASYNC, while the matcher must stay synchronous (it is a generator over a dictionary).
// So each generator resolves the allowed SET up front (one pass over the candidate list) and hands the
// matcher a plain `Set.has` predicate. Same semantics, one await earlier.
//
// Both helpers are permissive when their auth module isn't started (altea-test / a host without
// authorization): the omnibox then shows everything, exactly as an unsecured Signum app does.

/** Signum's `Schema.Current.IsAllowed(type, inUserInterface: true) == null` — coarse UI-Read. */
export async function allowedTypeFilter(candidates: Function[]): Promise<(type: Function) => boolean> {
    if (!TypeAuthLogic.isStarted())
        return () => true;

    const allowed = new Set<Function>();
    for (const ctor of candidates) {
        let typeId;
        try {
            typeId = TypeLogic.typeToId(ctor);
        } catch {
            continue; // not a persisted type (or the type caches aren't loaded) — hide it
        }
        if (await TypeAuthLogic.isAllowedForType(typeId, TypeAllowedBasic.Read, true))
            allowed.add(ctor);
    }
    return type => allowed.has(type);
}

/** Signum's `QueryLogic.Queries.QueryAllowed(queryName, fullScreen: true)`. */
export async function allowedQueryFilter(candidates: QueryName[]): Promise<(queryName: QueryName) => boolean> {
    if (!QueryAuthLogic.isStarted())
        return () => true;

    const allowed = new Set<QueryName>();
    for (const qn of candidates) {
        try {
            if (await QueryAuthLogic.isQueryAllowed(qn, true))
                allowed.add(qn);
        } catch {
            // Unseeded query (the QueryEntity rows are generated on sync) — don't gate on a missing row.
            allowed.add(qn);
        }
    }
    return qn => allowed.has(qn);
}
