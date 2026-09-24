import "@altea/altea/server"; // Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // withQuery
import { SchemaBuilder } from "@altea/altea/server/schema";
import { ResetLazy } from "@altea/altea/server/resetLazy";
import { table } from "@altea/altea/server/table";
import { Entity, type PrimaryKey } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { OperationSymbol } from "@altea/altea/data/operations";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { toInt } from "@altea/altea/data/basics";
import { AuthLogic, RoleGraph } from "./AuthLogic";
import { MergeStrategy, RoleEntity } from "../data/Role";
import {
    RuleOperationEntity, RuleOperationConditionEntity, RuleOperationConditionEntity_Condition,
    OperationRulePack, OperationAllowedRule, OperationAllowed, TypeConditionSymbol, TypeConditionSetModel,
    OperationWithConditionsModel, OperationConditionRuleModel,
} from "../data/Rules";
import { TypeAuthLogic } from "./TypeAuthLogic";
import { computeAllowed, type ComputedCache } from "./AuthCache";
import { section, groupByRole, attrs, conditionsXml, parseEnum, sectionRows, syncRulesScript, conditionedRules, conditionSymbols, typeReplacementKey, type AuthImportCtx } from "./AuthRulesXml";
import type { SqlPreCommand } from "@altea/altea/server/sync/sqlPreCommand";
import type { AuthExportCtx } from "./AuthLogic";
import { WithConditions, ConditionRule, evaluateConditions, sliceValue } from "./WithConditions";
import { mergeWithConditions } from "./TypeConditionMerger";
import { TypeConditionLogic } from "./TypeConditionLogic";

// Port of Signum.Authorization's Rules/OperationAuthLogic.cs — see port/Auth.md.
//
// The operation dimension: a role's
// allowance per (operation, type) is a WithConditions<OperationAllowed> — a `fallback` + ordered type
// CONDITION rules (each an AND-ed set of TypeConditionSymbols → an OperationAllowed), evaluated
// last-match-wins against the operated ENTITY. OperationAllowed is 3-valued (None → blocked; DBOnly →
// server-code only, button hidden; Allow → everywhere). Enforcement is the core `OperationLogic.onAllow`
// hook: `assertOperationAllowed` (execute-time, inUserInterface:false) throws when denied, and
// `getEntityPack` omits UI-denied ops (inUserInterface:true).
//
// Rules are keyed by a composite `${operationId}/${typeId}` — the (OperationSymbol, Type) resource,
// flattened — the cache is async, and the cross-role merge is the generic 2^n condition merger. A
// Construct, or any operation with no entity, evaluates the `fallback`: there is no instance to test
// conditions against.
const compositeKey = (operationId: PrimaryKey, typeId: PrimaryKey): string => `${String(operationId)}/${String(typeId)}`;

const mergeOp = (strategy: MergeStrategy, baseValues: WithConditions<OperationAllowed>[]): WithConditions<OperationAllowed> =>
    mergeWithConditions(strategy, baseValues, OperationAllowed.Allow);

// Raw per-(operation,type) rules + role graph + merged memo, folded
// synchronously. Construct / no-entity operations evaluate the fallback (no instance to test conditions).
class OperationRulesCache {
    private readonly computed: ComputedCache<WithConditions<OperationAllowed>> = new Map();
    constructor(
        private readonly rules: Map<string, Map<PrimaryKey | string, WithConditions<OperationAllowed>>>,
        private readonly graph: RoleGraph,
    ) { }

    getAllowed(operationId: PrimaryKey, typeId: PrimaryKey, roleKey?: string): WithConditions<OperationAllowed> {
        const rk = roleKey ?? AuthLogic.currentRoleKey();
        if (rk == null)
            return WithConditions.simple(OperationAllowed.Allow);
        const getDefaultSync = (r: string): WithConditions<OperationAllowed> =>
            WithConditions.simple(this.graph.getDefaultAllowed(r) ? OperationAllowed.Allow : OperationAllowed.None);
        return computeAllowed<WithConditions<OperationAllowed>>(rk, compositeKey(operationId, typeId), this.rules, mergeOp, getDefaultSync, this.computed, this.graph);
    }

    getAllowedBase(operationId: PrimaryKey, typeId: PrimaryKey, roleKey: string): WithConditions<OperationAllowed> {
        const parents = this.graph.relatedTo(roleKey);
        if (parents.size === 0)
            return WithConditions.simple(this.graph.getDefaultAllowed(roleKey) ? OperationAllowed.Allow : OperationAllowed.None);
        return mergeOp(this.graph.getMergeStrategy(roleKey), [...parents].map(p => this.getAllowed(operationId, typeId, p)));
    }
}

