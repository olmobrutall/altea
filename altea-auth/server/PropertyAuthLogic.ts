import "@altea/altea/server"; // Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // withQuery
import { SchemaBuilder } from "@altea/altea/server/schema";
import { ResetLazy } from "@altea/altea/data/resetLazy";
import { table } from "@altea/altea/server/table";
import { Entity, type PrimaryKey, type Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { toInt } from "@altea/altea/data/basics";
import { AuthLogic, type RoleGraphData } from "./AuthLogic";
import { TypeAuthLogic } from "./TypeAuthLogic";
import { TypeConditionLogic } from "./TypeConditionLogic";
import { MergeStrategy, RoleEntity } from "../data/Role";
import {
    RulePropertyEntity, RulePropertyConditionEntity, RulePropertyConditionEntity_Conditions,
    RuleTypeEntity, PropertyRulePack, PropertyAllowedRule, PropertyAllowed, TypeAllowed,
    PropertyWithConditionsModel, PropertyConditionRuleModel, TypeConditionSymbol, TypeConditionSetModel,
    typeAllowedUI, typeBasicToProperty,
} from "../data/Rules";
import { WithConditions, ConditionRule, evaluateConditions } from "./WithConditions";
import { mergeWithConditions } from "./TypeConditionMerger";
import { setSerializationAuth, type PropertyAccess } from "@altea/altea/data/serializer/graphSerializers";
import { Serializer } from "@altea/altea/data/serializer";
import { setRequestDeserializer } from "@altea/altea/server/webApi";
import * as Database from "@altea/altea/server/Database";

// Port of Signum's PropertyAuthLogic (Rules/PropertyAuthLogic.cs) — the property dimension. A role's
// allowance per property route is PropertyAllowed (None → hidden; Read → read-only; Write). A property is
// CAPPED by its type's UI-read allowance (a property can't be more accessible than its type), and — with
// no explicit rule — DEFAULTS to that type allowance (Signum's AutomaticUpgradeOfProperties, simplified:
// no permission gate / no MaxAutomaticUpgrade cap).
//
// altea DIVERGENCES: rules keyed by (rootType, path) — NO PropertyRouteEntity table (see data/Rules.ts);
// routes enumerated via PropertyRoute.generateRoutes; async cache (sb.globalLazy + computeAllowed).
//
// ENFORCEMENT: installed via `setSerializationAuth` (the codec's open-default hook). The serializer is
// SYNCHRONOUS; per request the codec calls `resolveContext` ONCE (async, before the walk) to capture an
// IMMUTABLE SerializationAuthContext — the role graph + type rules + property rules, each obtained by
// awaiting a ResetLazy's Promise<T> — then `access` folds over THAT snapshot synchronously. Signum keeps a
// permanently-warm GlobalLazy; altea captures a per-request snapshot, immune to a concurrent invalidate().
// None → the value is omitted server→client + its line hidden (propsMeta); Read → read-only (kept on
// save); Write → normal.
export namespace PropertyAuthLogic {
    let started = false;
    interface RulesCache {
        rules: Map<string, Map<PrimaryKey | string, WithConditions<PropertyAllowed>>>;
    }
    let rulesLazy: ResetLazy<RulesCache>;

    export function isStarted(): boolean {
        return started;
    }

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;
        TypeAuthLogic.registerDimensionSummary("properties", fallbackSummary); // grid icon colour summary
        sb.include(RulePropertyEntity).withQuery();
        // invalidateWith RuleType too: the no-rule default / coerced ceiling derive from the type's UI-read
        // allowance, so a type-rule change must reset the property cache.
        rulesLazy = sb.globalLazy(async () => ({ rules: await loadRules() }),
            { invalidateWith: [RulePropertyEntity, RuleTypeEntity, RoleEntity] });
        // The serializer is SYNCHRONOUS. Per request the codec calls `resolveContext` ONCE (async, before the
        // walk) to capture an IMMUTABLE snapshot of the auth caches (role graph + type rules + property rules)
        // in a SerializationAuthContext, then reads THAT snapshot synchronously in `access` — so a concurrent
        // rule invalidation can't null a cache out mid-serialization (no fail-open window). Signum keeps its
        // RoleAllowedCache permanently warm; altea captures a per-request snapshot instead.
        setSerializationAuth({
            getMetadata: root => root,   // the root ENTITY — access evaluates its type-conditions per instance
            access: (route, meta, context) => toAccess(accessFromCtx(meta as Entity, route.propertyString(), context)),
            resolveContext: () => resolveContext(),
        });
        // The WRITE gate: make the retrieve implicit in the request deserializer. When the body carries an
        // existing (id) + modified root entity, load its DB original and overlay the incoming changes onto
        // it — so the codec keeps read-only / hidden properties at their stored value. Everything else
        // deserializes exactly as before (new entities, references, non-entity bodies).
        setRequestDeserializer(deserializeRequest);
    }

    // Signum's model binder onto a retrieved original (server-side). Async — this is the ONE place the DB
    // fetch happens for a save; handlers just call req.jsonTyped(). Falls back to a plain parse for anything
    // that isn't an existing+modified root entity (or if the original can't be retrieved).
    async function deserializeRequest(body: string): Promise<unknown> {
        const node = rootEntityNode(JSON.parse(body));
        if (node == null)
            return Serializer.parse(body);
        let ctor: Type<Entity>;
        try { ctor = Entity.resolveType(node.$type); } catch { return Serializer.parse(body); }
        if (!(ctor.prototype instanceof Entity))
            return Serializer.parse(body); // embedded / model — not a retrievable root
        let original: Entity;
        try { original = await Database.retrieve(ctor, node.id); }
        catch { return Serializer.parse(body); } // concurrently deleted / not found → build fresh
        return Serializer.parse(body, {
            resolve: (tn, id) => tn === node.$type && String(id) === String(node.id) ? original : undefined,
        });
    }

    // The root entity being written: the body itself, or an operation request's `.entity` — but only when
    // it is an EXISTING (id) + MODIFIED entity, so a new / unchanged root skips the DB round-trip.
    function rootEntityNode(raw: unknown): { $type: string; id: PrimaryKey; modified?: boolean } | undefined {
        const asNode = (o: unknown): { $type: string; id?: PrimaryKey; modified?: boolean } | undefined =>
            o != null && typeof o === "object" && typeof (o as { $type?: unknown }).$type === "string"
                ? (o as { $type: string; id?: PrimaryKey; modified?: boolean }) : undefined;
        const n = asNode(raw) ?? asNode((raw as { entity?: unknown } | null)?.entity);
        return n != null && n.id != null && n.modified === true ? (n as { $type: string; id: PrimaryKey; modified?: boolean }) : undefined;
    }

    // ---- Sync snapshot for the serializer -----------------------------------------------------
    function toAccess(pa: PropertyAllowed): PropertyAccess {
        return pa === PropertyAllowed.None ? "hidden" : pa === PropertyAllowed.Read ? "readonly" : "writable";
    }

    // The IMMUTABLE serialization-auth snapshot (Signum's warm RoleAllowedCache, captured per request). Holds
    // the property rules + the type-rule snapshot + the role graph — everything the sync `access` folds over.
    interface PropAuthCtx {
        propRules: Map<string, Map<PrimaryKey | string, WithConditions<PropertyAllowed>>>;
        typeCtx: TypeAuthLogic.RulesSnapshot;
        graph: RoleGraphData;
    }

    // Resolve the per-request snapshot: await the Promise<T> of each ResetLazy (never touching the box naked)
    // and combine into one PropAuthCtx. The serializer then reads it synchronously via accessFromCtx — immune
    // to a concurrent invalidate() between here and the walk (the captured values are frozen).
    export async function resolveContext(): Promise<PropAuthCtx> {
        const [graph, typeCtx, rc] = await Promise.all([
            AuthLogic.roleGraph(),
            TypeAuthLogic.rulesSnapshot(),
            rulesLazy.value(),
        ]);
        return { propRules: rc.rules, typeCtx, graph };
    }

    // SYNC property access for the current role (serializer path), evaluated against the concrete root ENTITY
    // (so type conditions resolve) from the CAPTURED context. No role / auth off / no context / unknown route
    // → Write (fail open). The per-instance value is clamped to the type's per-instance UI-read allowance
    // (a property can't exceed its type — Signum's CoerceValue).
    function accessFromCtx(root: Entity, path: string, ctxU: unknown): PropertyAllowed {
        const roleKey = AuthLogic.currentRoleKey();
        if (roleKey == null || !AuthLogic.isEnabled())
            return PropertyAllowed.Write;
        const ctx = ctxU as PropAuthCtx | undefined;
        if (ctx == null)
            return PropertyAllowed.Write; // no snapshot captured (auth off) → fail open
        let typeId: PrimaryKey;
        try { typeId = TypeLogic.typeToId(root.constructor); } catch { return PropertyAllowed.Write; }
        const wc = propAllowedFromCtx(typeId, compositeKey(typeId, path), roleKey, ctx);
        const ceilingWC = TypeAuthLogic.getAllowedFromCtx(typeId, roleKey, ctx.typeCtx, ctx.graph);
        const matches = (tc: TypeConditionSymbol): boolean => TypeConditionLogic.inTypeCondition(root, tc);
        const prop = evaluateConditions(wc, matches);
        const ceil = typeBasicToProperty(typeAllowedUI(evaluateConditions(ceilingWC, matches)));
        return Math.min(prop, ceil) as PropertyAllowed;
    }

    // ---- SYNC getAllowed over the captured context (twins of getAllowed / propAllowed / hasExplicitInChain
    // / typeDefaultWC): identical folding, but read the frozen snapshot (propRules + typeCtx + graph). No
    // undefined path — the context is always fully resolved by the time access runs.
    function relatedToG(graph: RoleGraphData, rk: string): Set<string> {
        return graph.graph.tryRelatedTo(rk);
    }
    function mergeStrategyG(graph: RoleGraphData, rk: string): MergeStrategy {
        return graph.mergeStrategies.get(rk)?.strategy ?? MergeStrategy.Union;
    }
    function propAllowedFromCtx(typeId: PrimaryKey, key: string, roleKey: string, ctx: PropAuthCtx): WithConditions<PropertyAllowed> {
        if (!hasExplicitInChainCtx(roleKey, key, ctx.propRules, ctx.graph))
            return typeDefaultFromCtx(typeId, roleKey, ctx);
        const explicit = ctx.propRules.get(roleKey)?.get(key);
        if (explicit !== undefined) return explicit;
        const parents = relatedToG(ctx.graph, roleKey);
        return mergeProp(mergeStrategyG(ctx.graph, roleKey), [...parents].map(p => propAllowedFromCtx(typeId, key, p, ctx)));
    }
    function hasExplicitInChainCtx(roleKey: string, key: string, rules: Map<string, Map<PrimaryKey | string, WithConditions<PropertyAllowed>>>, graph: RoleGraphData): boolean {
        const seen = new Set<string>();
        const stack = [roleKey];
        while (stack.length > 0) {
            const rk = stack.pop()!;
            if (seen.has(rk)) continue;
            seen.add(rk);
            if (rules.get(rk)?.has(key)) return true;
            for (const p of relatedToG(graph, rk)) stack.push(p);
        }
        return false;
    }
    function typeDefaultFromCtx(typeId: PrimaryKey, roleKey: string, ctx: PropAuthCtx): WithConditions<PropertyAllowed> {
        const ta = TypeAuthLogic.getAllowedFromCtx(typeId, roleKey, ctx.typeCtx, ctx.graph);
        return ta.mapWithConditions(t => typeBasicToProperty(typeAllowedUI(t)));
    }

    /** Explicit reset for setPropertyRulePack (whose deletes don't fire `saved`). Saves auto-invalidate.
     *  The next request's resolveContext re-reads the fresh rules into a new snapshot. */
    export function invalidate(): void {
        rulesLazy?.reset();
    }

    const compositeKey = (typeId: PrimaryKey, path: string): string => `${String(typeId)}|${path}`;

    async function loadRules(): Promise<Map<string, Map<PrimaryKey | string, WithConditions<PropertyAllowed>>>> {
        const rows = await table(RulePropertyEntity).toArray() as RulePropertyEntity[];
        const symbolById = new Map(SymbolLogic.symbols(TypeConditionSymbol).map(s => [String(s.id), s] as const));
        const map = new Map<string, Map<PrimaryKey | string, WithConditions<PropertyAllowed>>>();
        for (const row of rows) {
            const roleKey = row.role.key();
            let inner = map.get(roleKey);
            if (inner == null) { inner = new Map(); map.set(roleKey, inner); }
            inner.set(compositeKey(row.rootType.id, row.path), toWithConditions(row, symbolById));
        }
        return map;
    }

    function toWithConditions(row: RulePropertyEntity, symbolById: Map<string, TypeConditionSymbol>): WithConditions<PropertyAllowed> {
        const conditionRules = [...row.conditionRules]
            .sort((a, b) => Number(a.order) - Number(b.order))
            .map(cr => new ConditionRule<PropertyAllowed>(
                cr.conditions.map(c => {
                    const s = symbolById.get(String(c.symbol.id));
                    if (s == null) throw new Error(`TypeConditionSymbol id ${String(c.symbol.id)} is not registered`);
                    return s;
                }),
                cr.allowed));
        return new WithConditions<PropertyAllowed>(row.fallback, conditionRules);
    }

    const mergeProp = (strategy: MergeStrategy, baseValues: WithConditions<PropertyAllowed>[]): WithConditions<PropertyAllowed> =>
        mergeWithConditions(strategy, baseValues, PropertyAllowed.Write);

    // The type's allowance mapped to a property WithConditions — the no-rule DEFAULT (a property FOLLOWS its
    // type, incl. conditions: Signum's ToPropertyAllowed(type.GetUI())). Maps each TypeAllowed to its UI-read
    // as a PropertyAllowed.
    async function typeDefaultWC(typeId: PrimaryKey, roleKey: string): Promise<WithConditions<PropertyAllowed>> {
        const ta = await TypeAuthLogic.getAllowed(typeId, roleKey);
        return ta.mapWithConditions(t => typeBasicToProperty(typeAllowedUI(t)));
    }

    // Clamp each slice of a property's WithConditions to the type's per-slice ceiling (a property can't
    // exceed its type — Signum's Coerce). Applied when BUILDING the admin pack AND before PERSISTING, so a
    // value left stranded above a later-downgraded type never renders an empty radio nor gets stored.
    const condSetKey = (tcs: readonly TypeConditionSymbol[]): string => tcs.map(s => String(s.id)).sort().join("&");
    function coerceToCeiling(wc: WithConditions<PropertyAllowed>, ceiling: WithConditions<PropertyAllowed>): WithConditions<PropertyAllowed> {
        const ceilByKey = new Map(ceiling.conditionRules.map(cr => [condSetKey(cr.typeConditions), cr.allowed] as const));
        const clamp = (v: PropertyAllowed, ceil: PropertyAllowed): PropertyAllowed => Math.min(v, ceil) as PropertyAllowed;
        return new WithConditions<PropertyAllowed>(
            clamp(wc.fallback, ceiling.fallback),
            wc.conditionRules.map(cr => new ConditionRule<PropertyAllowed>([...cr.typeConditions], clamp(cr.allowed, ceilByKey.get(condSetKey(cr.typeConditions)) ?? ceiling.fallback))),
        );
    }

    // Signum's PropertyAuthLogic AutomaticUpgradeOfProperties: a property's allowance can NOT be resolved by
    // the generic AuthCache bubbling (computeAllowed), because a property with NO explicit rule follows ITS
    // OWN role's type allowance — which varies per role — rather than inheriting the parents' value. So the
    // recursion is bespoke: if no role in the chain has an explicit rule for this route, the property AUTO-
    // UPGRADES to this role's type default; otherwise it is the explicit rule (here) or the per-parent merge
    // (each parent resolved the SAME way, so a no-rule branch contributes its own type default). The final
    // clamp to the type ceiling is per-instance, in accessFromCtx.
    async function getAllowed(typeId: PrimaryKey, path: string, roleKey: string): Promise<WithConditions<PropertyAllowed>> {
        const { rules } = await rulesLazy.value();
        return propAllowed(typeId, compositeKey(typeId, path), roleKey, rules);
    }

    async function propAllowed(
        typeId: PrimaryKey,
        key: string,
        roleKey: string,
        rules: Map<string, Map<PrimaryKey | string, WithConditions<PropertyAllowed>>>,
    ): Promise<WithConditions<PropertyAllowed>> {
        if (!await hasExplicitInChain(roleKey, key, rules))
            return typeDefaultWC(typeId, roleKey); // no rule anywhere up the chain → follow this role's type
        const explicit = rules.get(roleKey)?.get(key);
        if (explicit !== undefined)
            return explicit;
        const parents = await AuthLogic.relatedTo(roleKey);
        return mergeProp(await AuthLogic.getMergeStrategy(roleKey), await Promise.all([...parents].map(p => propAllowed(typeId, key, p, rules))));
    }

    // True if roleKey OR any ancestor has an explicit property rule for `key` (Signum's "is overridden").
    async function hasExplicitInChain(roleKey: string, key: string, rules: Map<string, Map<PrimaryKey | string, WithConditions<PropertyAllowed>>>): Promise<boolean> {
        const seen = new Set<string>();
        const stack = [roleKey];
        while (stack.length > 0) {
            const rk = stack.pop()!;
            if (seen.has(rk)) continue;
            seen.add(rk);
            if (rules.get(rk)?.has(key))
                return true;
            for (const p of await AuthLogic.relatedTo(rk)) stack.push(p);
        }
        return false;
    }

    async function getAllowedBase(typeId: PrimaryKey, path: string, roleKey: string): Promise<WithConditions<PropertyAllowed>> {
        const parents = await AuthLogic.relatedTo(roleKey);
        if (parents.size === 0)
            return typeDefaultWC(typeId, roleKey);
        return mergeProp(await AuthLogic.getMergeStrategy(roleKey), await Promise.all([...parents].map(p => getAllowed(typeId, path, p))));
    }

    const symbolLite = (s: TypeConditionSymbol): Lite<TypeConditionSymbol> => TypeConditionSymbol.newLite(s.id, s.key);

    /** Min/max access RANK (0 None, 1 Read, 2 Write) over ALL property routes' fallback allowance — the
     *  grid's colour summary for the Properties drill-in. undefined when the type has no routes. */
    export async function fallbackSummary(typeName: string, roleKey: string): Promise<{ min: number; max: number } | undefined> {
        const ctor = Entity.resolveType(typeName);
        const typeId = TypeLogic.typeToId(ctor);
        const rank = (v: PropertyAllowed): number => v === PropertyAllowed.None ? 0 : v === PropertyAllowed.Read ? 1 : 2;
        let min = 2, max = 0, any = false;
        for (const route of PropertyRoute.generateRoutes(ctor, false)) {
            const r = rank((await getAllowed(typeId, route.propertyString(), roleKey)).fallback);
            if (r < min) min = r;
            if (r > max) max = r;
            any = true;
        }
        return any ? { min, max } : undefined;
    }

    function toModel(wc: WithConditions<PropertyAllowed>): PropertyWithConditionsModel {
        return PropertyWithConditionsModel.create({
            fallback: wc.fallback,
            conditionRules: wc.conditionRules.map(cr => PropertyConditionRuleModel.create({
                typeConditions: cr.typeConditions.map(symbolLite),
                allowed: cr.allowed,
            })),
        });
    }

    function fromModel(model: PropertyWithConditionsModel, symbolById: Map<string, TypeConditionSymbol>): WithConditions<PropertyAllowed> {
        return new WithConditions<PropertyAllowed>(model.fallback, model.conditionRules.map(cr =>
            new ConditionRule<PropertyAllowed>(
                cr.typeConditions.map(lite => {
                    const s = symbolById.get(String(lite.id));
                    if (s == null) throw new Error(`TypeConditionSymbol id ${String(lite.id)} is not registered`);
                    return s;
                }),
                cr.allowed)));
    }

    // The admin pack for one (role, type): every property route of the type with the role's allowed/base
    // (each a full WithConditionsModel), the coarse type ceiling (coerced), and the ROOT type's registered
    // availableConditions (offered when adding a condition rule).
    export async function getPropertyRulePack(typeName: string, roleId: PrimaryKey): Promise<PropertyRulePack> {
        const role = await table(RoleEntity).filter(r => r.id == roleId).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${roleId}' not found`);
        const roleKey = role.toLite().key();
        const ctor = Entity.resolveType(typeName);
        const typeId = TypeLogic.typeToId(ctor);
        // The per-slice ceiling = the type's own allowance mapped to PropertyAllowed (a property can't
        // exceed its type for any condition, so a None slice caps that slice's properties at None). Same
        // shape for every route, but emit a fresh model per row (each is an independent transport instance).
        const ceiling = await typeDefaultWC(typeId, roleKey); // the per-slice ceiling (same for every route)
        const rules: PropertyAllowedRule[] = [];
        for (const route of PropertyRoute.generateRoutes(ctor, false)) {
            const path = route.propertyString();
            rules.push(PropertyAllowedRule.create({
                path,
                allowed: toModel(coerceToCeiling(await getAllowed(typeId, path, roleKey), ceiling)),
                allowedBase: toModel(coerceToCeiling(await getAllowedBase(typeId, path, roleKey), ceiling)),
                coerced: toModel(ceiling),
            }));
        }
        rules.sort((a, b) => a.path.localeCompare(b.path));
        const conditionSets = await TypeAuthLogic.conditionSetsForType(typeId, roleKey);
        return PropertyRulePack.create({
            role: role.toLite(),
            type: TypeEntity.newLite(typeId, typeName),
            strategy: MergeStrategy[role.mergeStrategy],
            availableConditions: TypeConditionLogic.conditionsFor(ctor).map(symbolLite),
            availableTypeConditions: conditionSets.map(set => TypeConditionSetModel.create({ typeConditions: set.map(symbolLite) })),
            rules,
        });
    }

    // Persist the pack (scoped to this type's routes): redundant (allowed==base) → delete; else upsert the
    // fallback + owned condition rows.
    export async function setPropertyRulePack(pack: PropertyRulePack): Promise<void> {
        const role = await table(RoleEntity).filter(r => r.id == pack.role.id).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${pack.role.id}' not found`);
        const roleLite = role.toLite();
        const roleKey = roleLite.key();
        const symbolById = new Map(SymbolLogic.symbols(TypeConditionSymbol).map(s => [String(s.id), s] as const));
        const ceiling = await typeDefaultWC(pack.type.id, roleKey); // the per-slice type ceiling / auto-follow default
        const current = await table(RulePropertyEntity).filter(rp => rp.role == roleLite && rp.rootType == pack.type).toArray() as RulePropertyEntity[];
        const currentByPath = new Map(current.map(rp => [rp.path, rp]));

        for (const r of pack.rules) {
            const existing = currentByPath.get(r.path);
            // Coerce to the type ceiling (never store a value above the type), then drop no-op condition
            // rows (a slice whose allowed equals the fallback is a last-match-wins no-op).
            const coerced0 = coerceToCeiling(fromModel(r.allowed, symbolById), ceiling);
            const coerced = new WithConditions<PropertyAllowed>(coerced0.fallback, coerced0.conditionRules.filter(cr => cr.allowed !== coerced0.fallback));
            // A property with no explicit rule AUTO-FOLLOWS its type, so a rule equal to the type default
            // (trivial, e.g. Type Read + Property Read) OR to the inherited base is redundant → don't store.
            const isRedundant = coerced.equals(ceiling) || coerced.equals(fromModel(r.allowedBase, symbolById));
            if (isRedundant) {
                if (existing != null)
                    await existing.delete();
                continue;
            }
            const rp = existing ?? RulePropertyEntity.create({
                role: roleLite,
                rootType: TypeEntity.newLite(pack.type.id, pack.type.toString()),
                path: r.path,
            });
            rp.fallback = coerced.fallback;
            rp.conditionRules = coerced.conditionRules.map((cr, i) => RulePropertyConditionEntity.create({
                order: toInt(i),
                allowed: cr.allowed,
                conditions: cr.typeConditions.map(s => RulePropertyConditionEntity_Conditions.create({ symbol: symbolLite(s) })),
            }));
            await rp.save();
        }
        invalidate();
    }
}
