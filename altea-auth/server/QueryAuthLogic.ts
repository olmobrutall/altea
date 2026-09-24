import "@altea/altea/server"; // Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // withQuery
import { SchemaBuilder } from "@altea/altea/server/schema";
import { ResetLazy } from "@altea/altea/server/resetLazy";
import { table } from "@altea/altea/server/table";
import { Entity, type PrimaryKey } from "@altea/altea/data/entity";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { getKey, type QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { TypeLogic, type TypeCaches } from "@altea/altea/server/typeLogic";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { SearchMessage } from "@altea/altea/data/uiMessages";
import { AuthLogic, RoleGraph } from "./AuthLogic";
import { TypeAuthLogic } from "./TypeAuthLogic";
import { MergeStrategy, RoleEntity } from "../data/Role";
import { RuleQueryEntity, RuleTypeEntity, RulePermissionEntity, QueryRulePack, QueryAllowedRule, QueryAllowed, TypeAllowedBasic } from "../data/Rules";
import { PermissionAuthLogic } from "./PermissionAuthLogic";
import { BasicPermission } from "@altea/altea/data/permissionSymbol";
import { maxBound } from "./WithConditions";
import { section, groupByRole, attrs, parseEnum, parseBool, enumName, sectionRows, syncRulesScript, updateAllowed, type AuthImportCtx } from "./AuthRulesXml";
import type { SqlPreCommand } from "@altea/altea/server/sync/sqlPreCommand";
import type { AuthExportCtx } from "./AuthLogic";

// Port of Signum.Authorization's Rules/QueryAuthLogic.cs — see port/Auth.md.
//
// The query dimension: a role's allowance per
// query is a 3-valued QueryAllowed (None → hidden/non-executable; EmbeddedOnly → embedded search only,
// hidden from the full-screen search page; Allow → everywhere). Enforcement gate (`dqm_AllowQuery`):
// `allowed === Allow || (allowed === EmbeddedOnly && !fullScreen)`. The server executes with
// fullScreen:false (so it only blocks None); the full-screen distinction is a client concern.
//
// Prerequisite: QueryLogic.start (QueryEntity row seeding + key↔entity cache) — invoked from start below.
// altea divergences (mirroring the other dimensions): async cache via sb.globalLazy + computeAllowed,
// keyed by the QueryEntity id; merge Union-max/Intersection-min, and Signum's automatic upgrade: with
// AutomaticUpgradeOfQueries a query with no rule follows its entity type's readability, up to its
// MaxAutomaticUpgrade.
const mergeQuery = (strategy: MergeStrategy, baseValues: QueryAllowed[]): QueryAllowed =>
    strategy === MergeStrategy.Union
        ? baseValues.reduce((a, b) => Math.max(a, b), QueryAllowed.None)
        : baseValues.reduce((a, b) => Math.min(a, b), QueryAllowed.Allow);

// Port of Signum's QueryCache: raw per-role query rules + role graph + the captured type-rule cache (a
// query follows its entity type's readability) + the merged memo, folded synchronously.
class QueryRulesCache {
    private readonly computed = new Map<string, Map<string, QueryAllowed>>();
    constructor(
        private readonly rules: Map<string, Map<PrimaryKey, QueryAllowed>>,
        private readonly graph: RoleGraph,
        private readonly typeCache: TypeAuthLogic.TypeRulesCache,
        private readonly autoUpgradeAllowed: (roleKey: string) => boolean,
    ) { }

    // Signum's GetDefault: Allow when the role can read the query's entity type.
    private fromType(rootTypeId: PrimaryKey | undefined, caches: TypeCaches, roleKey: string): QueryAllowed {
        return rootTypeId != null && maxBound(this.typeCache.getAllowed(rootTypeId, caches, roleKey), true) >= TypeAllowedBasic.Read
            ? QueryAllowed.Allow
            : QueryAllowed.None;
    }

    // Signum's GetDefaultValue: the value of a role with no rule and no base role.
    private queryDefault(queryId: PrimaryKey, rootTypeId: PrimaryKey | undefined, caches: TypeCaches, roleKey: string): QueryAllowed {
        if (this.graph.getDefaultAllowed(roleKey))
            return QueryAllowed.Allow;
        if (!this.autoUpgradeAllowed(roleKey))
            return QueryAllowed.None;
        const def = this.fromType(rootTypeId, caches, roleKey);
        const maxUp = QueryAuthLogic.maxAutomaticUpgradeOf(queryId);
        return maxUp != null && maxUp <= def ? maxUp : def;
    }

    getAllowed(queryId: PrimaryKey, rootTid: PrimaryKey | undefined, caches: TypeCaches, roleKey: string): QueryAllowed {
        let inner = this.computed.get(roleKey);
        if (inner == null)
            this.computed.set(roleKey, inner = new Map());
        const key = String(queryId);
        let result = inner.get(key);
        if (result === undefined) {
            result = this.rules.get(roleKey)?.get(queryId) ?? this.getAllowedBase(queryId, rootTid, caches, roleKey);
            inner.set(key, result);
        }
        return result;
    }

    getAllowedBase(queryId: PrimaryKey, rootTid: PrimaryKey | undefined, caches: TypeCaches, roleKey: string): QueryAllowed {
        const parents = [...this.graph.relatedTo(roleKey)];
        if (parents.length === 0)
            return this.queryDefault(queryId, rootTid, caches, roleKey);

        // Signum's Merge: the base roles' values, upgraded to this role's type-derived value when every base
        // role that produced the merged value was itself only following its type.
        const bases = parents.map(p => ({ role: p, value: this.getAllowed(queryId, rootTid, caches, p) }));
        const best = mergeQuery(this.graph.getMergeStrategy(roleKey), bases.map(x => x.value));
        const maxUp = QueryAuthLogic.maxAutomaticUpgradeOf(queryId);
        if (maxUp != null && maxUp <= best)
            return best;
        if (!this.autoUpgradeAllowed(roleKey))
            return best;
        if (bases.filter(x => x.value === best).every(x => this.fromType(rootTid, caches, x.role) === x.value)) {
            const def = this.fromType(rootTid, caches, roleKey);
            return maxUp != null && maxUp <= def ? maxUp : def;
        }
        return best;
    }
}

export namespace QueryAuthLogic {
    let started = false;
    let rulesLazy: ResetLazy<QueryRulesCache>;

    export function isStarted(): boolean {
        return started;
    }

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;
        TypeAuthLogic.registerDimensionSummary("queries", fallbackSummary); // grid icon colour summary
        QueryLogic.start(sb);                       // the QueryEntity seeding prerequisite
        // No `withQuery()` — see TypeAuthLogic. (The unique index [role, resource] is on the entity.)
        sb.include(RuleQueryEntity);
        // invalidateWith RuleType too: the no-rule default auto-upgrades to the query's TYPE read allowance,
        // so a type-rule change must reset the query cache.
        rulesLazy = sb.globalLazy(async () => new QueryRulesCache(await loadRules(), await AuthLogic.roleGraph(), await TypeAuthLogic.rulesCache(),
            await autoUpgradePredicate()),
            { invalidateWith: [RuleQueryEntity, RuleTypeEntity, RulePermissionEntity, RoleEntity] });
        AuthLogic.invalidateBlobWith(rulesLazy);   // the blob is filtered per role, so a rule change stales it
        AuthLogic.registerXmlExporter(exportXml);
        AuthLogic.registerXmlImporter(importXml);
        // The query-access gate. Called by queryServer with
        // fullScreen:false → blocks only None.
        QueryLogic.assertQueryAllowedHook = async (queryName, fullScreen) => {
            if (!(await isQueryAllowed(queryName, fullScreen)))
                // Localized: this refusal reaches the end user through the error modal, not just a log.
                throw new UnauthorizedAccessException(SearchMessage.Query0NotAllowed.niceToString(getKey(queryName)));
        };
    }

    /**
     * Signum's `QueryAuthLogic.SetMaxAutomaticUpgrade(queryName, allowed)`: the most the automatic upgrade
     * may give this query. Declared by query name; read by the query row's id once the queries are loaded.
     */
    const maxAutomaticUpgrade = new Map<string, QueryAllowed>();
    let maxAutomaticUpgradeById: Map<string, QueryAllowed> | undefined;

    export function setMaxAutomaticUpgrade(queryName: QueryName, allowed: QueryAllowed): void {
        const key = getKey(queryName);
        if (maxAutomaticUpgrade.has(key))
            throw new Error(`MaxAutomaticUpgrade of query '${key}' is already set`);
        maxAutomaticUpgrade.set(key, allowed);
    }

    export function maxAutomaticUpgradeOf(queryId: PrimaryKey): QueryAllowed | undefined {
        return maxAutomaticUpgradeById?.get(String(queryId));
    }

    // A synchronous AutomaticUpgradeOfQueries predicate for the cache (see PropertyAuthLogic's twin), and
    // the caps keyed by query id. Without permission auth started, the upgrade is on.
    async function autoUpgradePredicate(): Promise<(roleKey: string) => boolean> {
        const byId = new Map<string, QueryAllowed>();
        for (const [key, allowed] of maxAutomaticUpgrade) {
            const entity = QueryLogic.tryGetQueryEntityByKey(key);
            if (entity != null)
                byId.set(String(entity.id), allowed);
        }
        maxAutomaticUpgradeById = byId;

        if (!PermissionAuthLogic.isStarted())
            return () => true;
        const permCache = await PermissionAuthLogic.rulesCache();
        const permId = BasicPermission.AutomaticUpgradeOfQueries.id;
        return roleKey => permCache.getAllowed(permId, roleKey);
    }

    /** Explicit reset for setQueryRulePack (whose deletes don't fire `saved`). Saves auto-invalidate. */
    export function invalidate(): void {
        rulesLazy?.reset();
    }

    async function loadRules(): Promise<Map<string, Map<PrimaryKey, QueryAllowed>>> {
        const rows = await table(RuleQueryEntity).toArray() as RuleQueryEntity[];
        const map = new Map<string, Map<PrimaryKey, QueryAllowed>>();
        for (const row of rows) {
            const roleKey = row.role.key();
            let inner = map.get(roleKey);
            if (inner == null) { inner = new Map(); map.set(roleKey, inner); }
            inner.set(row.resource.id, row.allowed);
        }
        return map;
    }

    // The entity-type discriminator id of a query's root type, or undefined for a non-entity query.
    function rootTypeId(queryName: QueryName, caches: TypeCaches): PrimaryKey | undefined {
        const core = QueryLogic.queries.tryGetCore(queryName);
        if (core == null)
            return undefined; // a non-entity query has no root type
        return caches.tryTypeToId(core.getRootType());
    }

    /** The current role's allowance for a query. No current role (anonymous / auth off) → Allow. */
    export async function getQueryAllowed(queryName: QueryName): Promise<QueryAllowed> {
        const roleKey = AuthLogic.currentRoleKey();
        if (roleKey == null)
            return QueryAllowed.Allow;
        const caches = await TypeLogic.caches();
        return (await rulesLazy.value()).getAllowed(QueryLogic.getQueryEntity(queryName).id, rootTypeId(queryName, caches), caches, roleKey);
    }

    export async function isQueryAllowed(queryName: QueryName, fullScreen: boolean): Promise<boolean> {
        const a = await getQueryAllowed(queryName);
        return a === QueryAllowed.Allow || (a === QueryAllowed.EmbeddedOnly && !fullScreen);
    }

    /** Allowance by query KEY (the reflection blob carries keys). Unknown/unseeded key → Allow (don't
     *  gate). Used by the AuthReflection overlay to drop `None` queries from a role's blob. */
    export async function getQueryAllowedByKey(key: string, roleKey?: string): Promise<QueryAllowed> {
        const rk = roleKey ?? AuthLogic.currentRoleKey();
        if (rk == null)
            return QueryAllowed.Allow;
        const qe = QueryLogic.tryGetQueryEntityByKey(key);
        if (qe == null)
            return QueryAllowed.Allow;
        const qn = QueryLogic.tryGetQueryNameByKey(key);
        const caches = await TypeLogic.caches();
        return (await rulesLazy.value()).getAllowed(qe.id, qn ? rootTypeId(qn, caches) : undefined, caches, rk);
    }

    /** Min/max access RANK (0 None, 1 EmbeddedOnly, 2 Allow) over ALL of the type's queries — the grid's
     *  colour summary for the Queries drill-in. undefined when the type has no queries. */
    export async function fallbackSummary(typeName: string, roleKey: string): Promise<{ min: number; max: number } | undefined> {
        const ctor = Entity.resolveType(typeName);
        const caches = await TypeLogic.caches();
        const rules = await rulesLazy.value();
        const typeId = caches.typeToId(ctor);
        const rank = (v: QueryAllowed): number => v === QueryAllowed.None ? 0 : v === QueryAllowed.EmbeddedOnly ? 1 : 2;
        let min = 2, max = 0, any = false;
        for (const qn of QueryLogic.getTypeQueries(ctor)) {
            const r = rank(rules.getAllowed(QueryLogic.getQueryEntity(qn).id, typeId, caches, roleKey));
            if (r < min) min = r;
            if (r > max) max = r;
            any = true;
        }
        return any ? { min, max } : undefined;
    }

    // The admin pack for one (role, type): every query of the type with the role's allowed/allowedBase.
    export async function getQueryRulePack(typeName: string, roleId: PrimaryKey): Promise<QueryRulePack> {
        const role = await table(RoleEntity).filter(r => r.id == roleId).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${roleId}' not found`);
        const roleKey = role.toLite().key();
        const ctor = Entity.resolveType(typeName);
        const caches = await TypeLogic.caches();
        const cache = await rulesLazy.value();
        const typeId = caches.typeToId(ctor);
        const rules: QueryAllowedRule[] = [];
        for (const qn of QueryLogic.getTypeQueries(ctor)) {
            const qe = QueryLogic.getQueryEntity(qn);
            rules.push(QueryAllowedRule.create({
                resource: QueryEntity.newLite(qe.id, getKey(qn)),
                allowed: cache.getAllowed(qe.id, typeId, caches, roleKey),        // all queries here root on this type
                allowedBase: cache.getAllowedBase(qe.id, typeId, caches, roleKey),
                coerced: QueryAllowed.Allow,
            }));
        }
        rules.sort((a, b) => a.resource.toString().localeCompare(b.resource.toString()));
        return QueryRulePack.create({
            role: role.toLite(),
            type: TypeEntity.newLite(typeId, typeName),
            strategy: MergeStrategy[role.mergeStrategy],
            rules,
        });
    }

    // Persist the pack (scoped to this type's queries): redundant (allowed==base) → delete; else upsert.
    export async function setQueryRulePack(pack: QueryRulePack): Promise<void> {
        const role = await table(RoleEntity).filter(r => r.id == pack.role.id).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${pack.role.id}' not found`);
        const roleLite = role.toLite();
        const packQueryIds = new Set(pack.rules.map(r => String(r.resource.id)));
        const current = (await table(RuleQueryEntity).filter(rq => rq.role == roleLite).toArray() as RuleQueryEntity[])
            .filter(rq => packQueryIds.has(String(rq.resource.id)));
        const currentByQuery = new Map(current.map(rq => [String(rq.resource.id), rq]));

        for (const r of pack.rules) {
            const existing = currentByQuery.get(String(r.resource.id));
            if (r.allowed === r.allowedBase) {
                if (existing != null)
                    await existing.delete();
            } else if (existing != null) {
                if (existing.allowed !== r.allowed) {
                    existing.allowed = r.allowed;
                    await existing.save();
                }
            } else {
                await RuleQueryEntity.create({
                    role: roleLite,
                    resource: QueryEntity.newLite(r.resource.id, r.resource.toString()),
                    allowed: r.allowed,
                }).save();
            }
        }
        invalidate();
    }

    // ---- AuthRules XML -----------------------------------------------------------------------
    async function exportXml(ctx: AuthExportCtx): Promise<{ name: string; content: unknown }> {
        const queryKey = new Map((await table(QueryEntity).toArray() as QueryEntity[]).map(q => [String(q.id), q.key]));
        const caches = await TypeLogic.caches();
        const rootTid = (qk: string): PrimaryKey | undefined => {
            const qn = QueryLogic.tryGetQueryNameByKey(qk);
            return qn != null ? rootTypeId(qn, caches) : undefined;
        };
        const rules = await rulesLazy.value();
        const stored = await table(RuleQueryEntity).toArray() as RuleQueryEntity[];
        const byRole = groupByRole(stored.filter(r => {
            const tid = rootTid(queryKey.get(String(r.resource.id)) ?? "");
            return rules.getAllowed(r.resource.id!, tid, caches, r.role.key()) !== rules.getAllowedBase(r.resource.id!, tid, caches, r.role.key());
        }));
        return {
            name: "Queries",
            content: section("Query", ctx.orderedRoleKeys, ctx.roleName, byRole, r => {
                const qk = queryKey.get(String(r.resource.id)) ?? String(r.resource.id);
                return attrs({ Resource: qk, Allowed: QueryAllowed[r.allowed] });
            }),
        };
    }

    async function importXml(auth: Record<string, unknown>, ctx: AuthImportCtx): Promise<SqlPreCommand | undefined> {
        const replacementKey = "AuthRules:QueryEntity";
        // Signum's QueryLogic.QueryNames: the registered queries (a row whose query is gone is not one).
        const queries = (await table(QueryEntity).toArray() as QueryEntity[]).filter(q => QueryLogic.tryGetQueryNameByKey(q.key) != null);
        const byKey = new Map(queries.map(q => [q.key, q]));
        ctx.replacements.askForReplacements(
            new Set(sectionRows(auth, "Queries", "Query").map(p => p.Resource)),
            new Set(byKey.keys()),
            replacementKey);

        const queryKey = new Map((await table(QueryEntity).toArray() as QueryEntity[]).map(q => [String(q.id), q.key]));
        return syncRulesScript(auth, ctx, {
            rootName: "Queries",
            elementName: "Query",
            resourceName: QueryEntity.niceName(),
            stored: await table(RuleQueryEntity).toArray() as RuleQueryEntity[],
            storedKey: r => queryKey.get(String(r.resource.id)) ?? String(r.resource.id),
            toResource: s => {
                const q = byKey.get(ctx.replacements.apply(replacementKey, s));
                if (q == null) ctx.noteSkipped("Query", s);
                return q?.key;
            },
            create: (role, key, x) => RuleQueryEntity.create({
                role,
                resource: byKey.get(key)!.toLite(),
                // A bool is read for backwards compatibility.
                allowed: x.Allowed.trim() in QueryAllowed ? parseEnum(QueryAllowed, x.Allowed) : (parseBool(x.Allowed) ? QueryAllowed.Allow : QueryAllowed.None),
            }),
            allowedComment: r => enumName(QueryAllowed, r.allowed),
            update: updateAllowed(QueryAllowed),
        });
    }
}
