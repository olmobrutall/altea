import { XMLParser } from "fast-xml-parser";
import { table } from "@altea/altea/server/table";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { getKey } from "@altea/altea/data/dynamicQuery/queryUtils";
import { cleanTypeName } from "@altea/altea/data/registration";
import { Replacements } from "@altea/altea/server/sync/synchronizer";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { OperationSymbol } from "@altea/altea/data/operations";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { AuthLogic } from "./AuthLogic";
import { TypeAuthLogic } from "./TypeAuthLogic";
import { PermissionAuthLogic } from "./PermissionAuthLogic";
import { OperationAuthLogic } from "./OperationAuthLogic";
import { QueryAuthLogic } from "./QueryAuthLogic";
import { PropertyAuthLogic } from "./PropertyAuthLogic";
import { RoleEntity } from "../data/Role";
import { MergeStrategy } from "../data/Role";
import {
    RuleTypeEntity, RulePermissionEntity, RuleQueryEntity, RuleOperationEntity, RulePropertyEntity,
    PermissionSymbol, TypeConditionSymbol,
    TypeAllowed, PropertyAllowed, OperationAllowed, QueryAllowed,
    WithConditionsModel, ConditionRuleModel,
    OperationWithConditionsModel, OperationConditionRuleModel,
    PropertyWithConditionsModel, PropertyConditionRuleModel,
} from "../data/Rules";

// Port of Signum's AuthLogic ImportExport (AuthLogic.cs ExportRules / ImportRulesScript + each cache's
// ExportXml / ImportXml). Reads/writes an `AuthRules.xml` compatible with Southwind's — one <Auth> document
// with a <Roles> section and one section per dimension (<Types>/<Permissions>/<Queries>/<Operations>/
// <Properties>), each grouping rules by role. Only OVERRIDES are exported: in altea a persisted Rule* row
// exists ONLY when it differs from the inherited base (set*RulePack deletes redundant rows), so the stored
// rows ARE the export set — no base recomputation needed.
//
// altea divergences from Signum's exact wire format (documented):
//  - Operation rows carry a `Type` attribute (Signum encodes (operation, type) in one Resource); altea's
//    rule is flattened to operation + type, so `Resource` = the operation key and `Type` = the clean type.
//  - Property rows carry a `Type` attribute + `Resource` = the PropertyString path (Signum uses a single
//    PropertyRoute string), because altea keys property rules by (rootType, path) with no PropertyRouteEntity.
//  - Query rows carry a `Type` attribute (the query's root type) so import can group by the per-type pack;
//    `Resource` is the query key, exactly like Signum (the extra attribute is additive/ignored by Signum).
//  - Import APPLIES directly (in the caller's transaction) via the verified set*RulePack machinery rather
//    than emitting a review SqlPreCommand script. Renames are resolved through `Replacements` (interactive
//    on a TTY, else the caller's autoReplacement — e.g. the terminal's no-rename default).
//  - Roles are NOT created by import (mirrors Signum: role creation is SynchronizeRoles' job). A role in the
//    XML with no DB match (after rename) is reported and its rules skipped.
export namespace AuthImportExport {

    export interface ImportResult {
        appliedRoles: string[];
        skippedRoles: string[];   // in the XML but not found in the DB (after rename)
        renames: { key: string; from: string; to: string }[];
    }

    const REPL = { roles: "AuthRules:Roles", type: "AuthRules:Type", cond: "AuthRules:TypeCondition", query: "AuthRules:Query", operation: "AuthRules:Operation" };

    // ---- Export ----------------------------------------------------------------------------------

