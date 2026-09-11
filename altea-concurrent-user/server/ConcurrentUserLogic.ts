import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/fluentOperations"; // FluentInclude.withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { tryGetTypeInfo } from "@altea/altea/data/reflection";
import type { Entity, Type } from "@altea/altea/data/entity";
import { ConcurrentUserEntity, ConcurrentUserOperation } from "../data/ConcurrentUser";
import { ConcurrentUserServer } from "./ConcurrentUserServer";

// The module's `start(sb)`.
//
// Port of Signum.ConcurrentUser's ConcurrentUserLogic.cs — see port/ConcurrentUser.md.
export namespace ConcurrentUserLogic {

    /**
     * Which entity types get save/delete watching. MUST stay in sync with ConcurrentUserClient's
     * `activatedFor`.
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

        // No per-module TypeEntity delete cascade: it is derived for the whole schema from the
        // @implementedByAll discriminator COLUMNS — see TypeLogic's deleteImplementedByAllRowsOfType.

        if (sb.webBuilder)
            ConcurrentUserServer.start(sb.webBuilder, sb.schema);
    }
}
