import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { table } from "@altea/altea/server/table";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { Replacements } from "@altea/altea/server/sync/synchronizer";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { AuthLogic } from "./AuthLogic";
import { RoleEntity, MergeStrategy } from "../data/Role";
import { TypeConditionSymbol } from "../data/Rules";
import { ATTR, attrs, type AuthImportCtx, type XmlRoleBlock } from "./AuthRulesXml";

// Port of Signum's AuthLogic ImportExport (AuthLogic.cs ExportRules / ImportRulesScript). One `<Auth>`
// document — a `<Roles>` section this file owns + one section per dimension, each dimension owning its own
// block via the `AuthLogic.registerXmlExporter` / `registerXmlImporter` handlers (Signum's ExportToXml /
// ImportFromXml multicast events). This orchestrator writes `<Roles>`, assembles the document with
// fast-xml-parser's XMLBuilder, and on import reconciles the role graph + resource RENAMES centrally
// (Replacements), then fans out to each dimension's importer.
//
// altea divergences from Signum's exact wire format (documented, unchanged from the previous port):
//  - Operation/Query/Property rows carry an `OnType` attribute (altea keys those rules by (type, …)).
//  - Property rows use `Resource` = the PropertyString path (no PropertyRouteEntity).
//  - Import APPLIES directly (in the caller's transaction) via each dimension's verified set*RulePack,
//    rather than emitting a review SqlPreCommand. Roles are NOT created (matched by name, rename-aware).
export namespace AuthImportExport {

    export interface ImportResult {
        appliedRoles: string[];
        skippedRoles: string[];   // in the XML but not found in the DB (after rename)
        renames: { key: string; from: string; to: string }[];
    }

    const REPL = { roles: "AuthRules:Roles", type: "AuthRules:Type", cond: "AuthRules:TypeCondition" };

    // ---- Export ----------------------------------------------------------------------------------

    const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: ATTR, format: true, suppressEmptyNode: true });

    export async function exportAuthRules(): Promise<string> {
        const rolesByKey = (await AuthLogic.roleGraph()).rolesByKey;
        const orderedRoleKeys = await AuthLogic.rolesInOrder(/* includeTrivialMerge */ false);
        const roleName = (key: string): string => rolesByKey.get(key)?.name ?? key;

        // <Roles> — parents (Contains) need async relatedTo per role, so build it explicitly (parents first).
        const roleObjs: Record<string, unknown>[] = [];
        for (const k of orderedRoleKeys) {
            const r = rolesByKey.get(k)!;
            const parents = [...await AuthLogic.relatedTo(k)].map(roleName).sort();
            const merge = await AuthLogic.getMergeStrategy(k);
            roleObjs.push(attrs({
                Name: r.name,
                MergeStrategy: merge === MergeStrategy.Intersection ? "Intersection" : undefined,
                Contains: parents.join(","),
                Description: r.description != null && r.description !== "" ? r.description : undefined,
            }));
        }

        // Each dimension contributes its section (Signum's ExportToXml handlers), ordered by section name.
        const auth: Record<string, unknown> = { Roles: roleObjs.length ? { Role: roleObjs } : {} };
        const sections = await Promise.all(AuthLogic.xmlExportersInOrder().map(e => e({ orderedRoleKeys, roleName })));
        for (const { name, content } of sections.sort((a, b) => a.name.localeCompare(b.name)))
            auth[name] = content;

        return `<?xml version="1.0" encoding="utf-8"?>\n${builder.build({ Auth: auth })}`;
    }

    // ---- Import ----------------------------------------------------------------------------------

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
        isArray: name => ["Role", "Type", "Permission", "Query", "Operation", "Property", "Condition"].includes(name),
    });

    /** Import an AuthRules XML, resolving renames via `replacements` and applying directly (in the caller's
     *  transaction) through each dimension's importer. Roles are matched by name (not created). */
    export async function importAuthRules(xml: string, replacements: Replacements): Promise<ImportResult> {
        const doc = parser.parse(xml) as { Auth?: Record<string, { Role?: XmlRoleBlock[] }> };
        const auth = (doc.Auth ?? {}) as Record<string, { Role?: XmlRoleBlock[] } | undefined>;

        // Every element row across every dimension section (skipping <Roles>) — the orchestrator stays
        // generic by treating a role block's non-`Name` array keys as its rows.
        const eachRow = function* (): Generator<{ section: string; row: Record<string, unknown> }> {
            for (const section of Object.keys(auth)) {
                if (section === "Roles") continue;
                for (const rb of auth[section]?.Role ?? [])
                    for (const [k, v] of Object.entries(rb))
                        if (k !== "Name" && Array.isArray(v))
                            for (const row of v as Record<string, unknown>[]) yield { section, row };
            }
        };

        // ---- Role rename map --------------------------------------------------------------------
        const dbRoleByName = new Map((await table(RoleEntity).toArray() as RoleEntity[]).map(r => [r.name, r]));
        const xmlRoleNames = new Set((auth.Roles?.Role ?? []).map(r => r.Name));
        for (const section of Object.keys(auth))
            if (section !== "Roles")
                for (const rb of auth[section]?.Role ?? []) xmlRoleNames.add(rb.Name);
        replacements.askForReplacements(xmlRoleNames, new Set(dbRoleByName.keys()), REPL.roles);
        const resolveRole = (xmlName: string): RoleEntity | undefined => dbRoleByName.get(replacements.apply(REPL.roles, xmlName));

        // ---- Resource rename maps (types + condition symbols), collected generically ------------
        const dbTypeNames = new Set((await table(TypeEntity).toArray() as TypeEntity[]).map(t => t.cleanName));
        const condSymByKey = new Map(SymbolLogic.symbols(TypeConditionSymbol).map(s => [s.key, s]));
        const typeNames = new Set<string>();
        const condNames = new Set<string>();
        for (const { section, row } of eachRow()) {
            const onType = row.OnType as string | undefined;
            if (onType != null && onType !== "") typeNames.add(onType);
            if (section === "Types" && typeof row.Resource === "string") typeNames.add(row.Resource);
            for (const c of (row.Condition as { Name: string }[] | undefined) ?? [])
                for (const n of c.Name.split(",").map(s => s.trim()).filter(Boolean)) condNames.add(n);
        }
        replacements.askForReplacements(typeNames, dbTypeNames, REPL.type);
        replacements.askForReplacements(condNames, new Set(condSymByKey.keys()), REPL.cond);

        // ---- Per-dimension application (each registered importer) --------------------------------
        const result: ImportResult = { appliedRoles: [], skippedRoles: [], renames: [] };
        for (const key of Object.values(REPL))
            for (const [from, to] of replacements.tryGetC(key) ?? [])
                if (from !== to) result.renames.push({ key, from, to });

        const rolesInvolved = new Map<string, RoleEntity>();
        const ctx: AuthImportCtx = {
            noteRole: (xmlName: string): RoleEntity | undefined => {
                const r = resolveRole(xmlName);
                if (r == null) { if (!result.skippedRoles.includes(xmlName)) result.skippedRoles.push(xmlName); return undefined; }
                rolesInvolved.set(r.toLite().key(), r);
                return r;
            },
            applyType: (xmlName: string) => replacements.apply(REPL.type, xmlName),
            applyCond: (xmlName: string) => replacements.apply(REPL.cond, xmlName),
            condSymByKey,
            replacements,
        };

        for (const importer of AuthLogic.xmlImporters())
            await importer(auth as Record<string, unknown>, ctx);

        result.appliedRoles = [...rolesInvolved.values()].map(r => r.name);
        return result;
    }
}