    export async function exportAuthRules(): Promise<string> {
        const rolesByKey = (await AuthLogic.roleGraph()).rolesByKey;
        const orderedKeys = await AuthLogic.rolesInOrder(/* includeTrivialMerge */ false);
        const roleName = (key: string): string => rolesByKey.get(key)?.name ?? key;

        // id → display-name maps (resource identity is resolved from the logic, not the stored Lite toStr).
        const typeName = new Map((await table(TypeEntity).toArray() as TypeEntity[]).map(t => [String(t.id), t.cleanName]));
        const queryKey = new Map((await table(QueryEntity).toArray() as QueryEntity[]).map(q => [String(q.id), q.key]));
        const opKey = new Map(SymbolLogic.symbols(OperationSymbol).map(s => [String(s.id), s.key]));
        const permKey = new Map(SymbolLogic.symbols(PermissionSymbol).map(s => [String(s.id), s.key]));
        const condKey = new Map(SymbolLogic.symbols(TypeConditionSymbol).map(s => [String(s.id), s.key]));

        const condsXml = (rows: { order: unknown; allowed: number; conditions: { symbol: { id: PrimaryKey } }[] }[], enumName: (v: number) => string): string =>
            [...rows].sort((a, b) => Number(a.order) - Number(b.order)).map(cr =>
                `      <Condition Name="${attr(cr.conditions.map(c => condKey.get(String(c.symbol.id)) ?? String(c.symbol.id)).join(", "))}" Allowed="${enumName(cr.allowed)}" />`).join("\n");

        // Group each dimension's rows by role key.
        const groupByRole = <T extends { role: { key(): string } }>(rows: T[]): Map<string, T[]> => {
            const m = new Map<string, T[]>();
            for (const r of rows) { const k = r.role.key(); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
            return m;
        };

        const typeRows = groupByRole(await table(RuleTypeEntity).toArray() as RuleTypeEntity[]);
        const permRows = groupByRole(await table(RulePermissionEntity).toArray() as RulePermissionEntity[]);
        const queryRows = groupByRole(await table(RuleQueryEntity).toArray() as RuleQueryEntity[]);
        const opRows = groupByRole(await table(RuleOperationEntity).toArray() as RuleOperationEntity[]);
        const propRows = groupByRole(await table(RulePropertyEntity).toArray() as RulePropertyEntity[]);

        // A dimension section: <Section><Role Name="…"> …rows… </Role>…</Section>, roles in dependency order.
        const section = (name: string, byRole: Map<string, { role: { id: PrimaryKey } }[]>, rowXml: (r: never) => string): string => {
            const roleBlocks = orderedKeys
                .filter(k => (byRole.get(k)?.length ?? 0) > 0)
                .map(k => `    <Role Name="${attr(roleName(k))}">\n${(byRole.get(k)!).map(r => rowXml(r as never)).join("\n")}\n    </Role>`);
            return roleBlocks.length === 0 ? `  <${name} />` : `  <${name}>\n${roleBlocks.join("\n")}\n  </${name}>`;
        };

        const withInner = (open: string, inner: string): string => inner === "" ? `${open} />` : `${open}>\n${inner}\n      </${open.trimStart().split(" ")[0].slice(1)}>`;

        // <Roles> — needs async relatedTo per role, so build it explicitly (parents first).
        const roleLines: string[] = [];
        for (const k of orderedKeys) {
            const r = rolesByKey.get(k)!;
            const parents = [...await AuthLogic.relatedTo(k)].map(roleName).sort();
            const merge = await AuthLogic.getMergeStrategy(k);
            const attrs = [`Name="${attr(r.name)}"`];
            if (merge === MergeStrategy.Intersection) attrs.push(`MergeStrategy="Intersection"`);
            attrs.push(`Contains="${attr(parents.join(","))}"`);
            if (r.description != null && r.description !== "") attrs.push(`Description="${attr(r.description)}"`);
            roleLines.push(`    <Role ${attrs.join(" ")} />`);
        }

        const typesSection = section("Types", typeRows, (r: RuleTypeEntity) => {
            const open = `      <Type Resource="${attr(typeName.get(String(r.resource.id)) ?? String(r.resource.id))}" Allowed="${TypeAllowed[r.fallback]}"`;
            return withInner(open, condsXml(r.conditionRules, v => TypeAllowed[v]));
        });
        const permsSection = section("Permissions", permRows, (r: RulePermissionEntity) =>
            `      <Permission Resource="${attr(permKey.get(String(r.resource.id)) ?? String(r.resource.id))}" Allowed="${r.allowed ? "True" : "False"}" />`);
        const queriesSection = section("Queries", queryRows, (r: RuleQueryEntity) => {
            const qk = queryKey.get(String(r.resource.id)) ?? String(r.resource.id);
            return `      <Query OnType="${attr(queryRootType(qk) ?? "")}" Resource="${attr(qk)}" Allowed="${QueryAllowed[r.allowed]}" />`;
        });
        const opsSection = section("Operations", opRows, (r: RuleOperationEntity) => {
            const open = `      <Operation OnType="${attr(typeName.get(String(r.type.id)) ?? String(r.type.id))}" Resource="${attr(opKey.get(String(r.operation.id)) ?? String(r.operation.id))}" Allowed="${OperationAllowed[r.fallback]}"`;
            return withInner(open, condsXml(r.conditionRules, v => OperationAllowed[v]));
        });
        const propsSection = section("Properties", propRows, (r: RulePropertyEntity) => {
            const open = `      <Property OnType="${attr(typeName.get(String(r.rootType.id)) ?? String(r.rootType.id))}" Resource="${attr(r.path)}" Allowed="${PropertyAllowed[r.fallback]}"`;
            return withInner(open, condsXml(r.conditionRules, v => PropertyAllowed[v]));
        });

        const rolesBlock = roleLines.length === 0 ? `  <Roles />` : `  <Roles>\n${roleLines.join("\n")}\n  </Roles>`;
        return `<?xml version="1.0" encoding="utf-8"?>\n<Auth>\n${rolesBlock}\n${typesSection}\n${permsSection}\n${queriesSection}\n${opsSection}\n${propsSection}\n</Auth>\n`;
    }

    // The root type clean name of a query key (for the export `Type` grouping attribute), or undefined.
    function queryRootType(key: string): string | undefined {
        const qn = QueryLogic.tryGetQueryNameByKey(key);
        if (qn == null) return undefined;
        const ctor = QueryLogic.queries.tryGetCore(qn)?.getRootType();
        return ctor != null ? cleanTypeName(ctor) : undefined;
    }

    function attr(s: string): string {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    // ---- Import ----------------------------------------------------------------------------------

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
        isArray: name => ["Role", "Type", "Permission", "Query", "Operation", "Property", "Condition"].includes(name),
    });

