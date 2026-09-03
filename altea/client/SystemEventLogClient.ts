import type { ClientBuilder } from './ClientBuilder';
import { SystemEventLogEntity } from '../data/systemEventLog';

// The client half of core's SystemEventLog (see ../data/systemEventLog): only the search page's default
// columns, which is all Signum's server-side `WithQuery` projection amounts to (altea's server
// registration takes no projection — there is no QueryDescription).
//
// No view and no route: a row is written by the engine and never edited, so the SEARCH page is the whole
// UI. Registered from the app's MainAdmin, the shape CultureInfoClient uses for the same reason — a
// ClientBuilder is what carries the query settings, and core has no `start(cb)` of its own to hang it on.

export namespace SystemEventLogClient {
    export function start(cb: ClientBuilder): void {
        cb.configure(SystemEventLogEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.date),
                    token(a => a.machineName),
                    token(a => a.eventType),
                    token(a => a.exception),
                ],
            }));
    }
}
