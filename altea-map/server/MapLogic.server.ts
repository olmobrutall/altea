import "@altea/altea/server";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { OmniboxParser } from "@altea/altea-omnibox/server/OmniboxParser";
import { MapServer } from "./MapServer.server";
import { MapOmniboxResultGenerator } from "./MapOmniboxResultGenerator.server";

// Port of Signum.Map's MapLogic.cs. The module owns no tables: everything the two pages show is derived
// from the live Schema, the operation registry and the database's own catalog views — so `start` is only
// the routes, the built-in colour providers and the omnibox generator.
//
// altea divergence: `PermissionLogic.RegisterPermissions(MapPermission.ViewMap)` has no counterpart —
// SymbolLogic picks up every `init()`ed symbol, so declaring it in data/Map.ts is the registration.
export namespace MapLogic {

    let started = false;

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;

        if (sb.webBuilder != null) {
            MapServer.start(sb.webBuilder);

            // The predicate lives here rather than in the generator, exactly as in Signum: the module
            // decides which types are worth an operation map, and "has at least one operation" is it.
            OmniboxParser.generators.push(
                new MapOmniboxResultGenerator(type => OperationLogic.operationsForType(type).length > 0));
        }
    }
}