    interface XmlCondition { Name: string; Allowed: string; }
    interface XmlRow { Resource: string; Allowed: string; OnType?: string; Condition?: XmlCondition[]; }
    interface XmlRoleBlock { Name: string; Type?: XmlRow[]; Permission?: XmlRow[]; Query?: XmlRow[]; Operation?: XmlRow[]; Property?: XmlRow[]; }

    /** Import an AuthRules XML, resolving renames via `replacements` and applying directly (in the caller's
     *  transaction) through set*RulePack. Roles are matched by name (not created). */
    export async function importAuthRules(xml: string, replacements: Replacements): Promise<ImportResult> {
        const doc = parser.parse(xml) as { Auth?: { Roles?: { Role?: { Name: string }[] }; Types?: { Role?: XmlRoleBlock[] }; Permissions?: { Role?: XmlRoleBlock[] }; Queries?: { Role?: XmlRoleBlock[] }; Operations?: { Role?: XmlRoleBlock[] }; Properties?: { Role?: XmlRoleBlock[] } } };
        const auth = doc.Auth ?? {};

        // ---- Role rename map --------------------------------------------------------------------
        const dbRoles = await table(RoleEntity).toArray() as RoleEntity[];
        const dbRoleByName = new Map(dbRoles.map(r => [r.name, r]));
        const xmlRoleNames = new Set((auth.Roles?.Role ?? []).map(r => r.Name));
        // Also collect role names that appear in the dimension sections (a section role may exist even if a
        // <Roles> entry was trimmed).
        for (const sec of [auth.Types, auth.Permissions, auth.Queries, auth.Operations, auth.Properties])
            for (const rb of sec?.Role ?? []) xmlRoleNames.add(rb.Name);
        replacements.askForReplacements(xmlRoleNames, new Set(dbRoleByName.keys()), REPL.roles);
        const resolveRole = (xmlName: string): RoleEntity | undefined => dbRoleByName.get(replacements.apply(REPL.roles, xmlName));

        // ---- Resource rename maps ---------------------------------------------------------------
        const dbTypeNames = new Set((await table(TypeEntity).toArray() as TypeEntity[]).map(t => t.cleanName));
        const condSymByKey = new Map(SymbolLogic.symbols(TypeConditionSymbol).map(s => [s.key, s]));
        const collect = (secs: (XmlRoleBlock[] | undefined)[], pick: (rb: XmlRoleBlock) => XmlRow[] | undefined, get: (r: XmlRow) => string | undefined): Set<string> => {
            const out = new Set<string>();
            for (const rbs of secs) for (const rb of rbs ?? []) for (const r of pick(rb) ?? []) { const v = get(r); if (v != null && v !== "") out.add(v); }
            return out;
        };
        replacements.askForReplacements(
            collect([auth.Types?.Role, auth.Operations?.Role, auth.Properties?.Role, auth.Queries?.Role],
                rb => rb.Type ?? rb.Operation ?? rb.Property ?? rb.Query, r => r.OnType ?? r.Resource),
            dbTypeNames, REPL.type);
        // Condition symbols from every <Condition Name="a, b"> across the conditioned dimensions.
        const condNames = new Set<string>();
        for (const sec of [auth.Types, auth.Operations, auth.Properties])
            for (const rb of sec?.Role ?? [])
                for (const r of rb.Type ?? rb.Operation ?? rb.Property ?? [])
                    for (const c of r.Condition ?? [])
                        for (const n of c.Name.split(",").map(s => s.trim()).filter(Boolean)) condNames.add(n);
        replacements.askForReplacements(condNames, new Set(condSymByKey.keys()), REPL.cond);

        const applyType = (xmlName: string): string => replacements.apply(REPL.type, xmlName);
        const applyCond = (xmlName: string): string => replacements.apply(REPL.cond, xmlName);

        const result: ImportResult = { appliedRoles: [], skippedRoles: [], renames: [] };
        for (const key of Object.values(REPL))
            for (const [from, to] of replacements.tryGetC(key) ?? [])
                if (from !== to) result.renames.push({ key, from, to });

        // ---- Condition-model builders -----------------------------------------------------------
        const condLites = (c: XmlCondition): { id: PrimaryKey; key: string }[] =>
            c.Name.split(",").map(s => s.trim()).filter(Boolean).map(n => {
                const s = condSymByKey.get(applyCond(n));
                if (s == null) throw new Error(`Import: TypeConditionSymbol '${n}' not found (after rename)`);
                return { id: s.id, key: s.key };
            });

        // ---- Per-role application ---------------------------------------------------------------
        const rolesInvolved = new Map<string, RoleEntity>();
        const noteRole = (xmlName: string): RoleEntity | undefined => {
            const r = resolveRole(xmlName);
            if (r == null) { if (!result.skippedRoles.includes(xmlName)) result.skippedRoles.push(xmlName); return undefined; }
            rolesInvolved.set(r.toLite().key(), r);
            return r;
        };

        // TYPES (per-role pack).
        for (const rb of auth.Types?.Role ?? []) {
            const role = noteRole(rb.Name); if (role == null) continue;
            const byResource = new Map((rb.Type ?? []).map(r => [applyType(r.Resource), r]));
            const pack = await TypeAuthLogic.getTypeRulePack(role.id);
            for (const rule of pack.rules) {
                const x = byResource.get(rule.resource.toString());
                rule.allowed = x != null
                    ? WithConditionsModel.create({
                        fallback: parseEnum(TypeAllowed, x.Allowed),
                        conditionRules: (x.Condition ?? []).map(c => ConditionRuleModel.create({
                            allowed: parseEnum(TypeAllowed, c.Allowed),
                            typeConditions: condLites(c).map(l => TypeConditionSymbol.newLite(l.id, l.key)),
                        })),
                    })
                    : cloneType(rule.allowedBase);
            }
            await TypeAuthLogic.setTypeRulePack(pack);
        }

        // PERMISSIONS (per-role pack).
        for (const rb of auth.Permissions?.Role ?? []) {
            const role = noteRole(rb.Name); if (role == null) continue;
            const byResource = new Map((rb.Permission ?? []).map(r => [r.Resource, r])); // permissions aren't renamed here
            const pack = await PermissionAuthLogic.getPermissionRulePack(role.id);
            for (const rule of pack.rules) {
                const x = byResource.get(rule.resource.toString());
                rule.allowed = x != null ? parseBool(x.Allowed) : rule.allowedBase;
            }
            await PermissionAuthLogic.setPermissionRulePack(pack);
        }

        // The per-TYPE dimensions (query / operation / property): group the XML rows by target type, and for
        // EACH type that appears in the XML OR currently has rows for the role, fetch the pack, overlay, set.
        await applyPerType(auth.Queries?.Role, "Query", noteRole, applyType, async (role, typeName, byKey) => {
            const pack = await QueryAuthLogic.getQueryRulePack(typeName, role.id);
            for (const rule of pack.rules) {
                const x = byKey.get(rule.resource.toString());
                rule.allowed = x != null ? parseEnum(QueryAllowed, x.Allowed) : rule.allowedBase;
            }
            await QueryAuthLogic.setQueryRulePack(pack);
        }, r => r.Resource);

        await applyPerType(auth.Operations?.Role, "Operation", noteRole, applyType, async (role, typeName, byKey) => {
            const pack = await OperationAuthLogic.getOperationRulePack(typeName, role.id);
            for (const rule of pack.rules) {
                const x = byKey.get(rule.operation.toString());
                rule.allowed = x != null
                    ? OperationWithConditionsModel.create({
                        fallback: parseEnum(OperationAllowed, x.Allowed),
                        conditionRules: (x.Condition ?? []).map(c => OperationConditionRuleModel.create({
                            allowed: parseEnum(OperationAllowed, c.Allowed),
                            typeConditions: condLites(c).map(l => TypeConditionSymbol.newLite(l.id, l.key)),
                        })),
                    })
                    : cloneOp(rule.allowedBase);
            }
            await OperationAuthLogic.setOperationRulePack(pack);
        }, r => r.Resource);

        await applyPerType(auth.Properties?.Role, "Property", noteRole, applyType, async (role, typeName, byKey) => {
            const pack = await PropertyAuthLogic.getPropertyRulePack(typeName, role.id);
            for (const rule of pack.rules) {
                const x = byKey.get(rule.path);
                rule.allowed = x != null
                    ? PropertyWithConditionsModel.create({
                        fallback: parseEnum(PropertyAllowed, x.Allowed),
                        conditionRules: (x.Condition ?? []).map(c => PropertyConditionRuleModel.create({
                            allowed: parseEnum(PropertyAllowed, c.Allowed),
                            typeConditions: condLites(c).map(l => TypeConditionSymbol.newLite(l.id, l.key)),
                        })),
                    })
                    : cloneProp(rule.allowedBase);
            }
            await PropertyAuthLogic.setPropertyRulePack(pack);
        }, r => r.Resource);

        result.appliedRoles = [...rolesInvolved.values()].map(r => r.name);
        return result;
    }

