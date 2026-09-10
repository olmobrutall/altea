import type { ClientBuilder } from './ClientBuilder';
import { TypeEntity, TypeEntityMessage } from '../data/typeEntity';

// The client half of core's TypeEntity (see ../data/typeEntity): the search page's default columns, and
// the one thing this module exists for — a pinned filter that keeps `@part` rows OUT of a type picker
// by default.
//
// NEW here; Signum has no counterpart, because it has no such rows to hide. altea models a Signum MList
// element and several owned embeddeds as `@part` ENTITIES with tables of their own, so the type table
// carries ~100 rows naming something that is only ever reached through the entity that owns it. The
// picker `EntityBase.chooseType` opens for an `@implementedByAll` reference (`Finder.find(TypeEntity)`)
// listed every one of them, and none is a sensible answer there.
//
// It is a FILTER, not a hidden row: it goes into the query REQUEST, so paging and the total count are the
// server's and stay honest — which a predicate over the rows a page happened to return could not manage.
// And it is REMOVABLE: `NotCheckbox_Unchecked` renders a checkbox that is unticked while the filter
// applies, so an admin who does want the part rows ticks "Include Part entities" and the filter is
// dropped from the next request.
//
// Started by `ClientBuilder.startFramework`, NOT by the app's MainAdmin as CultureInfoClient and
// SystemEventLogClient are. Those two configure an opt-in PAGE; this configures a picker the framework
// itself opens, so an app that forgot the call would get part rows in every polymorphic reference. The
// settings are inert in an app that never registers the Type query.
export namespace TypeEntityClient {
    export function start(cb: ClientBuilder): void {
        cb.configure(TypeEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.cleanName),
                    token(a => a.className),
                    token(a => a.tableName),
                    token(a => a.package),
                ],
                defaultFilters: [{
                    token: token(a => a.isPart),
                    operation: "EqualTo",
                    value: false,
                    pinned: {
                        label: () => TypeEntityMessage.IncludePartEntities.niceToString(),
                        active: "NotCheckbox_Unchecked",
                    },
                }],
            }));
    }
}
