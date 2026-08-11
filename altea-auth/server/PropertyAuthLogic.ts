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
import { AuthLogic } from "./AuthLogic";
import { TypeAuthLogic } from "./TypeAuthLogic";
import { TypeConditionLogic } from "./TypeConditionLogic";
import { MergeStrategy, RoleEntity } from "../data/Role";
import {
    RulePropertyEntity, RulePropertyConditionEntity, RulePropertyConditionEntity_Conditions,
    RuleTypeEntity, PropertyRulePack, PropertyAllowedRule, PropertyAllowed, TypeAllowed, TypeAllowedBasic,
    PropertyWithConditionsModel, PropertyConditionRuleModel, TypeConditionSymbol,
    typeAllowedUI, typeBasicToProperty,
} from "../data/Rules";
import { WithConditions, ConditionRule, evaluateConditions } from "./WithConditions";
import { mergeWithConditions } from "./TypeConditionMerger";
import { setSerializationAuth, type PropertyAccess } from "@altea/altea/data/serializer/graphSerializers";
import { Serializer } from "@altea/altea/data/serializer";
import { setRequestDeserializer } from "@altea/altea/server/webApi";
import * as Database from "@altea/altea/server/Database";
import type { Schema } from "@altea/altea/server/schema";

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
// SYNCHRONOUS, so — like Signum's warm GlobalLazy — property access is served from an always-WARM sync
// snapshot (`_syncSnapshot`: roleKey → typeId → path → PropertyAllowed) materialised at schema.initialize()
// and re-warmed when a property / type / role rule changes. None → the value is omitted server→client +
// its line hidden (propsMeta); Read → read-only (kept on save); Write → normal.
export namespace PropertyAuthLogic {
    let started = false;
    let _schema: Schema | undefined;
    interface RulesCache {
        rules: Map<string, Map<PrimaryKey | string, WithConditions<PropertyAllowed>>>;
    }
    let rulesLazy: ResetLazy<Promise<RulesCache>>;
    // Signum's warm property cache, materialised for the SYNC serializer. Per (role, type): the type's own
    // allowance (to clamp a property to its type's UI-read PER INSTANCE) + each route's WithConditions. The
    // scalar access is resolved at serialize time by evaluating both against the concrete root entity.
    interface TypeSnap {
        ceiling: WithConditions<TypeAllowed>;
        byPath: Map<string, WithConditions<PropertyAllowed>>;
    }
    let _syncSnapshot = new Map<string, Map<PrimaryKey, TypeSnap>>();

