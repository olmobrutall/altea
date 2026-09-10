import { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { SqlMigrationEntity, CSharpMigrationEntity, LoadMethodLogEntity } from "../data/Migrations";

// The client half: what makes /find/SqlMigration & co. work at all, since a type is only known to the
// client once `cb.configure` names it — and the default columns, since `withQuery()` takes no projection.
//
// No views: a history row is read, not edited, so the auto-generated one from the property routes does.
//
// See docs/port/Migrations.md.
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
