import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude"; // FluentInclude.withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { Schema } from "@altea/altea/server/schema/schema";
import { Connector } from "@altea/altea/server/connection/connector";
import { SqlPreCommandSimple, type SqlPreCommand } from "@altea/altea/server/sync/sqlPreCommand";
import { FieldImplementedByAll } from "@altea/altea/server/schema/field";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { tryGetTypeInfo } from "@altea/altea/data/reflection";
import type { Entity, Type } from "@altea/altea/data/entity";
import { ConcurrentUserEntity, ConcurrentUserOperation } from "../data/ConcurrentUser";
import { ConcurrentUserServer } from "./ConcurrentUserServer.server";

// Port of Signum.ConcurrentUser's ConcurrentUserLogic.cs — the module's `start(sb)`.
//
// altea divergences, documented inline:
//  - `EntityKindCache.GetEntityKind(t)` → `tryGetTypeInfo(t).entityKind` (what `@entity(kind, data)`
//    stamped on the constructor), with the same default predicate.
//  - the `PreDeleteSqlSync` cascade on TypeEntity is hand-built SQL against the @implementedByAll
//    DISCRIMINATOR column rather than `Administrator.UnsafeDeletePreCommand(…)` over a LINQ query:
//    altea's sync scripts are emitted with no live connection, and `targetEntity.EntityType.ToTypeEntity()`
//    has no altea counterpart. The column is found structurally (FieldImplementedByAll.typeColumn), so a
//    rename of the field or the column can't silently break it.
export namespace ConcurrentUserLogic {

    /**
     * Signum's `WatchSaveFor` — which entity types get save/delete watching. MUST stay in sync with
     * ConcurrentUserClient's `activatedFor` (as Signum's comment says).
     */
    export let watchSaveFor: (type: Type<Entity>) => boolean = defaultWatchSaveFor;

    function defaultWatchSaveFor(type: Type<Entity>): boolean {
        const kind = tryGetTypeInfo(type)?.entityKind;
        return !(kind === "System" || kind === "SystemString");
    }

    export function start(sb: SchemaBuilder, activatedFor?: (type: Type<Entity>) => boolean): void {
        if (sb.alreadyDefined(start))
            return;

        watchSaveFor = activatedFor ?? defaultWatchSaveFor;

        sb.include(ConcurrentUserEntity)
            .withIndex(a => a.connectionID)
            .withUniqueIndex(a => [a.connectionID, a.user, a.startTime, a.targetEntity])
            .withDelete(ConcurrentUserOperation.Delete)
            .withQuery();

        // Deleting a TypeEntity row (a type that no longer exists) must take its presence rows with it,
        // or the @implementedByAll discriminator dangles.
        sb.schema.entityEvents(TypeEntity).preDeleteSqlSync.push(type => deleteRowsOfType(sb.schema, type));

        if (sb.webBuilder)
            ConcurrentUserServer.start(sb.webBuilder, sb.schema);
    }

    function deleteRowsOfType(schema: Schema, type: TypeEntity): SqlPreCommand | undefined {
        const table = schema.tryTable(ConcurrentUserEntity);
        if (table == null)
            return undefined;

        const field = table.fields["targetEntity"]?.field;
        if (!(field instanceof FieldImplementedByAll))
            return undefined;

        const sb = Connector.current().sqlBuilder;
        return new SqlPreCommandSimple(
            `DELETE FROM ${sb.objectName(table.name)} WHERE ${sb.sqlEscape(field.typeColumn.name)} = ${type.id};`);
    }
}
