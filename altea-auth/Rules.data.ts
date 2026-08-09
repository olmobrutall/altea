import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity, ModelEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, uniqueIndex, backReference, valueField, rowOrder } from "@altea/altea/data/decorators";
import { type int, toInt } from "@altea/altea/data/basics";
import { Symbol } from "@altea/altea/data/symbol";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { RoleEntity } from "./Role.data";

// Port of Signum's authorization entity model (Rules/RulesEntities.cs + Rules/Signum.Authorization.Rules.ts).
// The PERSISTED rules (one row per role×resource) that the authorization caches load. The rule-PACK
// models (the admin-UI transport DTOs: BaseRulePack / WithConditionsModel / …) are Phase 5.
//
// This first slice covers the condition-free dimensions (Permission, Query) + the shared symbols/enums;
// the Type / Operation rule entities (with their type-condition sub-rows) and the type-condition algebra
// land with the Type-authorization slice, and Property auth waits on a PropertyRouteEntity port.
//
// altea divergences: Signum's generic `RuleEntity<R>` abstract base → a non-generic `@reflect` abstract
// base carrying `role`; each concrete rule adds its own `resource` (like CustomerEntity's hierarchy).
// The enums are plain numeric entity enums (the OrderState/UserState pattern). Resource references are
// direct FKs to the seeded TypeEntity / QueryEntity / PermissionSymbol tables (Signum's `Resource`).

// ---- Allowed enums (Signum's RulesEntities.cs) --------------------------------------------------

export enum TypeAllowedBasic {
    None = 0,
    Read = 1,
    Write = 2,
}

// Composite of a DB level and a UI level: value = (DB << 2) | UI (Signum's TypeAllowed). Only the six
// combinations where UI ≤ DB are valid.
export enum TypeAllowed {
    None = 0,               // DB None,  UI None
    DBReadUINone = 4,       // DB Read,  UI None
    Read = 5,               // DB Read,  UI Read
    DBWriteUINone = 8,      // DB Write, UI None
    DBWriteUIRead = 9,      // DB Write, UI Read
    Write = 10,             // DB Write, UI Write
}

export enum PropertyAllowed {
    None = 0,
    Read = 1,
    Write = 2,
}

export enum QueryAllowed {
    None = 0,
    EmbeddedOnly = 1,
    Allow = 2,
}

export enum OperationAllowed {
    None = 0,
    DBOnly = 1,
    Allow = 2,
}

// Signum's AuthThumbnail (Rules.ts) — the roll-up indicator a rule pack shows for a group of rules.
export enum AuthThumbnail {
    All = 0,
    Mix = 1,
    None = 2,
}

// ---- TypeAllowed helpers (Signum's TypeAllowedExtensions) ---------------------------------------

export function typeAllowedDB(allowed: TypeAllowed): TypeAllowedBasic {
    return ((allowed >> 2) & 0x03) as TypeAllowedBasic;
}
export function typeAllowedUI(allowed: TypeAllowed): TypeAllowedBasic {
    return (allowed & 0x03) as TypeAllowedBasic;
}
export function typeAllowedGet(allowed: TypeAllowed, userInterface: boolean): TypeAllowedBasic {
    return userInterface ? typeAllowedUI(allowed) : typeAllowedDB(allowed);
}
export function typeAllowedCreate(database: TypeAllowedBasic, ui: TypeAllowedBasic): TypeAllowed {
    return ((database << 2) | ui) as TypeAllowed;
}
export function typeBasicToProperty(ta: TypeAllowedBasic): PropertyAllowed {
    return ta === TypeAllowedBasic.None ? PropertyAllowed.None
        : ta === TypeAllowedBasic.Read ? PropertyAllowed.Read
            : PropertyAllowed.Write;
}

// ---- Symbols (Signum's PermissionSymbol / TypeConditionSymbol) ----------------------------------

@reflect
@entity("SystemString", "Master", { identity: false })
export class PermissionSymbol extends Symbol {
}

@reflect
@entity("SystemString", "Master", { identity: false })
export class TypeConditionSymbol extends Symbol {
}

// Signum's BasicPermission (Rules.ts). The framework's own permissions; apps declare their own too.
export namespace BasicPermission {
    export const AdminRules: PermissionSymbol = init();
    export const AutomaticUpgradeOfProperties: PermissionSymbol = init();
    export const AutomaticUpgradeOfQueries: PermissionSymbol = init();
    export const AutomaticUpgradeOfOperations: PermissionSymbol = init();
}

// ---- Persisted rules (Signum's RuleEntity<R> hierarchy) -----------------------------------------

// Shared base: the role a rule belongs to. Abstract (@reflect, not @entity) — only the concrete
// per-resource subclasses get tables (Signum's abstract `RuleEntity<R>`).
@reflect
export abstract class RuleEntity extends Entity {
    role: Lite<RoleEntity>;
}

@uniqueIndex((e: RulePermissionEntity) => [e.role, e.resource])
@entity("System", "Master")
export class RulePermissionEntity extends RuleEntity {
    resource: Lite<PermissionSymbol>;
    allowed: boolean = false;
}

@uniqueIndex((e: RuleQueryEntity) => [e.role, e.resource])
@entity("System", "Master")
export class RuleQueryEntity extends RuleEntity {
    resource: Lite<QueryEntity>;
    allowed: QueryAllowed = QueryAllowed.None;
}

