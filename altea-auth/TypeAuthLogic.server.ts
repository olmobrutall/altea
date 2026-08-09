import "@altea/altea/server"; // Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // withQuery
import { SchemaBuilder } from "@altea/altea/server/schema";
import { ResetLazy } from "@altea/altea/data/resetLazy";
import { table } from "@altea/altea/server/table";
import type { LambdaExpression } from "@altea/altea/server/linq/expressions";
import type { RuntimeType } from "@altea/altea/server/runtimeTypes";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { preSaveGates } from "@altea/altea/server/saver";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { LiteImp } from "@altea/altea/data/lite";
import type { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import type { PrimaryKey, Type } from "@altea/altea/data/entity";
import { toInt } from "@altea/altea/data/basics";
import { AuthLogic } from "./AuthLogic.server";
import { MergeStrategy, RoleEntity } from "./Role.data";
import {
    RuleTypeEntity, RuleTypeConditionEntity, RuleTypeConditionEntity_Conditions,
    TypeAllowed, TypeAllowedBasic, typeAllowedGet,
    TypeRulePack, TypeAllowedRule, TypeConditionSymbol,
    WithConditionsModel, ConditionRuleModel,
} from "./Rules.data";
import { UserEntity, UserState, UserTypeCondition } from "./User.data";
import { TypeConditionLogic } from "./TypeConditionLogic.server";
import { WithConditions, ConditionRule, maxBound, minBound } from "./WithConditions.server";
import { mergeTypeConditions } from "./TypeConditionMerger.server";
import { buildAuthFilter, authFilterLambda } from "./TypeConditionAlgebra.server";
import { computeAllowed, type ComputedCache } from "./AuthCache.server";

// Port of Signum's TypeAuthLogic (Rules/TypeAuthLogic.cs + .Conditions.cs) — a role's access to an entity
// TYPE, now with ROW-LEVEL type conditions. A role's allowed for a type is a `WithConditions<TypeAllowed>`
// (a fallback + ordered condition rules), merged across the role graph by the 2^n TypeConditionMerger.
// `isAllowedFor(entity, …)` evaluates it against a concrete instance (last-match-wins). The compile-to-SQL
// row filter + save gate are Phase D.
//
// altea divergences: rules keyed by TypeEntity id; async cache (no GlobalLazy). Merge is the faithful
// truth-table merger (TypeConditionMerger). The role default maps the boolean default-allowed to a simple
// Write / None WithConditions.

export namespace TypeAuthLogic {
    let started = false;
    // Signum's AuthCache: `rules` = the raw per-role rules read from the DB; `computed` = the merged
    // (role, typeId) → WithConditions cache (RoleAllowedCache). Both live inside ONE GlobalLazy so they
    // reset together when a RuleType or Role is saved (InvalidateWith).
    interface RulesCache {
        rules: Map<string, Map<PrimaryKey, WithConditions<TypeAllowed>>>;
        computed: ComputedCache<WithConditions<TypeAllowed>>;
    }
    let rulesLazy: ResetLazy<Promise<RulesCache>>;
    // Signum's RoleAllowedCache materialised for the SYNC LINQ binder (roleKey -> typeId -> WithConditions),
    // for CONDITIONED types only. Warmed at initialize() + re-warmed on rule/role change (warmSyncCache).
    let _syncMerged: Map<string, Map<PrimaryKey, WithConditions<TypeAllowed>>> = new Map();

    export function isStarted(): boolean {
        return started;
    }

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;
        sb.include(RuleTypeEntity).withQuery();
        // Type conditions: seed the TypeConditionSymbol table + register the framework predicates
        // (Signum's TypeAuthLogic.Start → TypeConditionLogic.Start + the DeactivatedUsers RegisterCompile).
        TypeConditionLogic.start(sb);
        TypeConditionLogic.registerCompile(UserEntity, UserTypeCondition.DeactivatedUsers, u => u.state === UserState.Deactivated);
        // Signum's `sb.GlobalLazy(rules, InvalidateWith(RuleType, Role))`: cache the rules + merged values,
        // resetting when a RuleType or Role is saved. (setTypeRulePack also resets explicitly for its deletes.)
        rulesLazy = sb.globalLazy(async () => ({ rules: await loadRules(), computed: new Map() }),
            { invalidateWith: [RuleTypeEntity, RoleEntity] });
        // Enforcement. The save gate (Signum's Schema_Saving) is installed now. The row-read FILTER
        // (Signum's FilterQuery) goes on each CONDITIONED type's EntityEvents.queryFilter so the LINQ binder
        // applies it to EVERY query (retrieve, dynamic query, navigation) — but only once ALL conditions are
        // registered (app conditions register after this start), so it + the binder's sync cache are set up
        // in a schema.initializing hook. The sync cache is re-warmed when a RuleType or Role changes (the
        // async caches reset via the GlobalLazy; this refreshes the snapshot the binder reads).
        preSaveGates.push(authSaveGate);
        sb.schema.initializing.push(async () => {
            for (const ctor of TypeConditionLogic.types())
                sb.schema.entityEvents(ctor as Type<Entity>).queryFilter.push(authQueryFilterHook);
            await warmSyncCache();
        });
        sb.schema.entityEvents(RuleTypeEntity).saved.push(() => void warmSyncCache());
        sb.schema.entityEvents(RoleEntity).saved.push(() => void warmSyncCache());
    }

    // Row-read filter (Signum's TypeAuthLogic_FilterQuery), installed on each conditioned type's
    // EntityEvents.queryFilter. SYNCHRONOUS (the binder is sync): reads the pre-warmed `_syncMerged`
    // snapshot of the CURRENT role's WithConditions for the type — never the DB. No current role / auth
    // disabled / unwarmed pair → no filter (undefined).
    function authQueryFilterHook(ctx: { ctor: Function; elementType: RuntimeType }): LambdaExpression | undefined {
        const rk = AuthLogic.currentRoleKey();
        if (rk == null || !AuthLogic.isEnabled())
            return undefined;
        const wc = _syncMerged.get(rk)?.get(TypeLogic.typeToId(ctx.ctor));
        if (wc == null)
            return undefined;
        return authFilterLambda(buildAuthFilter(ctx.ctor, ctx.elementType, wc, TypeAllowedBasic.Read, true), ctx.elementType);
    }

    // Signum's RoleAllowedCache materialised synchronously for the binder: (roleKey -> typeId ->
    // WithConditions) for every role × conditioned type. getAllowed (async GlobalLazy + role-graph merge)
    // can't run in the sync binder, so it is precomputed here at initialize() and re-run on rule/role change.
    async function warmSyncCache(): Promise<void> {
        const conditionedTypeIds = TypeConditionLogic.types().map(ctor => TypeLogic.typeToId(ctor));
        const roleKeys = [...(await AuthLogic.roleGraph()).rolesByKey.keys()];
        const next = new Map<string, Map<PrimaryKey, WithConditions<TypeAllowed>>>();
        for (const rk of roleKeys) {
            const inner = new Map<PrimaryKey, WithConditions<TypeAllowed>>();
            for (const typeId of conditionedTypeIds)
                inner.set(typeId, await getAllowed(typeId, rk));
            next.set(rk, inner);
        }
        _syncMerged = next;
    }

    // Write gate (Signum's Schema_Saving per-instance check): block saving a row that a type CONDITION
    // denies writing. Scoped to conditioned types where the role CAN write some rows (max DB >= Write) — a
    // type the role can't write at all is an operation-auth concern (not ported), so we don't block those
    // here (that would break legitimate self-service saves on Read-only types). No current role → no gate.
    async function authSaveGate(entities: Entity[]): Promise<void> {
        const rk = AuthLogic.currentRoleKey();
        if (rk == null || !AuthLogic.isEnabled())
            return;
        for (const e of entities) {
            const ctor = e.constructor as Function;
            if (TypeConditionLogic.conditionsFor(ctor).length === 0)
                continue;
            const wc = await getAllowed(TypeLogic.typeToId(ctor), rk);
            if (maxBound(wc, false) < TypeAllowedBasic.Write)
                continue;
            if (!(await isAllowedFor(e, TypeAllowedBasic.Write, false, rk)))
                throw new UnauthorizedAccessException(`Not authorized to save ${ctor.name} '${String(e.id)}' — denied by a type condition`);
        }
    }

    // Explicit reset (for setTypeRulePack, whose deletes don't fire the `saved` event the GlobalLazy
    // listens to). Saves are auto-handled by the GlobalLazy's invalidateWith.
    export function invalidate(): void {
        rulesLazy?.reset();
    }

    // Build the raw per-role rules from the DB (the GlobalLazy factory — caching/invalidation is the lazy's job).
    async function loadRules(): Promise<Map<string, Map<PrimaryKey, WithConditions<TypeAllowed>>>> {
        const rows = await table(RuleTypeEntity).toArray() as RuleTypeEntity[];
        // id -> the shared (interned) TypeConditionSymbol, to resolve each condition row's Lite reference.
        const symbolById = new Map(SymbolLogic.symbols(TypeConditionSymbol).map(s => [String(s.id), s]));
        const map = new Map<string, Map<PrimaryKey, WithConditions<TypeAllowed>>>();
        for (const row of rows) {
            const roleKey = row.role.key();
            let inner = map.get(roleKey);
            if (inner == null) { inner = new Map(); map.set(roleKey, inner); }
            inner.set(row.resource.id, toWithConditions(row, symbolById));
        }
        return map;
    }

    // A persisted RuleTypeEntity (fallback + its owned condition rows) → the immutable runtime value. The
    // condition rows are ordered by their `order` column (Signum's [PreserveOrder]); each row's symbol set
    // resolves its Lite<TypeConditionSymbol> references back to the shared symbol instances.
    function toWithConditions(row: RuleTypeEntity, symbolById: Map<string, TypeConditionSymbol>): WithConditions<TypeAllowed> {
        const conditionRules = [...row.conditionRules]
            .sort((a, b) => Number(a.order) - Number(b.order))
            .map(cr => new ConditionRule<TypeAllowed>(
                cr.conditions.map(c => {
                    const s = symbolById.get(String(c.symbol.id));
                    if (s == null) throw new Error(`TypeConditionSymbol id ${String(c.symbol.id)} is not registered`);
                    return s;
                }),
                cr.allowed));
        return new WithConditions<TypeAllowed>(row.fallback, conditionRules);
    }

    const mergeType = (strategy: MergeStrategy, baseValues: WithConditions<TypeAllowed>[]): WithConditions<TypeAllowed> =>
        mergeTypeConditions(strategy, baseValues);

    const getDefaultType = async (roleKey: string): Promise<WithConditions<TypeAllowed>> =>
        WithConditions.simple((await AuthLogic.getDefaultAllowed(roleKey)) ? TypeAllowed.Write : TypeAllowed.None);

    /** The full WithConditions<TypeAllowed> for a type id and role. No current role (anonymous / auth off)
     *  → simple Write. */
    export async function getAllowed(typeId: PrimaryKey, roleKey?: string): Promise<WithConditions<TypeAllowed>> {
        const rk = roleKey ?? AuthLogic.currentRoleKey();
        if (rk == null)
            return WithConditions.simple(TypeAllowed.Write);
        const { rules, computed } = await rulesLazy.value;
        return computeAllowed<WithConditions<TypeAllowed>>(rk, typeId, rules, mergeType, getDefaultType, computed);
    }

    /** Coarse "can this role reach `requested` for this type AT ALL" (Signum's Max* bound) — used by the
     *  reflection-blob filter to decide type/query visibility. A conditionally-readable type is visible. */
    export async function isAllowedForType(
        typeId: PrimaryKey,
        requested: TypeAllowedBasic,
        userInterface: boolean,
        roleKey?: string,
    ): Promise<boolean> {
        const wc = await getAllowed(typeId, roleKey);
        return maxBound(wc, userInterface) >= requested;
    }

    // Signum's TypeAuthLogic.IsAllowedFor(entity, …) — the per-INSTANCE evaluation (last-match-wins):
    // Min/Max short-circuits, then iterate the condition rules IN REVERSE and return on the first whose
    // symbol set ALL holds for the entity (in-memory predicates), else the fallback. Used by the save gate
    // + the in-memory branch of the row filter (Phase D). No current role (auth off) → allowed.
    export async function isAllowedFor(entity: Entity, requested: TypeAllowedBasic, userInterface: boolean, roleKey?: string): Promise<boolean> {
        const rk = roleKey ?? AuthLogic.currentRoleKey();
        if (rk == null || !AuthLogic.isEnabled())
            return true;
        const tac = await getAllowed(TypeLogic.typeToId(entity.constructor), rk);
        const min = minBound(tac, userInterface);
        if (requested <= min)
            return true;
        const max = maxBound(tac, userInterface);
        if (max < requested)
            return false;
        for (let i = tac.conditionRules.length - 1; i >= 0; i--) {
            const cond = tac.conditionRules[i];
            if (cond.typeConditions.every(tc => TypeConditionLogic.inTypeCondition(entity, tc)))
                return typeAllowedGet(cond.allowed, userInterface) >= requested;
        }
        return typeAllowedGet(tac.fallback, userInterface) >= requested;
    }

    // The value a role would get for a type with NO explicit rule (Signum's AuthCache.GetAllowedBase):
    // the merge of its direct parents' allowed values, or the role default if it is a root role.
    export async function getAllowedBase(typeId: PrimaryKey, roleKey: string): Promise<WithConditions<TypeAllowed>> {
        const parents = await AuthLogic.relatedTo(roleKey);
        if (parents.size === 0)
            return getDefaultType(roleKey);
        return mergeType(await AuthLogic.getMergeStrategy(roleKey), await Promise.all([...parents].map(p => getAllowed(typeId, p))));
    }

    const symbolLite = (s: TypeConditionSymbol): Lite<TypeConditionSymbol> => new LiteImp(s.id, TypeConditionSymbol, s.key);

    // Runtime WithConditions → the mutable transport model (Signum's ToModel).
    function toModel(wc: WithConditions<TypeAllowed>): WithConditionsModel {
        return WithConditionsModel.create({
            fallback: wc.fallback,
            conditionRules: wc.conditionRules.map(cr => ConditionRuleModel.create({
                typeConditions: cr.typeConditions.map(symbolLite),
                allowed: cr.allowed,
            })),
        });
    }

    // Edited model → runtime WithConditions (Signum's ToImmutable), resolving each condition's symbol Lite
    // back to the shared symbol. Used to compare allowed vs allowedBase (redundant-rule detection).
    function fromModel(model: WithConditionsModel, symbolById: Map<string, TypeConditionSymbol>): WithConditions<TypeAllowed> {
        return new WithConditions<TypeAllowed>(model.fallback, model.conditionRules.map(cr =>
            new ConditionRule<TypeAllowed>(
                cr.typeConditions.map(lite => {
                    const s = symbolById.get(String(lite.id));
                    if (s == null) throw new Error(`TypeConditionSymbol id ${String(lite.id)} is not registered`);
                    return s;
                }),
                cr.allowed)));
    }

    // Signum's AuthCache.GetRules — the admin pack: every type with the role's effective `allowed` and its
    // inherited `allowedBase` (each a full WithConditionsModel: fallback + condition rules), plus the
    // `availableConditions` the type registered (so the UI can offer them). The resource Lite carries the
    // clean name as its toStr for display.
    export async function getTypeRulePack(roleId: PrimaryKey): Promise<TypeRulePack> {
        const role = await table(RoleEntity).filter(r => r.id == roleId).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${roleId}' not found`);
        const roleKey = role.toLite().key();
        // typeId -> the symbols registered for that type (only types with conditions appear).
        const availableByType = new Map<PrimaryKey, TypeConditionSymbol[]>(
            TypeConditionLogic.types().map(ctor => [TypeLogic.typeToId(ctor), TypeConditionLogic.conditionsFor(ctor)]));
        const rules: TypeAllowedRule[] = [];
        for (const t of await table(TypeEntity).toArray() as TypeEntity[]) {
            rules.push(TypeAllowedRule.create({
                resource: new LiteImp(t.id, TypeEntity, t.cleanName),
                allowed: toModel(await getAllowed(t.id, roleKey)),
                allowedBase: toModel(await getAllowedBase(t.id, roleKey)),
                availableConditions: (availableByType.get(t.id) ?? []).map(symbolLite),
            }));
        }
        rules.sort((a, b) => a.resource.toString().localeCompare(b.resource.toString()));
        return TypeRulePack.create({ role: role.toLite(), strategy: MergeStrategy[role.mergeStrategy], rules });
    }

    // Signum's AuthCache.SetRules — persist the pack: a value equal to its inherited base is redundant
    // (delete the explicit rule); otherwise upsert a RuleType with the fallback + condition rows. Then
    // invalidate the cache. The condition rows (RuleTypeConditionEntity + its symbol junction) are owned,
    // so replacing the array orphan-deletes the old rows and inserts the new on save.
    export async function setTypeRulePack(pack: TypeRulePack): Promise<void> {
        const role = await table(RoleEntity).filter(r => r.id == pack.role.id).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${pack.role.id}' not found`);
        const roleLite = role.toLite();
        const symbolById = new Map(SymbolLogic.symbols(TypeConditionSymbol).map(s => [String(s.id), s]));
        const current = await table(RuleTypeEntity).filter(rt => rt.role == roleLite).toArray() as RuleTypeEntity[];
        const currentByType = new Map(current.map(rt => [String(rt.resource.id), rt]));

        for (const r of pack.rules) {
            const existing = currentByType.get(String(r.resource.id));
            const isRedundant = fromModel(r.allowed, symbolById).equals(fromModel(r.allowedBase, symbolById));
            if (isRedundant) {
                if (existing != null)
                    await existing.delete();
                continue;
            }
            const rt = existing ?? RuleTypeEntity.create({
                role: roleLite,
                resource: new LiteImp(r.resource.id, TypeEntity, r.resource.toString()),
            });
            rt.fallback = r.allowed.fallback;
            rt.conditionRules = r.allowed.conditionRules.map((cr, i) => RuleTypeConditionEntity.create({
                order: toInt(i),
                allowed: cr.allowed,
                conditions: cr.typeConditions.map(lite => RuleTypeConditionEntity_Conditions.create({ symbol: lite })),
            }));
            await rt.save();
        }
        invalidate();
    }
}
