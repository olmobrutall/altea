import { TypeLogic } from "@altea/altea/server/typeLogic";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import { QueryAuthLogic } from "@altea/altea-auth/server/QueryAuthLogic";
import { TypeAllowedBasic } from "@altea/altea-auth/data/Rules";

// The authorization adapters the generators use.
//
// Authorization reads a ResetLazy rule cache and is therefore ASYNC, while the MATCHER must stay
// synchronous (it is a generator over a dictionary). So each generator resolves the allowed SET up front,
// in one pass over the candidate list, and hands the matcher a plain `Set.has` predicate.
//
// Both helpers are PERMISSIVE when their auth module is not started (a host without authorization): the
// omnibox then shows everything, as an unsecured application should.

/** Coarse UI-Read. */
export async function allowedTypeFilter(candidates: Function[]): Promise<(type: Function) => boolean> {
    if (!TypeAuthLogic.isStarted())
        return () => true;

    const allowed = new Set<Function>();
    const caches = await TypeLogic.caches();
    for (const ctor of candidates) {
        const typeId = caches.tryTypeToId(ctor);
        if (typeId == null)
            continue; // not a persisted type — hide it
        if (await TypeAuthLogic.isAllowedForType(typeId, TypeAllowedBasic.Read, true))
            allowed.add(ctor);
    }
    return type => allowed.has(type);
}

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
