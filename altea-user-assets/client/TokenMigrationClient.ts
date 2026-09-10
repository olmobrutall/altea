import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { TokenMigrationEntity } from "../data/TokenMigration";

// The client half of token migrations (see ../data/TokenMigration): the search page's default columns,
// and nothing else.
//
// No view and no route: a row is written by the runner and never edited, so the SEARCH page is the whole
// UI — "which token migrations has this database run?", the same question the SQL migration table answers
// for the schema. Registered from the app's MainAdmin, the shape CultureInfoClient uses.

export namespace TokenMigrationClient {
    export function start(cb: ClientBuilder): void {
        cb.configure(TokenMigrationEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.versionNumber),
                    token(a => a.comment),
                ],
            }));
    }
}