export namespace OperationAuthLogic {
    let started = false;
    let rulesLazy: ResetLazy<OperationRulesCache>;

    export function isStarted(): boolean {
        return started;
    }

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;
        TypeAuthLogic.registerDimensionSummary("operations", sliceSummary); // grid icon colour summary
        // No `withQuery()` — see TypeAuthLogic.
        sb.include(RuleOperationEntity);
        // globalLazy runs the factory
        // in ExecutionMode.global, so the RuleOperation read is ungated.
        rulesLazy = sb.globalLazy(async () => new OperationRulesCache(await loadRules(), await AuthLogic.roleGraph()),
            { invalidateWith: [RuleOperationEntity, RoleEntity] });
        AuthLogic.invalidateBlobWith(rulesLazy);   // the blob is filtered per role, so a rule change stales it
        AuthLogic.registerXmlExporter(exportXml);
        AuthLogic.registerXmlImporter(importXml);
        // The execute / button-state authorization gate, now
        // condition-aware — the allowance is evaluated against the operated entity (fallback when absent).
        OperationLogic.onAllowOperation(async (symbol, entityType, inUserInterface, entity) => {
            const wc = (await rulesLazy.value()).getAllowed(symbol.id, (await TypeLogic.caches()).typeToId(entityType));
            const oa = entity != null
                ? evaluateConditions(wc, tc => TypeConditionLogic.inTypeCondition(entity, tc))
                : wc.fallback;
            return toBoolean(oa, inUserInterface);
        });
    }

    /** Explicit reset for setOperationRulePack (whose deletes don't fire `saved`). Saves auto-invalidate. */
    export function invalidate(): void {
        rulesLazy?.reset();
    }

    // UI shows the button only for Allow; server code may run DBOnly+.
    function toBoolean(oa: OperationAllowed, inUserInterface: boolean): boolean {
        return inUserInterface ? oa === OperationAllowed.Allow : oa >= OperationAllowed.DBOnly;
    }

    async function loadRules(): Promise<Map<string, Map<PrimaryKey | string, WithConditions<OperationAllowed>>>> {
        const rows = await table(RuleOperationEntity).toArray() as RuleOperationEntity[];
        const symbolById = new Map((await SymbolLogic.cache(TypeConditionSymbol)).symbols().map(s => [String(s.id), s]));
        const map = new Map<string, Map<PrimaryKey | string, WithConditions<OperationAllowed>>>();
        for (const row of rows) {
            const roleKey = row.role.key();
            let inner = map.get(roleKey);
            if (inner == null) { inner = new Map(); map.set(roleKey, inner); }
            inner.set(compositeKey(row.operation.id, row.type.id), toWithConditions(row, symbolById));
        }
        return map;
    }

    // A persisted RuleOperationEntity (fallback + owned condition rows) → the immutable runtime value.
    function toWithConditions(row: RuleOperationEntity, symbolById: Map<string, TypeConditionSymbol>): WithConditions<OperationAllowed> {
        const conditionRules = [...row.conditionRules]
            .orderBy(a => a.rowOrder)
            .map(cr => new ConditionRule<OperationAllowed>(
                cr.conditions.map(c => {
                    const s = symbolById.get(String(c.symbol.id));
                    if (s == null) throw new Error(`TypeConditionSymbol id ${String(c.symbol.id)} is not registered`);
                    return s;
                }),
                cr.allowed));
        return new WithConditions<OperationAllowed>(row.fallback, conditionRules);
    }

    /** Min/max access RANK (0 None, 1 DBOnly, 2 Allow) over ALL of the type's operations' allowance in one
     *  SLICE (the fallback, or one condition set) — the grid's colour summary for the Operations drill-in of
     *  the type row / a condition row. undefined when the type has none. */
    export async function sliceSummary(typeName: string, roleKey: string, slice?: readonly TypeConditionSymbol[]): Promise<{ min: number; max: number } | undefined> {
        const ctor = Entity.resolveType(typeName);
        const typeId = (await TypeLogic.caches()).typeToId(ctor);
        const rules = await rulesLazy.value();
        const rank = (v: OperationAllowed): number => v === OperationAllowed.None ? 0 : v === OperationAllowed.DBOnly ? 1 : 2;
        let min = 2, max = 0, any = false;
        for (const op of OperationLogic.operationsForTypeName(typeName)) {
            const r = rank(sliceValue(rules.getAllowed(op.id, typeId, roleKey), slice));
            if (r < min) min = r;
            if (r > max) max = r;
            any = true;
        }
        return any ? { min, max } : undefined;
    }

    const symbolLite = (s: TypeConditionSymbol): Lite<TypeConditionSymbol> => TypeConditionSymbol.newLite(s.id, s.key);

    function toModel(wc: WithConditions<OperationAllowed>): OperationWithConditionsModel {
        return OperationWithConditionsModel.create({
            fallback: wc.fallback,
            conditionRules: wc.conditionRules.map(cr => OperationConditionRuleModel.create({
                typeConditions: cr.typeConditions.map(symbolLite),
                allowed: cr.allowed,
            })),
        });
    }

    function fromModel(model: OperationWithConditionsModel, symbolById: Map<string, TypeConditionSymbol>): WithConditions<OperationAllowed> {
        return new WithConditions<OperationAllowed>(model.fallback, model.conditionRules.map(cr =>
            new ConditionRule<OperationAllowed>(
                cr.typeConditions.map(lite => {
                    const s = symbolById.get(String(lite.id));
                    if (s == null) throw new Error(`TypeConditionSymbol id ${String(lite.id)} is not registered`);
                    return s;
                }),
                cr.allowed)));
    }

    // The admin pack for one (role, type): every operation
    // applicable to the type with the role's effective `allowed` + inherited `allowedBase` (each a full
    // WithConditionsModel), plus the type's registered `availableConditions`.
    export async function getOperationRulePack(typeName: string, roleId: PrimaryKey): Promise<OperationRulePack> {
        const role = await table(RoleEntity).filter(r => r.id == roleId).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${roleId}' not found`);
        const roleKey = role.toLite().key();
        const ctor = Entity.resolveType(typeName);
        const typeId = (await TypeLogic.caches()).typeToId(ctor);
        const cache = await rulesLazy.value();
        const rules: OperationAllowedRule[] = [];
        for (const op of OperationLogic.operationsForTypeName(typeName)) {
            rules.push(OperationAllowedRule.create({
                operation: OperationSymbol.newLite(op.id, op.key),
                allowed: toModel(cache.getAllowed(op.id, typeId, roleKey)),
                allowedBase: toModel(cache.getAllowedBase(op.id, typeId, roleKey)),
                coerced: OperationAllowed.Allow,
            }));
        }
        rules.sort((a, b) => a.operation.toString().localeCompare(b.operation.toString()));
        const conditionSets = await TypeAuthLogic.conditionSetsForType(typeId, roleKey);
        return OperationRulePack.create({
            role: role.toLite(),
            type: TypeEntity.newLite(typeId, typeName),
            strategy: MergeStrategy[role.mergeStrategy],
            availableConditions: TypeConditionLogic.conditionsFor(ctor).map(symbolLite),
            availableTypeConditions: conditionSets.map(set => TypeConditionSetModel.create({ typeConditions: set.map(symbolLite) })),
            rules,
        });
    }

    // Persist the pack (scoped to this type's operations):
    // a value equal to its base is redundant (delete the explicit rule); else upsert the fallback + owned
    // condition rows. Then invalidate.
    export async function setOperationRulePack(pack: OperationRulePack): Promise<void> {
        const role = await table(RoleEntity).filter(r => r.id == pack.role.id).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${pack.role.id}' not found`);
        const roleLite = role.toLite();
        const symbolById = new Map((await SymbolLogic.cache(TypeConditionSymbol)).symbols().map(s => [String(s.id), s]));
        const current = await table(RuleOperationEntity).filter(ro => ro.role == roleLite && ro.type == pack.type).toArray() as RuleOperationEntity[];
        const currentByOp = new Map(current.map(ro => [String(ro.operation.id), ro]));

        for (const r of pack.rules) {
            const existing = currentByOp.get(String(r.operation.id));
            // Prune no-op condition rows (allowed == fallback) the slice editor may have created.
            const prunedAllowed = OperationWithConditionsModel.create({
                fallback: r.allowed.fallback,
                conditionRules: r.allowed.conditionRules.filter(cr => cr.allowed !== r.allowed.fallback),
            });
            const isRedundant = fromModel(prunedAllowed, symbolById).equals(fromModel(r.allowedBase, symbolById));
            if (isRedundant) {
                if (existing != null)
                    await existing.delete();
                continue;
            }
            const ro = existing ?? RuleOperationEntity.create({
                role: roleLite,
                operation: OperationSymbol.newLite(r.operation.id, r.operation.toString()),
                type: TypeEntity.newLite(pack.type.id, pack.type.toString()),
            });
            ro.fallback = prunedAllowed.fallback;
            ro.conditionRules = prunedAllowed.conditionRules.map((cr, i) => RuleOperationConditionEntity.create({
                rowOrder: toInt(i),
                allowed: cr.allowed,
                conditions: cr.typeConditions.map(lite => RuleOperationConditionEntity_Condition.create({ symbol: lite })),
            }));
            await ro.save();
        }
        invalidate();
    }

    // ---- AuthRules XML -------------------------------------------------------------------------
    async function exportXml(ctx: AuthExportCtx): Promise<{ name: string; content: unknown }> {
        const typeName = new Map((await table(TypeEntity).toArray() as TypeEntity[]).map(t => [String(t.id), t.cleanName]));
        const opKey = new Map((await SymbolLogic.cache(OperationSymbol)).symbols().map(s => [String(s.id), s.key]));
        const condKey = new Map((await SymbolLogic.cache(TypeConditionSymbol)).symbols().map(s => [String(s.id), s.key]));
        const rules = await rulesLazy.value();
        const stored = await table(RuleOperationEntity).toArray() as RuleOperationEntity[];
        const byRole = groupByRole(stored.filter(r =>
            !rules.getAllowed(r.operation.id!, r.type.id!, r.role.key()).equals(rules.getAllowedBase(r.operation.id!, r.type.id!, r.role.key()))));
        return {
            name: "Operations",
            content: section("Operation", ctx.orderedRoleKeys, ctx.roleName, byRole, r => {
                const conds = conditionsXml(r.conditionRules, v => OperationAllowed[v], id => condKey.get(String(id)) ?? String(id));
                return {
                    ...attrs({
                        // Signum's `Operation.Key/Type`.
                        Resource: (opKey.get(String(r.operation.id)) ?? String(r.operation.id)) + "/" + (typeName.get(String(r.type.id)) ?? String(r.type.id)),
                        Allowed: OperationAllowed[r.fallback],
                    }),
                    ...(conds.length ? { Condition: conds } : {}),
                };
            }),
        };
    }

    async function importXml(auth: Record<string, unknown>, ctx: AuthImportCtx): Promise<SqlPreCommand | undefined> {
        const operationReplacementKey = "AuthRules:OperationSymbol";
        const symbols = new Map((await SymbolLogic.cache(OperationSymbol)).symbols().map(s => [s.key, s]));
        // Signum's `Operation.Key/Type`.
        const allResources = new Set(sectionRows(auth, "Operations", "Operation").map(p => p.Resource));
        ctx.replacements.askForReplacements(
            new Set([...allResources].map(a => a.includes("/") ? a.slice(0, a.indexOf("/")) : a)),
            new Set(symbols.keys()),
            operationReplacementKey);
        ctx.replacements.askForReplacements(
            new Set([...allResources].map(a => a.slice(a.indexOf("/") + 1))),
            new Set(ctx.nameToType.keys()),
            typeReplacementKey);

        const caches = await TypeLogic.caches();
        const opKey = new Map([...symbols.values()].map(s => [String(s.id), s.key]));
        const rules = conditionedRules<RuleOperationEntity>(OperationAllowed);
        return syncRulesScript(auth, ctx, {
            rootName: "Operations",
            elementName: "Operation",
            resourceName: "Operation Type",
            stored: await table(RuleOperationEntity).toArray() as RuleOperationEntity[],
            storedKey: r => (opKey.get(String(r.operation.id)) ?? String(r.operation.id)) + "/" + (caches.idToEntity(r.type.id)?.cleanName ?? String(r.type.id)),
            toResource: s => {
                const operation = symbols.get(ctx.replacements.apply(operationReplacementKey, s.slice(0, s.indexOf("/"))));
                const typeName = ctx.replacements.apply(typeReplacementKey, s.slice(s.indexOf("/") + 1));
                const type = ctx.nameToType.get(typeName);
                if (operation == null || type == null || !OperationLogic.operationsForType(type).some(o => o.key === operation.key)) {
                    ctx.noteSkipped("Operation", s);
                    return undefined;
                }
                return operation.key + "/" + typeName;
            },
            create: (role, key, x) => RuleOperationEntity.create({
                role,
                operation: symbols.get(key.slice(0, key.indexOf("/")))!.toLite(),
                type: ctx.typeToEntity(ctx.nameToType.get(key.slice(key.indexOf("/") + 1))!).toLite(),
                fallback: parseEnum(OperationAllowed, x.Allowed),
                conditionRules: (x.Condition ?? []).map(xc => RuleOperationConditionEntity.create({
                    allowed: parseEnum(OperationAllowed, xc.Allowed),
                    conditions: conditionSymbols(xc, ctx).map(tc => RuleOperationConditionEntity_Condition.create({ symbol: tc.toLite() })),
                })),
            }),
            allowedComment: rules.allowedComment,
            update: rules.update,
        });
    }
}
