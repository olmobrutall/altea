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
import { AuthLogic, RoleGraph } from "./AuthLogic";
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
import { section, groupByRole, attrs, conditionsXml, applyPerType, condLites, parseEnum, type AuthImportCtx, type XmlRoleBlock } from "./AuthRulesXml";
import type { AuthExportCtx } from "./AuthLogic";
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
const compositeKey = (typeId: PrimaryKey, path: string): string => `${String(typeId)}|${path}`;

const mergeProp = (strategy: MergeStrategy, baseValues: WithConditions<PropertyAllowed>[]): WithConditions<PropertyAllowed> =>
    mergeWithConditions(strategy, baseValues, PropertyAllowed.Write);

// Signum's AuthCache as a CLASS — and, since it is fully synchronous once loaded, it IS the serialization
// auth context (Phase 2): the codec's async boundary resolves ONE of these (`resolveContext`) and the sync
// `access` reads it. Holds the property rules + role graph + the captured TYPE-rule cache (a property is
// capped by, and defaults to, its type's UI-read allowance). A concurrent invalidate() can't affect an
// in-flight serialization — the instance the request captured is frozen.
class PropertyRulesCache {
    constructor(
        private readonly propRules: Map<string, Map<PrimaryKey | string, WithConditions<PropertyAllowed>>>,
        private readonly graph: RoleGraph,
        private readonly typeCache: TypeAuthLogic.TypeRulesCache,
    ) { }

    // Per-instance property access for the current role (serializer path), evaluated against the concrete
    // root ENTITY (so type conditions resolve). No role / auth off / unknown route → Write (fail open). The
    // per-instance value is clamped to the type's per-instance UI-read allowance (Signum's CoerceValue).
    access(root: Entity, path: string): PropertyAllowed {
        const roleKey = AuthLogic.currentRoleKey();
        if (roleKey == null || !AuthLogic.isEnabled())
            return PropertyAllowed.Write;
        let typeId: PrimaryKey;
        try { typeId = TypeLogic.typeToId(root.constructor); } catch { return PropertyAllowed.Write; }
        const wc = this.propAllowed(typeId, compositeKey(typeId, path), roleKey);
        const ceilingWC = this.typeCache.getAllowed(typeId, roleKey);
        const matches = (tc: TypeConditionSymbol): boolean => TypeConditionLogic.inTypeCondition(root, tc);
        const prop = evaluateConditions(wc, matches);
        const ceil = typeBasicToProperty(typeAllowedUI(evaluateConditions(ceilingWC, matches)));
        return Math.min(prop, ceil) as PropertyAllowed;
    }

    getAllowed(typeId: PrimaryKey, path: string, roleKey: string): WithConditions<PropertyAllowed> {
        return this.propAllowed(typeId, compositeKey(typeId, path), roleKey);
    }

    // The type's allowance mapped to a property WithConditions — the no-rule DEFAULT (a property FOLLOWS its
    // type, incl. conditions: Signum's ToPropertyAllowed(type.GetUI())).
    typeDefaultWC(typeId: PrimaryKey, roleKey: string): WithConditions<PropertyAllowed> {
        return this.typeCache.getAllowed(typeId, roleKey).mapWithConditions(t => typeBasicToProperty(typeAllowedUI(t)));
    }

    // Signum's AutomaticUpgradeOfProperties: a property with NO explicit rule follows ITS OWN role's type
    // allowance (varies per role), not the parents' value — so this recursion is bespoke (not computeAllowed):
    // no explicit rule up the chain → this role's type default; else the explicit rule or the per-parent merge.
    private propAllowed(typeId: PrimaryKey, key: string, roleKey: string): WithConditions<PropertyAllowed> {
        if (!this.hasExplicitInChain(roleKey, key))
            return this.typeDefaultWC(typeId, roleKey);
        const explicit = this.propRules.get(roleKey)?.get(key);
        if (explicit !== undefined)
            return explicit;
        const parents = this.graph.relatedTo(roleKey);
        return mergeProp(this.graph.getMergeStrategy(roleKey), [...parents].map(p => this.propAllowed(typeId, key, p)));
    }

    // True if roleKey OR any ancestor has an explicit property rule for `key` (Signum's "is overridden").
    private hasExplicitInChain(roleKey: string, key: string): boolean {
        const seen = new Set<string>();
        const stack = [roleKey];
        while (stack.length > 0) {
            const rk = stack.pop()!;
            if (seen.has(rk)) continue;
            seen.add(rk);
            if (this.propRules.get(rk)?.has(key)) return true;
            for (const p of this.graph.relatedTo(rk)) stack.push(p);
        }
        return false;
    }

    getAllowedBase(typeId: PrimaryKey, path: string, roleKey: string): WithConditions<PropertyAllowed> {
        const parents = this.graph.relatedTo(roleKey);
        if (parents.size === 0)
            return this.typeDefaultWC(typeId, roleKey);
        return mergeProp(this.graph.getMergeStrategy(roleKey), [...parents].map(p => this.getAllowed(typeId, path, p)));
    }
}

