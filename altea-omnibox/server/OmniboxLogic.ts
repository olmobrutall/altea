import type { SchemaBuilder } from "@altea/altea/server/schema";
// Importing the message/permission module evaluates its `init()` declaration, registering
// OmniboxPermission.ViewOmnibox in the declared-symbols set that SymbolLogic.start(sb, PermissionSymbol)
// — already called by the auth module — seeds. So it lands in the PermissionSymbol table and is
// authorizable without any extra SymbolLogic.start here (which would double-start). This is altea's
// equivalent of Signum's `PermissionLogic.RegisterTypes(typeof(OmniboxPermission))`.
import "../data/OmniboxMessages";
import { OmniboxParser, type OmniboxResultGenerator } from "./OmniboxParser";
import { OmniboxServer } from "./OmniboxServer";
import { EntityOmniboxResultGenerator } from "./EntityOmniboxResultGenerator";
import { DynamicQueryOmniboxResultGenerator } from "./DynamicQueryOmniboxResultGenerator";
import { SpecialOmniboxGenerator } from "./SpecialOmniboxResultGenerator";

// Port of Signum's `OmniboxLogic.Start` (Signum.Omnibox/OmniboxLogic.cs). The module declares no entities
// (its only persisted artefact is the ViewOmnibox permission symbol, seeded via the import above), so
// start() registers the three built-in result generators and mounts the HTTP surface when a web host is
// present — mirroring `if (sb.WebServerBuilder != null) { OmniboxServer.Start(…); Generators.Add(…); }`.
//
// Order matters only for stable output on ties: Signum registers Entity, DynamicQuery, Special and the
// combined results are sorted by distance afterwards.
export namespace OmniboxLogic {
    export function start(sb: SchemaBuilder, generators: OmniboxResultGenerator[] = []): void {
        if (sb.alreadyDefined(start))
            return;

        if (sb.webBuilder) {
            OmniboxServer.start(sb.webBuilder);

            OmniboxParser.generators.push(new EntityOmniboxResultGenerator());
            OmniboxParser.generators.push(new DynamicQueryOmniboxResultGenerator());
            OmniboxParser.generators.push(new SpecialOmniboxGenerator());

            // Signum's `OmniboxServer.Start(wsb, params IOmniboxResultGenerator[] generators)` — an app or
            // another module can contribute its own shapes (Signum.Chart's chart omnibox, …).
            OmniboxParser.generators.push(...generators);
        }
    }
}