// Signum's RuleTypeEntity. `fallback` is the type-level allowance; `conditionRules` are the per-row
// overrides (Signum's virtual `MList<RuleTypeConditionEntity>`) — each a SET of TypeConditionSymbols
// (AND-ed) mapped to a TypeAllowed, evaluated last-match-wins. altea models the virtual MList as an owned
// `@entity("Part")` collection back-referencing the RuleType (like EmployeeEntity_Territories).
@uniqueIndex((e: RuleTypeEntity) => [e.role, e.resource])
@entity("System", "Master")
export class RuleTypeEntity extends RuleEntity {
    resource: Lite<TypeEntity>;
    fallback: TypeAllowed = TypeAllowed.None;
    conditionRules: RuleTypeConditionEntity[];
}

// Signum's RuleTypeConditionEntity (`RulesEntities.cs`): one condition-row of a RuleType. `conditions`
// is the SET of TypeConditionSymbols that must ALL hold (Signum's `MList<TypeConditionSymbol> Conditions`,
// NoRepeat + CountGreaterThan0); `allowed` is granted when they do; `order` preserves evaluation order
// (last-match-wins), Signum's [PreserveOrder]/ICanBeOrdered. Owned by RuleTypeEntity via `ruleType`.
@entity("Part")
export class RuleTypeConditionEntity extends Entity {
    @backReference ruleType: Lite<RuleTypeEntity>;
    @rowOrder order: int = toInt(0);
    conditions: RuleTypeConditionEntity_Conditions[];
    allowed: TypeAllowed = TypeAllowed.None;
}

// Junction rows for RuleTypeConditionEntity.conditions (Signum's MList<TypeConditionSymbol>).
@entity("Part")
export class RuleTypeConditionEntity_Conditions extends Entity {
    @backReference ruleTypeCondition: Lite<RuleTypeConditionEntity>;
    @valueField symbol: Lite<TypeConditionSymbol>;
}

// ---- Rule-pack transport entities (Signum's BaseRulePack / AllowedRule / TypeAllowedRule models) ----
//
// Signum ships these as ModelEntity graphs (serialized by the entity Serializer, opened via
// Navigator.view). altea mirrors that: `TypeRulePack` is a `ModelEntity` (so it has a client TypeInfo
// and rides Navigator.view / FrameModal like Signum — no propertyRoute needed), and each row is a
// `TypeAllowedRule` EmbeddedEntity. Both are transported by the SAME entity Serializer (not plain JSON).
// Divergences: Signum's generic `BaseRulePack<T>` / `AllowedRule<R,A>` bases collapse into concrete
// classes (altea has no generic entities); `resource` is a `Lite<TypeEntity>` (its toStr carries the
// clean name for display); `allowed`/`allowedBase` are a plain TypeAllowed — Signum's per-row
// WithConditionsModel conditions are deferred with the type-condition algebra. `allowedBase` is the
// inherited value (no explicit rule); `allowed`==base means "no override" (the rule is removed on save).
// Signum's ConditionRuleModel<A> / WithConditionsModel<A> (RulePackModels.cs) — the MUTABLE transport twin
// of the runtime WithConditions<A> (WithConditions.server.ts). A role's allowance for a type is a
// `fallback` + an ordered list of condition rules, each an AND-ed SET of TypeConditionSymbols → an allowed
// value. altea has no generic entities, so these are concrete for A = TypeAllowed (the type dimension);
// the symbol set is a plain `Lite<TypeConditionSymbol>[]` (altea's direct-value-array, no wrapper row —
// this is a MODEL, not persisted, so no @part/@valueField needed).
@reflect
export class ConditionRuleModel extends EmbeddedEntity {
    typeConditions: Lite<TypeConditionSymbol>[];
    allowed: TypeAllowed = TypeAllowed.None;
}

@reflect
export class WithConditionsModel extends EmbeddedEntity {
    fallback: TypeAllowed = TypeAllowed.None;
    conditionRules: ConditionRuleModel[];
}

@reflect
export class TypeAllowedRule extends EmbeddedEntity {
    resource: Lite<TypeEntity>;
    allowed: WithConditionsModel;
    allowedBase: WithConditionsModel;
    // The TypeConditionSymbols registered for this type (Signum's AvailableConditions) — the symbols the
    // admin UI offers when adding a condition rule. Empty for a type with no registered conditions.
    availableConditions: Lite<TypeConditionSymbol>[];
}

@reflect
export class TypeRulePack extends ModelEntity {
    role: Lite<RoleEntity>;
    strategy: string = "";
    rules: TypeAllowedRule[];
}

// Signum's PermissionAllowedRule / PermissionRulePack (RulePackModels.cs) — the permission dimension's
// admin transport. Same shape as the type pack but the allowance is a plain boolean (allow / deny), with
// no DB/UI split and no conditions. `resource` is a Lite<PermissionSymbol> (its toStr = the symbol key).
@reflect
export class PermissionAllowedRule extends EmbeddedEntity {
    resource: Lite<PermissionSymbol>;
    allowed: boolean = false;
    allowedBase: boolean = false;
}

@reflect
export class PermissionRulePack extends ModelEntity {
    role: Lite<RoleEntity>;
    strategy: string = "";
    rules: PermissionAllowedRule[];
}