    // Apply a per-TYPE dimension: for each role, group its XML rows by target type (the `Type` attr) and by
    // the row's identity key; also visit every type that CURRENTLY has a rule for the role (so absent rows
    // are reset to base → deleted — a true sync). `identity` picks the per-row match key within a type.
    async function applyPerType(
        roleBlocks: XmlRoleBlock[] | undefined,
        elem: "Query" | "Operation" | "Property",
        noteRole: (name: string) => RoleEntity | undefined,
        applyType: (name: string) => string,
        apply: (role: RoleEntity, typeName: string, byKey: Map<string, XmlRow>) => Promise<void>,
        identity: (r: XmlRow) => string,
    ): Promise<void> {
        for (const rb of roleBlocks ?? []) {
            const role = noteRole(rb.Name); if (role == null) continue;
            const rows = (rb as unknown as Record<string, XmlRow[]>)[elem] ?? [];
            const byType = new Map<string, Map<string, XmlRow>>();
            for (const r of rows) {
                const tn = applyType(r.OnType ?? r.Resource);
                let m = byType.get(tn); if (m == null) byType.set(tn, m = new Map());
                m.set(identity(r), r);
            }
            for (const [typeName, byKey] of byType)
                await apply(role, typeName, byKey);
        }
    }

    function parseEnum<E extends Record<string, string | number>>(enumObj: E, name: string): E[keyof E] {
        const v = (enumObj as Record<string, unknown>)[name.trim()];
        if (typeof v !== "number")
            throw new Error(`Import: '${name}' is not a valid ${Object.keys(enumObj).filter(k => isNaN(Number(k)))[0] ?? "enum"} value`);
        return v as E[keyof E];
    }
    function parseBool(s: string): boolean {
        return s.trim().toLowerCase() === "true";
    }
    // Deep-clone each dimension's WithConditionsModel (so resetting a rule to its base doesn't alias the
    // base graph). Concrete per dimension (altea has no generic entities).
    const cloneType = (m: WithConditionsModel): WithConditionsModel => WithConditionsModel.create({
        fallback: m.fallback,
        conditionRules: m.conditionRules.map(cr => ConditionRuleModel.create({ allowed: cr.allowed, typeConditions: [...cr.typeConditions] })),
    });
    const cloneOp = (m: OperationWithConditionsModel): OperationWithConditionsModel => OperationWithConditionsModel.create({
        fallback: m.fallback,
        conditionRules: m.conditionRules.map(cr => OperationConditionRuleModel.create({ allowed: cr.allowed, typeConditions: [...cr.typeConditions] })),
    });
    const cloneProp = (m: PropertyWithConditionsModel): PropertyWithConditionsModel => PropertyWithConditionsModel.create({
        fallback: m.fallback,
        conditionRules: m.conditionRules.map(cr => PropertyConditionRuleModel.create({ allowed: cr.allowed, typeConditions: [...cr.typeConditions] })),
    });
}