    export function isStarted(): boolean {
        return started;
    }

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;
        _schema = sb.schema;
        sb.include(RulePropertyEntity).withQuery();
        // invalidateWith RuleType too: the no-rule default / coerced ceiling derive from the type's UI-read
        // allowance, so a type-rule change must reset the property cache.
        rulesLazy = sb.globalLazy(async () => ({ rules: await loadRules() }),
            { invalidateWith: [RulePropertyEntity, RuleTypeEntity, RoleEntity] });
        // Warm the sync snapshot after gen/sync (initialize), and re-warm when any dimension it derives
        // from changes. Install the serializer hook once (it reads the snapshot synchronously).
        sb.schema.initializing.push(() => warmSyncSnapshot());
        for (const t of [RulePropertyEntity, RuleTypeEntity, RoleEntity] as Type<Entity>[])
            sb.schema.entityEvents(t).saved.push(() => void warmSyncSnapshot());
        setSerializationAuth({
            getMetadata: root => root,   // the root ENTITY — access evaluates its type-conditions per instance
            access: (route, meta) => toAccess(accessSync(meta as Entity, route.propertyString())),
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

    // SYNC property access for the current role (serializer path), evaluated against the concrete root
    // ENTITY (so type conditions resolve). No role / not warmed / unknown route → Write (fail-open — a
    // not-yet-warmed snapshot must not hide data). The property's per-instance value is clamped by the
    // type's per-instance UI-read allowance (a property can't exceed its type — Signum's CoerceValue).
    function accessSync(root: Entity, path: string): PropertyAllowed {
        const roleKey = AuthLogic.currentRoleKey();
        if (roleKey == null || !AuthLogic.isEnabled())
            return PropertyAllowed.Write;
        let typeId: PrimaryKey;
        try { typeId = TypeLogic.typeToId(root.constructor); } catch { return PropertyAllowed.Write; }
        const snap = _syncSnapshot.get(roleKey)?.get(typeId);
        const wc = snap?.byPath.get(path);
        if (snap == null || wc == null)
            return PropertyAllowed.Write;
        const matches = (tc: TypeConditionSymbol): boolean => TypeConditionLogic.inTypeCondition(root, tc);
        const prop = evaluateConditions(wc, matches);
        const ceil = typeBasicToProperty(typeAllowedUI(evaluateConditions(snap.ceiling, matches)));
        return Math.min(prop, ceil) as PropertyAllowed;
    }

    // Materialise the warm snapshot: every role × every entity type → { type ceiling + each route's
    // WithConditions }. Bounded (roles × types × routes); mirrors Signum's warm property GlobalLazy. The
    // per-instance scalar is resolved later, in accessSync, against the concrete entity.
    async function warmSyncSnapshot(): Promise<void> {
        if (_schema == null) return;
        try {
            const roleKeys = [...(await AuthLogic.roleGraph()).rolesByKey.keys()];
            const ctors = [...(_schema.tables.keys() as Iterable<unknown>)].filter((c): c is Function => typeof c === "function");
            const next = new Map<string, Map<PrimaryKey, TypeSnap>>();
            for (const rk of roleKeys) {
                const byType = new Map<PrimaryKey, TypeSnap>();
                for (const ctor of ctors) {
                    let typeId: PrimaryKey;
                    try { typeId = TypeLogic.typeToId(ctor); } catch { continue; }
                    const ceiling = await TypeAuthLogic.getAllowed(typeId, rk);
                    const byPath = new Map<string, WithConditions<PropertyAllowed>>();
                    for (const route of PropertyRoute.generateRoutes(ctor, false))
                        byPath.set(route.propertyString(), await getAllowed(typeId, route.propertyString(), rk));
                    byType.set(typeId, { ceiling, byPath });
                }
                next.set(rk, byType);
            }
            _syncSnapshot = next;
        } catch (e) {
            // Tolerate a not-yet-migrated / unavailable rule table (e.g. during `terminal sync`, which runs
            // schema.initialize BEFORE applying the DDL). Leave the snapshot as-is → accessSync fails OPEN
            // (Write). A normal API start (migrated DB) succeeds; saved-events + invalidate re-warm later.
            console.warn("[property-auth] warm snapshot skipped:", (e as Error).message);
        }
    }

    /** Explicit reset for setPropertyRulePack (whose deletes don't fire `saved`). Saves auto-invalidate. */
    export function invalidate(): void {
        rulesLazy?.reset();
        void warmSyncSnapshot(); // keep the sync serializer snapshot in step after a pack edit
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

    // The coarse scalar ceiling for the admin pack's `coerced` (the type's max UI-read as PropertyAllowed).
    async function typeCeilingScalar(typeId: PrimaryKey, roleKey: string): Promise<PropertyAllowed> {
        if (await TypeAuthLogic.isAllowedForType(typeId, TypeAllowedBasic.Write, true, roleKey))
            return PropertyAllowed.Write;
        if (await TypeAuthLogic.isAllowedForType(typeId, TypeAllowedBasic.Read, true, roleKey))
            return PropertyAllowed.Read;
        return PropertyAllowed.None;
    }

    // Signum's PropertyAuthLogic AutomaticUpgradeOfProperties: a property's allowance can NOT be resolved by
    // the generic AuthCache bubbling (computeAllowed), because a property with NO explicit rule follows ITS
    // OWN role's type allowance — which varies per role — rather than inheriting the parents' value. So the
    // recursion is bespoke: if no role in the chain has an explicit rule for this route, the property AUTO-
    // UPGRADES to this role's type default; otherwise it is the explicit rule (here) or the per-parent merge
    // (each parent resolved the SAME way, so a no-rule branch contributes its own type default). The final
    // clamp to the type ceiling is per-instance, in accessSync.
    async function getAllowed(typeId: PrimaryKey, path: string, roleKey: string): Promise<WithConditions<PropertyAllowed>> {
        const { rules } = await rulesLazy.value;
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
        const ceiling = await typeCeilingScalar(typeId, roleKey);
        const rules: PropertyAllowedRule[] = [];
        for (const route of PropertyRoute.generateRoutes(ctor, false)) {
            const path = route.propertyString();
            rules.push(PropertyAllowedRule.create({
                path,
                allowed: toModel(await getAllowed(typeId, path, roleKey)),
                allowedBase: toModel(await getAllowedBase(typeId, path, roleKey)),
                coerced: ceiling,
            }));
        }
        rules.sort((a, b) => a.path.localeCompare(b.path));
        return PropertyRulePack.create({
            role: role.toLite(),
            type: TypeEntity.newLite(typeId, typeName),
            strategy: MergeStrategy[role.mergeStrategy],
            availableConditions: TypeConditionLogic.conditionsFor(ctor).map(symbolLite),
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
        const symbolById = new Map(SymbolLogic.symbols(TypeConditionSymbol).map(s => [String(s.id), s] as const));
        const current = await table(RulePropertyEntity).filter(rp => rp.role == roleLite && rp.rootType == pack.type).toArray() as RulePropertyEntity[];
        const currentByPath = new Map(current.map(rp => [rp.path, rp]));

        for (const r of pack.rules) {
            const existing = currentByPath.get(r.path);
            const isRedundant = fromModel(r.allowed, symbolById).equals(fromModel(r.allowedBase, symbolById));
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
            rp.fallback = r.allowed.fallback;
            rp.conditionRules = r.allowed.conditionRules.map((cr, i) => RulePropertyConditionEntity.create({
                order: toInt(i),
                allowed: cr.allowed,
                conditions: cr.typeConditions.map(lite => RulePropertyConditionEntity_Conditions.create({ symbol: lite })),
            }));
            await rp.save();
        }
        invalidate();
    }
}
