import "@altea/altea/server"; // Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // withQuery
import { SchemaBuilder } from "@altea/altea/server/schema";
import { ResetLazy } from "@altea/altea/data/resetLazy";
import { table } from "@altea/altea/server/table";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { AuthLogic } from "./AuthLogic";
import { MergeStrategy, RoleEntity } from "../data/Role";
import {
    RulePermissionEntity, PermissionSymbol,
    PermissionRulePack, PermissionAllowedRule,
} from "../data/Rules";
import { computeAllowed, type ComputedCache } from "./AuthCache";

// Port of Signum's PermissionAuthLogic (Rules/PermissionAuthLogic.cs) — the simplest authorization
// dimension and the first full vertical slice of the engine (rules → per-role merge → IsAuthorized).
// The rule-pack get/set (admin write) + XML surface are Phase 5.
//
// altea divergences: no PermissionLogic registry (permissions are the declared PermissionSymbols seeded
// by SymbolLogic); the cache load + IsAuthorized are ASYNC (altea has no preloaded GlobalLazy); rules
// are keyed by the permission's id. Merge = Union → any base allowed / Intersection → all base allowed.

export namespace PermissionAuthLogic {
    let started = false;
    // Signum's AuthCache in one GlobalLazy: raw per-role rules + the merged (role, permissionId) cache
    // (RoleAllowedCache), reset together when a RulePermission or Role is saved.
    interface RulesCache {
        rules: Map<string, Map<PrimaryKey, boolean>>;
        computed: ComputedCache<boolean>;
    }
    let rulesLazy: ResetLazy<Promise<RulesCache>>;

    export function isStarted(): boolean {
        return started;
    }

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;
        // The PermissionSymbol table (seeded with every declared PermissionSymbol — BasicPermission +
        // any app permissions) and the per-role permission rules.
        SymbolLogic.start(sb, PermissionSymbol);
        sb.include(RulePermissionEntity).withQuery();
        // Signum's `sb.GlobalLazy(rules, InvalidateWith(RulePermission, Role))`. globalLazy runs the factory
        // in ExecutionMode.global, so the RulePermission read is ungated (no explicit Disable needed).
        rulesLazy = sb.globalLazy(async () => ({ rules: await loadRules(), computed: new Map() }),
            { invalidateWith: [RulePermissionEntity, RoleEntity] });
    }

    /** Explicit reset for setPermissionRulePack (whose deletes don't fire `saved`). Saves auto-invalidate. */
    export function invalidate(): void {
        rulesLazy?.reset();
    }

    async function loadRules(): Promise<Map<string, Map<PrimaryKey, boolean>>> {
        const rows = await table(RulePermissionEntity).toArray() as RulePermissionEntity[];
        const map = new Map<string, Map<PrimaryKey, boolean>>();
        for (const row of rows) {
            const roleKey = row.role.key();
            let inner = map.get(roleKey);
            if (inner == null) { inner = new Map(); map.set(roleKey, inner); }
            inner.set(row.resource.id, row.allowed);
        }
        return map;
    }

    const mergeBool = (strategy: MergeStrategy, baseValues: boolean[]): boolean =>
        strategy === MergeStrategy.Union ? baseValues.some(x => x) : baseValues.every(x => x);

    /** Signum's PermissionAuthLogic.IsAuthorized. No current role (anonymous / auth off) → allowed. */
    export async function isAuthorized(permission: PermissionSymbol): Promise<boolean> {
        const roleKey = AuthLogic.currentRoleKey();
        if (roleKey == null)
            return true;
        return isAuthorizedForRole(permission, roleKey);
    }

    export async function isAuthorizedForRole(permission: PermissionSymbol, roleKey: string): Promise<boolean> {
        const { rules, computed } = await rulesLazy.value;
        return computeAllowed<boolean>(roleKey, permission.id, rules, mergeBool, AuthLogic.getDefaultAllowed, computed);
    }

    /** The role's effective allowed for a permission id (Signum's GetAllowed). No current role → allowed. */
    async function getAllowed(permissionId: PrimaryKey, roleKey: string): Promise<boolean> {
        const { rules, computed } = await rulesLazy.value;
        return computeAllowed<boolean>(roleKey, permissionId, rules, mergeBool, AuthLogic.getDefaultAllowed, computed);
    }

    // The value a role gets for a permission with NO explicit rule (Signum's AuthCache.GetAllowedBase):
    // the merge of its direct parents' values, or the role default if it is a root role.
    async function getAllowedBase(permissionId: PrimaryKey, roleKey: string): Promise<boolean> {
        const parents = await AuthLogic.relatedTo(roleKey);
        if (parents.size === 0)
            return AuthLogic.getDefaultAllowed(roleKey);
        return mergeBool(await AuthLogic.getMergeStrategy(roleKey), await Promise.all([...parents].map(p => getAllowed(permissionId, p))));
    }

    // Signum's AuthCache.GetRules — the admin pack: every permission with the role's effective `allowed`
    // and its inherited `allowedBase`. The resource Lite carries the symbol key as its toStr.
    export async function getPermissionRulePack(roleId: PrimaryKey): Promise<PermissionRulePack> {
        const role = await table(RoleEntity).filter(r => r.id == roleId).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${roleId}' not found`);
        const roleKey = role.toLite().key();
        const rules: PermissionAllowedRule[] = [];
        for (const p of SymbolLogic.symbols(PermissionSymbol)) {
            rules.push(PermissionAllowedRule.create({
                resource: PermissionSymbol.newLite(p.id, p.key),
                allowed: await getAllowed(p.id, roleKey),
                allowedBase: await getAllowedBase(p.id, roleKey),
            }));
        }
        rules.sort((a, b) => a.resource.toString().localeCompare(b.resource.toString()));
        return PermissionRulePack.create({ role: role.toLite(), strategy: MergeStrategy[role.mergeStrategy], rules });
    }

    // Signum's AuthCache.SetRules — persist the pack: a value equal to its base is redundant (delete the
    // explicit rule); otherwise upsert a RulePermission with that boolean. Then invalidate the cache.
    export async function setPermissionRulePack(pack: PermissionRulePack): Promise<void> {
        const role = await table(RoleEntity).filter(r => r.id == pack.role.id).singleOrNull() as RoleEntity | null;
        if (role == null)
            throw new Error(`Role '${pack.role.id}' not found`);
        const roleLite = role.toLite();
        const current = await table(RulePermissionEntity).filter(rp => rp.role == roleLite).toArray() as RulePermissionEntity[];
        const currentByPermission = new Map(current.map(rp => [String(rp.resource.id), rp]));

        for (const r of pack.rules) {
            const existing = currentByPermission.get(String(r.resource.id));
            if (r.allowed === r.allowedBase) {
                if (existing != null)
                    await existing.delete();
            } else if (existing != null) {
                if (existing.allowed !== r.allowed) {
                    existing.allowed = r.allowed;
                    await existing.save();
                }
            } else {
                await RulePermissionEntity.create({
                    role: roleLite,
                    resource: PermissionSymbol.newLite(r.resource.id, r.resource.toString()),
                    allowed: r.allowed,
                }).save();
            }
        }
        invalidate();
    }
}
