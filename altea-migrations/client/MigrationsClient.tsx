import { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { SqlMigrationEntity, CSharpMigrationEntity, LoadMethodLogEntity } from "../data/Migrations";

// The client half of Signum.Migrations. Signum has no `MigrationsClient.tsx`: its three tables are reachable
// because the auto-generated `Signum.Migrations.ts` registers their Types, and their COLUMNS come from the
// server's `WithQuery(() => e => new { e.Id, e.VersionNumber, … })` projection.
//
// altea has neither half of that: a type is only known to the client once `cb.configure` names it (there is
// no generated registration file), and `withQuery()` takes no projection — default columns are a CLIENT
// setting. So this module exists to carry exactly what Signum's three WithQuery projections said, and
// registering it is also what makes /find/SqlMigration & co. work at all.
//
// No views: Signum ships none for these types either (there is no Templates folder in Signum.Migrations), so
// altea auto-generates one from the property routes. History rows are read, not edited.
export namespace MigrationsClient {
    export function start(cb: ClientBuilder): void {

        cb.configure(SqlMigrationEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.versionNumber),
                    token(a => a.comment),
                ],
            }));

        cb.configure(CSharpMigrationEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.uniqueName),
                    token(a => a.executionDate),
                ],
            }));

        cb.configure(LoadMethodLogEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.start),
                    token(a => a.end),
                    token(a => a.className),
                    token(a => a.methodName),
                    token(a => a.description),
                    token(a => a.exception),
                ],
            }));
    }
}
