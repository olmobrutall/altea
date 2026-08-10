import "@altea/altea/server"; // Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // withQuery
import { SchemaBuilder } from "@altea/altea/server/schema";
import { ResetLazy } from "@altea/altea/data/resetLazy";
import { table } from "@altea/altea/server/table";
import { Entity, type PrimaryKey } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { OperationSymbol } from "@altea/altea/data/operations";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { toInt } from "@altea/altea/data/basics";
import { AuthLogic } from "./AuthLogic";
import { MergeStrategy, RoleEntity } from "../data/Role";
import {
    RuleOperationEntity, RuleOperationConditionEntity, RuleOperationConditionEntity_Conditions,
    OperationRulePack, OperationAllowedRule, OperationAllowed, TypeConditionSymbol,
    OperationWithConditionsModel, OperationConditionRuleModel,
} from "../data/Rules";
import { computeAllowed, type ComputedCache } from "./AuthCache";
import { WithConditions, ConditionRule, evaluateConditions } from "./WithConditions";
import { mergeWithConditions } from "./TypeConditionMerger";
import { TypeConditionLogic } from "./TypeConditionLogic";

// Port of Signum's OperationAuthLogic (Rules/OperationAuthLogic.cs). The operation dimension: a role's
// allowance per (operation, type) is a WithConditions<OperationAllowed> — a `fallback` + ordered type
// CONDITION rules (each an AND-ed set of TypeConditionSymbols → an OperationAllowed), evaluated
// last-match-wins against the operated ENTITY. OperationAllowed is 3-valued (None → blocked; DBOnly →
// server-code only, button hidden; Allow → everywhere). Enforcement is the core `OperationLogic.onAllow`
// hook: `assertOperationAllowed` (execute-time, inUserInterface:false) throws when denied, and
// `getEntityPack` omits UI-denied ops (inUserInterface:true).
//
// altea divergences: rules keyed by a composite `${operationId}/${typeId}` (Signum's (OperationSymbol,
// Type) resource, flattened); async cache via `sb.globalLazy` + `computeAllowed`; the cross-role merge is
// the generic 2^n condition merger. Construct / no-entity operations evaluate the `fallback` (no instance
// to test conditions against).
export namespace OperationAuthLogic {
    let started = false;
    interface RulesCache {
        rules: Map<string, Map<PrimaryKey | string, WithConditions<OperationAllowed>>>;
        computed: ComputedCache<WithConditions<OperationAllowed>>;
    }
    let rulesLazy: ResetLazy<Promise<RulesCache>>;

