import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/fluentOperations"; // FluentInclude.withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { tryGetTypeInfo } from "@altea/altea/data/reflection";
import type { Entity, Type } from "@altea/altea/data/entity";
import { ConcurrentUserEntity, ConcurrentUserOperation } from "../data/ConcurrentUser";
import { ConcurrentUserServer } from "./ConcurrentUserServer";

// Port of Signum.ConcurrentUser's ConcurrentUserLogic.cs — the module's `start(sb)`.
//
// altea divergences, documented inline:
//  - `EntityKindCache.GetEntityKind(t)` → `tryGetTypeInfo(t).entityKind` (what `@entity(kind, data)`
//    stamped on the constructor), with the same default predicate.
//  - Signum's `PreDeleteSqlSync` cascade on TypeEntity is NOT registered here: altea derives one for the
//    WHOLE schema from the @implementedByAll discriminator columns, so no module has to name its own
//    field (see TypeLogic's deleteImplementedByAllRowsOfType).
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

        // NOT registered here: Signum's `EntityEvents<TypeEntity>.PreDeleteSqlSync`, which takes this
        // table's presence rows with a type that no longer exists. altea derives it for the whole schema
        // from the discriminator COLUMNS instead of asking each module to name its own field — see
        // TypeLogic's deleteImplementedByAllRowsOfType.

        if (sb.webBuilder)
            ConcurrentUserServer.start(sb.webBuilder, sb.schema);
    }
}
