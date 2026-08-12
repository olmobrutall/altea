import "@altea/altea/server"; // Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // withQuery
import { SchemaBuilder } from "@altea/altea/server/schema";
import { ResetLazy } from "@altea/altea/data/resetLazy";
import { table } from "@altea/altea/server/table";
import { Entity, type PrimaryKey } from "@altea/altea/data/entity";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { getKey, type QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { AuthLogic, RoleGraph } from "./AuthLogic";
import { TypeAuthLogic } from "./TypeAuthLogic";
import { MergeStrategy, RoleEntity } from "../data/Role";
import { RuleQueryEntity, RuleTypeEntity, QueryRulePack, QueryAllowedRule, QueryAllowed, TypeAllowedBasic } from "../data/Rules";
import { computeAllowed, type ComputedCache } from "./AuthCache";
import { maxBound } from "./WithConditions";

// Port of Signum's QueryAuthLogic (Rules/QueryAuthLogic.cs). The query dimension: a role's allowance per
// query is a 3-valued QueryAllowed (None → hidden/non-executable; EmbeddedOnly → embedded search only,
// hidden from the full-screen search page; Allow → everywhere). Enforcement gate (`dqm_AllowQuery`):
// `allowed === Allow || (allowed === EmbeddedOnly && !fullScreen)`. The server executes with
// fullScreen:false (so it only blocks None); the full-screen distinction is a client concern.
//
// Prerequisite: QueryLogic.start (QueryEntity row seeding + key↔entity cache) — invoked from start below.
// altea divergences (mirroring the other dimensions): async cache via sb.globalLazy + computeAllowed,
// keyed by the QueryEntity id; merge Union-max/Intersection-min. AutomaticUpgradeOfQueries coercion cap
// is deferred (coerced = Allow).
const mergeQuery = (strategy: MergeStrategy, baseValues: QueryAllowed[]): QueryAllowed =>
    strategy === MergeStrategy.Union
        ? baseValues.reduce((a, b) => Math.max(a, b), QueryAllowed.None)
        : baseValues.reduce((a, b) => Math.min(a, b), QueryAllowed.Allow);

// Signum's AuthCache as a CLASS: raw per-role query rules + role graph + the captured type-rule cache
// (queries auto-upgrade to their entity type's read allowance) + the merged memo, folded synchronously.
class QueryRulesCache {
    private readonly computed: ComputedCache<QueryAllowed> = new Map();
    constructor(
        private readonly rules: Map<string, Map<PrimaryKey, QueryAllowed>>,
        private readonly graph: RoleGraph,
        private readonly typeCache: TypeAuthLogic.TypeRulesCache,
    ) { }

    // The value a role gets for a query with NO explicit rule anywhere in its graph. Signum's
    // AutomaticUpgradeOfQueries (simplified): default-allowed role → Allow; else AUTO-UPGRADE to Allow when
    // the underlying entity TYPE is UI-readable for the role (queries follow type visibility); else None.
    private queryDefault(rootTypeId: PrimaryKey | undefined, roleKey: string): QueryAllowed {
        if (this.graph.getDefaultAllowed(roleKey))
            return QueryAllowed.Allow;
        if (rootTypeId != null && maxBound(this.typeCache.getAllowed(rootTypeId, roleKey), true) >= TypeAllowedBasic.Read)
            return QueryAllowed.Allow;
        return QueryAllowed.None;
    }

    getAllowed(queryId: PrimaryKey, rootTid: PrimaryKey | undefined, roleKey: string): QueryAllowed {
        return computeAllowed<QueryAllowed>(roleKey, queryId, this.rules, mergeQuery, rk => this.queryDefault(rootTid, rk), this.computed, this.graph);
    }

    getAllowedBase(queryId: PrimaryKey, rootTid: PrimaryKey | undefined, roleKey: string): QueryAllowed {
        const parents = this.graph.relatedTo(roleKey);
        if (parents.size === 0)
            return this.queryDefault(rootTid, roleKey);
        return mergeQuery(this.graph.getMergeStrategy(roleKey), [...parents].map(p => this.getAllowed(queryId, rootTid, p)));
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
        sb.include(RuleQueryEntity).withQuery();     // unique index [role, resource] already on the entity
        // invalidateWith RuleType too: the no-rule default auto-upgrades to the query's TYPE read allowance,
        // so a type-rule change must reset the query cache.
        rulesLazy = sb.globalLazy(async () => new QueryRulesCache(await loadRules(), await AuthLogic.roleGraph(), await TypeAuthLogic.rulesCache()),
            { invalidateWith: [RuleQueryEntity, RuleTypeEntity, RoleEntity] });
        // The query-access gate (Signum's DynamicQueryContainer.AllowQuery). Called by queryServer with
        // fullScreen:false → blocks only None.
        QueryLogic.assertQueryAllowedHook = async (queryName, fullScreen) => {
            if (!(await isQueryAllowed(queryName, fullScreen)))
                throw new UnauthorizedAccessException(`Query '${getKey(queryName)}' is not authorized`);
        };
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
    function rootTypeId(queryName: QueryName): PrimaryKey | undefined {
        const core = QueryLogic.queries.tryGetCore(queryName);
        if (core == null)
            return undefined;
        try { return TypeLogic.typeToId(core.getRootType()); } catch { return undefined; }
    }

    /** The current role's allowance for a query. No current role (anonymous / auth off) → Allow. */
    export async function getQueryAllowed(queryName: QueryName): Promise<QueryAllowed> {
        const roleKey = AuthLogic.currentRoleKey();
        if (roleKey == null)
            return QueryAllowed.Allow;
        return getAllowed(QueryLogic.getQueryEntity(queryName).id, rootTypeId(queryName), roleKey);
    }

    /** Signum's dqm_AllowQuery predicate. */
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
        return getAllowed(qe.id, qn ? rootTypeId(qn) : undefined, rk);
    }

    async function getAllowed(queryId: PrimaryKey, rootTid: PrimaryKey | undefined, roleKey: string): Promise<QueryAllowed> {
        return (await rulesLazy.value()).getAllowed(queryId, rootTid, roleKey);
    }

    async function getAllowedBase(queryId: PrimaryKey, rootTid: PrimaryKey | undefined, roleKey: string): Promise<QueryAllowed> {
        return (await rulesLazy.value()).getAllowedBase(queryId, rootTid, roleKey);
    }

    /** Min/max access RANK (0 None, 1 EmbeddedOnly, 2 Allow) over ALL of the type's queries — the grid's
     *  colour summary for the Queries drill-in. undefined when the type has no queries. */
    export async function fallbackSummary(typeName: string, roleKey: string): Promise<{ min: number; max: number } | undefined> {
        const ctor = Entity.resolveType(typeName);
        const typeId = TypeLogic.typeToId(ctor);
        const rank = (v: QueryAllowed): number => v === QueryAllowed.None ? 0 : v === QueryAllowed.EmbeddedOnly ? 1 : 2;
        let min = 2, max = 0, any = false;
        for (const qn of QueryLogic.getTypeQueries(ctor)) {
            const r = rank(await getAllowed(QueryLogic.getQueryEntity(qn).id, typeId, roleKey));
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
        const typeId = TypeLogic.typeToId(ctor);
        const rules: QueryAllowedRule[] = [];
        for (const qn of QueryLogic.getTypeQueries(ctor)) {
            const qe = QueryLogic.getQueryEntity(qn);
            rules.push(QueryAllowedRule.create({
                resource: QueryEntity.newLite(qe.id, getKey(qn)),
                allowed: await getAllowed(qe.id, typeId, roleKey),        // all queries here root on this type
                allowedBase: await getAllowedBase(qe.id, typeId, roleKey),
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
}