    export function isStarted(): boolean {
        return started;
    }

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;
        sb.include(RuleOperationEntity).withQuery();
        // Signum's `sb.GlobalLazy(rules, InvalidateWith(RuleOperation, Role))`. globalLazy runs the factory
        // in ExecutionMode.global, so the RuleOperation read is ungated.
        rulesLazy = sb.globalLazy(async () => ({ rules: await loadRules(), computed: new Map() }),
            { invalidateWith: [RuleOperationEntity, RoleEntity] });
        // Signum's OperationLogic.AllowOperation += … : the execute/button-state authorization gate, now
        // condition-aware — the allowance is evaluated against the operated entity (fallback when absent).
        OperationLogic.onAllowOperation(async (symbol, entityType, inUserInterface, entity) => {
            const wc = await getAllowed(symbol.id, TypeLogic.typeToId(entityType));
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

    // Signum's OperationAllowed.ToBoolean: UI shows the button only for Allow; server code may run DBOnly+.
    function toBoolean(oa: OperationAllowed, inUserInterface: boolean): boolean {
        return inUserInterface ? oa === OperationAllowed.Allow : oa >= OperationAllowed.DBOnly;
    }

    const compositeKey = (operationId: PrimaryKey, typeId: PrimaryKey): string => `${String(operationId)}/${String(typeId)}`;

    async function loadRules(): Promise<Map<string, Map<PrimaryKey | string, WithConditions<OperationAllowed>>>> {
        const rows = await table(RuleOperationEntity).toArray() as RuleOperationEntity[];
        const symbolById = new Map(SymbolLogic.symbols(TypeConditionSymbol).map(s => [String(s.id), s]));
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
            .sort((a, b) => Number(a.order) - Number(b.order))
            .map(cr => new ConditionRule<OperationAllowed>(
                cr.conditions.map(c => {
                    const s = symbolById.get(String(c.symbol.id));
                    if (s == null) throw new Error(`TypeConditionSymbol id ${String(c.symbol.id)} is not registered`);
                    return s;
                }),
                cr.allowed));
        return new WithConditions<OperationAllowed>(row.fallback, conditionRules);
    }

    const mergeOp = (strategy: MergeStrategy, baseValues: WithConditions<OperationAllowed>[]): WithConditions<OperationAllowed> =>
        mergeWithConditions(strategy, baseValues, OperationAllowed.Allow);

    const getDefaultOp = async (roleKey: string): Promise<WithConditions<OperationAllowed>> =>
        WithConditions.simple((await AuthLogic.getDefaultAllowed(roleKey)) ? OperationAllowed.Allow : OperationAllowed.None);

    /** The full WithConditions<OperationAllowed> for (operation, type) and the current role (or given role).
     *  No current role (anonymous / auth off) → simple Allow. */
    async function getAllowed(operationId: PrimaryKey, typeId: PrimaryKey, roleKey?: string): Promise<WithConditions<OperationAllowed>> {
        const rk = roleKey ?? AuthLogic.currentRoleKey();
        if (rk == null)
            return WithConditions.simple(OperationAllowed.Allow);
        const { rules, computed } = await rulesLazy.value;
        return computeAllowed<WithConditions<OperationAllowed>>(rk, compositeKey(operationId, typeId), rules, mergeOp, getDefaultOp, computed);
    }

    // The value with NO explicit rule (Signum's AuthCache.GetAllowedBase): merge of direct parents, or the
    // role default at a root role.
    async function getAllowedBase(operationId: PrimaryKey, typeId: PrimaryKey, roleKey: string): Promise<WithConditions<OperationAllowed>> {
        const parents = await AuthLogic.relatedTo(roleKey);
        if (parents.size === 0)
            return getDefaultOp(roleKey);
        return mergeOp(await AuthLogic.getMergeStrategy(roleKey), await Promise.all([...parents].map(p => getAllowed(operationId, typeId, p))));
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

    // Signum's OperationAuthLogic.GetOperationRules — the admin pack for one (role, type): every operation
    // applicable to the type with the role's effective `allowed` + inherited `allowedBase` (each a full
    // WithConditionsModel), plus the type's registered `availableConditions`.
    export async function getOperationRulePack(typeName: string, roleId: PrimaryKey): Promise<OperationRulePack> {
        const role = await table(RoleEntity).filter(r => r.id == roleId).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${roleId}' not found`);
        const roleKey = role.toLite().key();
        const ctor = Entity.resolveType(typeName);
        const typeId = TypeLogic.typeToId(ctor);
        const rules: OperationAllowedRule[] = [];
        for (const op of OperationLogic.operationsForType(typeName)) {
            rules.push(OperationAllowedRule.create({
                operation: OperationSymbol.newLite(op.id, op.key),
                allowed: toModel(await getAllowed(op.id, typeId, roleKey)),
                allowedBase: toModel(await getAllowedBase(op.id, typeId, roleKey)),
                coerced: OperationAllowed.Allow,
            }));
        }
        rules.sort((a, b) => a.operation.toString().localeCompare(b.operation.toString()));
        return OperationRulePack.create({
            role: role.toLite(),
            type: TypeEntity.newLite(typeId, typeName),
            strategy: MergeStrategy[role.mergeStrategy],
            availableConditions: TypeConditionLogic.conditionsFor(ctor).map(symbolLite),
            rules,
        });
    }

    // Signum's OperationAuthLogic.SetOperationRules — persist the pack (scoped to this type's operations):
    // a value equal to its base is redundant (delete the explicit rule); else upsert the fallback + owned
    // condition rows. Then invalidate.
    export async function setOperationRulePack(pack: OperationRulePack): Promise<void> {
        const role = await table(RoleEntity).filter(r => r.id == pack.role.id).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${pack.role.id}' not found`);
        const roleLite = role.toLite();
        const symbolById = new Map(SymbolLogic.symbols(TypeConditionSymbol).map(s => [String(s.id), s]));
        const current = await table(RuleOperationEntity).filter(ro => ro.role == roleLite && ro.type == pack.type).toArray() as RuleOperationEntity[];
        const currentByOp = new Map(current.map(ro => [String(ro.operation.id), ro]));

        for (const r of pack.rules) {
            const existing = currentByOp.get(String(r.operation.id));
            const isRedundant = fromModel(r.allowed, symbolById).equals(fromModel(r.allowedBase, symbolById));
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
            ro.fallback = r.allowed.fallback;
            ro.conditionRules = r.allowed.conditionRules.map((cr, i) => RuleOperationConditionEntity.create({
                order: toInt(i),
                allowed: cr.allowed,
                conditions: cr.typeConditions.map(lite => RuleOperationConditionEntity_Conditions.create({ symbol: lite })),
            }));
            await ro.save();
        }
        invalidate();
    }
}
