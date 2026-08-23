import "@altea/altea/server";
import { Schema } from "@altea/altea/server/schema";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { Entity, type Type } from "@altea/altea/data/entity";
import { cleanTypeName } from "@altea/altea/data/registration";
import { Enum } from "@altea/altea/data/enum";
import {
    BasicPermission, TypeAllowed, TypeAllowedBasic,
    typeAllowedDB, typeAllowedUI, typeAllowedGet,
} from "@altea/altea-auth/data/Rules";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import type { WithConditions } from "@altea/altea-auth/server/WithConditions";
import type { MapColorProvider } from "./MapColorProvider.server";

// Port of Signum.Map's Schema/AuthColorProvider.cs — one colour provider PER ROLE, painting each table
// with that role's access to it: fill = the DB level, stroke = the UI level, tooltip = the fallback plus
// every condition rule. The paint itself is a linear GRADIENT built client-side from the names this file
// puts in `extra` (fallback first, then one band per condition rule), so a table whose access varies by
// row condition reads as a striped box rather than a single colour.
//
// altea divergences:
//  - `TypeAuthLogic.GetTypeRulesSimple(role)` has no counterpart, so the per-role rules are gathered by
//    asking `TypeAuthLogic.getAllowed(typeId, roleKey)` per (role, type) — the same information, one
//    lookup at a time, all served from the already-warm rule cache.
//  - `TypeAllowedBasic` is a NUMERIC enum here (Signum's is a string on the wire), so the gradient band
//    names come from the enum's member name and the tooltip from `Enum.niceName`.
//  - `WithConditions.Fallback` can't be null in altea (a merge always produces a value), so Signum's
//    "MERGE ERROR!" branch is unreachable and dropped. The client's `"Error"` gradient colour is kept —
//    it costs nothing and keeps the two palettes comparable.
export namespace AuthColorProvider {

    /** Signum's `AuthColorProvider.GetMapColors`. Answers nothing when the caller can't administer rules. */
    export async function getMapColors(): Promise<MapColorProvider[]> {
        if (!TypeAuthLogic.isStarted() || !await PermissionAuthLogic.isAuthorized(BasicPermission.AdminRules))
            return [];

        // Signum passes `includeTrivialMerge: false`: an auto-generated "A + B" merge role is a query-time
        // artefact, not something an administrator reasons about on a map.
        const roleGraph = await AuthLogic.roleGraph();
        const roles = roleGraph.rolesInOrder(false);

        const types = [...Schema.current.tables.entries()]
            .filter(([, t]) => !t.isView)
            .map(([ctor]) => ctor) as Type<Entity>[];

        const providers: MapColorProvider[] = [];

        for (const roleKey of roles) {
            // Resolved UP FRONT, because `addExtra` is synchronous (the reader applies it per table while
            // building the response) and altea's rule lookup is async. Signum builds the same dictionary.
            const rules = new Map<string, WithConditions<TypeAllowed>>();

            for (const ctor of types) {
                let typeId;
                try {
                    typeId = TypeLogic.typeToId(ctor);
                } catch {
                    continue; // not a persisted type / caches not loaded
                }
                rules.set(cleanTypeName(ctor), await TypeAuthLogic.getAllowed(typeId, roleKey));
            }

            const name = `role-${roleKey}`;

            providers.push({
                name,
                // Signum's `"Role - " + r.ToString()`: the role's NAME, not its lite key — `rolesInOrder`
                // hands back keys ("Role;3"), which is not what an administrator picks from a dropdown.
                niceName: `Role - ${roleGraph.rolesByKey.get(roleKey)?.name ?? roleKey}`,
                addExtra: table => {
                    const tac = rules.get(table.typeName);
                    if (tac == null)
                        return;

                    table.extra[`${name}-ui`] = gradientName(tac, true);
                    table.extra[`${name}-db`] = gradientName(tac, false);
                    table.extra[`${name}-tooltip`] = tooltip(tac);
                },
                // Signum's `Order = 10` — the auth providers sort after the built-in ones.
                order: 10,
            });
        }

        return providers;
    }

    /**
     * Signum's `GetName(ToStringList(tac, userInterface))` — `"auth-Write-None-Read"`: the fallback's level
     * followed by one per condition rule, in order. The client parses it back into gradient stops, so the
     * band NAMES must be the enum member names.
     */
    function gradientName(tac: WithConditions<TypeAllowed>, userInterface: boolean): string {
        const levels = [tac.fallback, ...tac.conditionRules.map(c => c.allowed)]
            .map(a => TypeAllowedBasic[typeAllowedGet(a, userInterface)]);

        return "auth-" + levels.join("-");
    }

    /** Signum's tooltip: the fallback on the first line, then `<conditions>: <allowed>` per rule. */
    function tooltip(tac: WithConditions<TypeAllowed>): string {
        const lines = [describe(tac.fallback)];

        for (const rule of tac.conditionRules)
            lines.push(`${rule.typeConditions.map(tc => tc.key.split(".").pop() ?? tc.key).join(" & ")}: ${describe(rule.allowed)}`);

        return lines.join("\n");
    }

    /** Signum's `ToString(TypeAllowed?)` — collapse to one name when DB and UI agree. */
    function describe(allowed: TypeAllowed): string {
        const db = typeAllowedDB(allowed);
        const ui = typeAllowedUI(allowed);

        if (db === ui)
            return Enum.niceName(TypeAllowedBasic, db);

        return `DB ${Enum.niceName(TypeAllowedBasic, db)} / UI ${Enum.niceName(TypeAllowedBasic, ui)}`;
    }
}