export namespace PropertyAuthLogic {
    let started = false;
    let rulesLazy: ResetLazy<PropertyRulesCache>;

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
        rulesLazy = sb.globalLazy(async () => new PropertyRulesCache(await loadRules(), await AuthLogic.roleGraph(), await TypeAuthLogic.rulesCache()),
            { invalidateWith: [RulePropertyEntity, RuleTypeEntity, RoleEntity] });
        // The serializer is SYNCHRONOUS. Per request the codec calls `resolveContext` ONCE (async, before the
        // walk) to capture the loaded PropertyRulesCache — which IS the serialization-auth context — and then
        // reads it synchronously in `access`. A concurrent invalidate() can't affect an in-flight walk: the
        // instance the request captured is frozen (Signum keeps its RoleAllowedCache warm; altea snapshots it).
        setSerializationAuth({
            getMetadata: root => root,   // the root ENTITY — access evaluates its type-conditions per instance
            access: (route, meta, context) => {
                const cache = context as PropertyRulesCache | undefined;
                return cache == null ? "writable" : toAccess(cache.access(meta as Entity, route.propertyString()));
            },
            resolveContext: () => rulesLazy.value(),
        });
        // The WRITE gate: make the retrieve implicit in the request deserializer. When the body carries an
        // existing (id) + modified root entity, load its DB original and overlay the incoming changes onto
        // it — so the codec keeps read-only / hidden properties at their stored value. Everything else
        // deserializes exactly as before (new entities, references, non-entity bodies).
        setRequestDeserializer(deserializeRequest);
        AuthLogic.registerXmlExporter(exportXml);
        AuthLogic.registerXmlImporter(importXml);
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

    // Serializer PropertyAllowed → the codec's access verb.
    function toAccess(pa: PropertyAllowed): PropertyAccess {
        return pa === PropertyAllowed.None ? "hidden" : pa === PropertyAllowed.Read ? "readonly" : "writable";
    }

    /** Explicit reset for setPropertyRulePack (whose deletes don't fire `saved`). Saves auto-invalidate.
     *  The next request's resolveContext re-reads the fresh rules into a new PropertyRulesCache. */
    export function invalidate(): void {
        rulesLazy?.reset();
    }

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

    // The type's allowance mapped to a property WithConditions — the no-rule DEFAULT / per-slice ceiling.
    async function typeDefaultWC(typeId: PrimaryKey, roleKey: string): Promise<WithConditions<PropertyAllowed>> {
        return (await rulesLazy.value()).typeDefaultWC(typeId, roleKey);
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

    // The role's effective / inherited-base property allowance (Signum's GetAllowed / GetAllowedBase) —
    // the AutomaticUpgradeOfProperties recursion lives on the cache; these just await + delegate.
    async function getAllowed(typeId: PrimaryKey, path: string, roleKey: string): Promise<WithConditions<PropertyAllowed>> {
        return (await rulesLazy.value()).getAllowed(typeId, path, roleKey);
    }

    async function getAllowedBase(typeId: PrimaryKey, path: string, roleKey: string): Promise<WithConditions<PropertyAllowed>> {
        return (await rulesLazy.value()).getAllowedBase(typeId, path, roleKey);
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

    // ---- AuthRules XML (Signum's PropertyCache.ExportXml / ImportXml) --------------------------
    async function exportXml(ctx: AuthExportCtx): Promise<{ name: string; content: unknown }> {
        const typeName = new Map((await table(TypeEntity).toArray() as TypeEntity[]).map(t => [String(t.id), t.cleanName]));
        const condKey = new Map(SymbolLogic.symbols(TypeConditionSymbol).map(s => [String(s.id), s.key]));
        const byRole = groupByRole(await table(RulePropertyEntity).toArray() as RulePropertyEntity[]);
        return {
            name: "Properties",
            content: section("Property", ctx.orderedRoleKeys, ctx.roleName, byRole, r => {
                const conds = conditionsXml(r.conditionRules, v => PropertyAllowed[v], id => condKey.get(String(id)) ?? String(id));
                return {
                    ...attrs({ OnType: typeName.get(String(r.rootType.id)) ?? String(r.rootType.id), Resource: r.path, Allowed: PropertyAllowed[r.fallback] }),
                    ...(conds.length ? { Condition: conds } : {}),
                };
            }),
        };
    }

    const cloneModel = (m: PropertyWithConditionsModel): PropertyWithConditionsModel => PropertyWithConditionsModel.create({
        fallback: m.fallback,
        conditionRules: m.conditionRules.map(cr => PropertyConditionRuleModel.create({ allowed: cr.allowed, typeConditions: [...cr.typeConditions] })),
    });

    async function importXml(auth: Record<string, unknown>, ctx: AuthImportCtx): Promise<void> {
        await applyPerType((auth.Properties as { Role?: XmlRoleBlock[] } | undefined)?.Role, "Property", ctx, async (role, typeName, byKey) => {
            const pack = await getPropertyRulePack(typeName, role.id);
            for (const rule of pack.rules) {
                const x = byKey.get(rule.path);
                rule.allowed = x != null
                    ? PropertyWithConditionsModel.create({
                        fallback: parseEnum(PropertyAllowed, x.Allowed),
                        conditionRules: (x.Condition ?? []).map(c => PropertyConditionRuleModel.create({
                            allowed: parseEnum(PropertyAllowed, c.Allowed),
                            typeConditions: condLites(c, ctx).map(l => TypeConditionSymbol.newLite(l.id, l.key)),
                        })),
                    })
                    : cloneModel(rule.allowedBase);
            }
            await setPropertyRulePack(pack);
        }, r => r.Resource);
    }
}
