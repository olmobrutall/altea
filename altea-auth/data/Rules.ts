import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity, ModelEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, uniqueIndex, backReference, valueField, rowOrder } from "@altea/altea/data/decorators";
import { type int, toInt } from "@altea/altea/data/basics";
import { Symbol } from "@altea/altea/data/symbol";
import { OperationSymbol } from "@altea/altea/data/operations";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { noRepeatValidator, countIsValidator, ComparisonType } from "@altea/altea/data/validators";
import { RoleEntity } from "./Role";
// Loads the module into the program so the `declare module` augmentation at the bottom of this file can
// resolve it. Under project references an augmentation-only reference is not enough on its own.
import type { } from "@altea/altea/data/metadata";

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
@entity("SystemString", "Master")
export class PermissionSymbol extends Symbol {
}

@reflect
@entity("SystemString", "Master")
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
// `@entity("Part")` collection back-referencing the RuleType (like EmployeeEntity_Territory).
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
    // Signum's [PreserveOrder, NoRepeatValidator, CountIsValidator(ComparisonType.GreaterThan, 0)] —
    // a condition row that ANDs nothing would match every row, so it must name at least one condition.
    @noRepeatValidator()
    @countIsValidator(ComparisonType.GreaterThan, 0)
    conditions: RuleTypeConditionEntity_Condition[];
    allowed: TypeAllowed = TypeAllowed.None;
}

// Junction rows for RuleTypeConditionEntity.conditions (Signum's MList<TypeConditionSymbol>).
@entity("Part")
export class RuleTypeConditionEntity_Condition extends Entity {
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
    // Signum's [PreserveOrder, NoRepeatValidator, CountIsValidator(ComparisonType.GreaterThan, 0)].
    @noRepeatValidator()
    @countIsValidator(ComparisonType.GreaterThan, 0)
    typeConditions: Lite<TypeConditionSymbol>[];
    allowed: TypeAllowed = TypeAllowed.None;
}

@reflect
export class WithConditionsModel extends EmbeddedEntity {
    fallback: TypeAllowed = TypeAllowed.None;
    conditionRules: ConditionRuleModel[];
}

// A coarse summary of the role's access across all rules of one dimension (property/operation/query) for
// a type — the MIN and MAX allowance rank (0 = none/red, 1 = partial/yellow, 2 = full/green; -1 = the
// dimension is empty / not started). Lets the grid colour a drill-in icon by what's inside without
// opening the pack: the icon glyph takes the MAX colour and an underline shows the MIN (so a uniform
// dimension reads as one solid colour, a mixed one shows its range).
@reflect
export class DimensionSummaryModel extends EmbeddedEntity {
    min: int = toInt(-1);
    max: int = toInt(-1);
}

@reflect
export class TypeAllowedRule extends EmbeddedEntity {
    resource: Lite<TypeEntity>;
    allowed: WithConditionsModel;
    allowedBase: WithConditionsModel;
    // The TypeConditionSymbols registered for this type (Signum's AvailableConditions) — the symbols the
    // admin UI offers when adding a condition rule. Empty for a type with no registered conditions.
    availableConditions: Lite<TypeConditionSymbol>[];
    // altea-only: the clean names of the Part entities this type OWNS (transitively). Non-empty → the
    // type's property/operation/query drill-ins stack the owner + these parts; the grid annotates it.
    ownedParts: string[];
    // Per-dimension access summaries (min/max rank) so the drill-in icons can be colour-coded.
    propertiesSummary: DimensionSummaryModel;
    operationsSummary: DimensionSummaryModel;
    queriesSummary: DimensionSummaryModel;
    // The owning package (Signum's namespace) — the grid groups the rows under a header per package.
    packageName: string = "";
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

// ---- Operation rules (Signum's RuleOperationEntity / OperationRulePack / OperationAllowedRule) --------
//
// Signum keys an operation rule by (OperationSymbol + Type): the same operation symbol can apply to
// several concrete types (a `.WithSave` on an abstract base), and a role may allow it for one type and
// deny it for another. altea flattens Signum's `OperationTypeEmbedded` resource to two direct FK fields
// (operation + type) so the unique index is a plain `[role, operation, type]` (a documented divergence —
// avoids relying on a nested-embedded index path). The allowance is a 3-valued `OperationAllowed`
// (None → blocked; DBOnly → server-code only, button hidden; Allow → everywhere), now WITH row-level type
// conditions: `fallback` + ordered `conditionRules` (each an AND-ed set of TypeConditionSymbols → an
// OperationAllowed), evaluated last-match-wins against the operated entity — exactly like RuleTypeEntity.
@uniqueIndex((e: RuleOperationEntity) => [e.role, e.operation, e.type])
@entity("System", "Master")
export class RuleOperationEntity extends RuleEntity {
    operation: Lite<OperationSymbol>;
    type: Lite<TypeEntity>;
    fallback: OperationAllowed = OperationAllowed.None;
    conditionRules: RuleOperationConditionEntity[];
}

// One condition-row of a RuleOperation (mirrors RuleTypeConditionEntity): the SET of TypeConditionSymbols
// that must ALL hold, the granted OperationAllowed, and the evaluation `order` (last-match-wins).
@entity("Part")
export class RuleOperationConditionEntity extends Entity {
    @backReference ruleOperation: Lite<RuleOperationEntity>;
    @rowOrder order: int = toInt(0);
    // Signum's [PreserveOrder, NoRepeatValidator, CountIsValidator(ComparisonType.GreaterThan, 0)] —
    // a condition row that ANDs nothing would match every row, so it must name at least one condition.
    @noRepeatValidator()
    @countIsValidator(ComparisonType.GreaterThan, 0)
    conditions: RuleOperationConditionEntity_Condition[];
    allowed: OperationAllowed = OperationAllowed.None;
}

@entity("Part")
export class RuleOperationConditionEntity_Condition extends Entity {
    @backReference ruleOperationCondition: Lite<RuleOperationConditionEntity>;
    @valueField symbol: Lite<TypeConditionSymbol>;
}

// One entry of a pack's `availableTypeConditions` — a SET of TypeConditionSymbols that together form one
// selectable "slice" in the property/operation rule editor (Signum's `List<List<TypeConditionSymbol>>`,
// modelled here as an array of this wrapper since altea reflection has no nested-array field). The sets
// are the type's configured type-condition rule sets for the role.
@reflect
export class TypeConditionSetModel extends EmbeddedEntity {
    typeConditions: Lite<TypeConditionSymbol>[];
}

// Signum's ConditionRuleModel<OperationAllowed> / WithConditionsModel<OperationAllowed> — the mutable
// transport twin of the runtime WithConditions<OperationAllowed> (altea has no generic entities, so one
// concrete pair per dimension).
@reflect
export class OperationConditionRuleModel extends EmbeddedEntity {
    // Signum's [PreserveOrder, NoRepeatValidator, CountIsValidator(ComparisonType.GreaterThan, 0)].
    @noRepeatValidator()
    @countIsValidator(ComparisonType.GreaterThan, 0)
    typeConditions: Lite<TypeConditionSymbol>[];
    allowed: OperationAllowed = OperationAllowed.None;
}

@reflect
export class OperationWithConditionsModel extends EmbeddedEntity {
    fallback: OperationAllowed = OperationAllowed.None;
    conditionRules: OperationConditionRuleModel[];
}

// The admin transport (Signum's OperationRulePack / OperationAllowedRule). PER-TYPE, like the query /
// property packs: it carries the `type` and one row per operation applicable to that type. `coerced` is
// the upper bound the UI must not exceed (Signum's AllowedRuleCoerced). `availableConditions` are the
// TypeConditionSymbols registered for the pack's type (the symbols the UI offers when adding a rule).
@reflect
export class OperationAllowedRule extends EmbeddedEntity {
    operation: Lite<OperationSymbol>;   // resource: the operation symbol (toStr = its key, for display)
    allowed: OperationWithConditionsModel;
    allowedBase: OperationWithConditionsModel;
    coerced: OperationAllowed = OperationAllowed.Allow;
}

@reflect
export class OperationRulePack extends ModelEntity {
    role: Lite<RoleEntity>;
    type: Lite<TypeEntity>;
    strategy: string = "";
    // The TypeConditionSymbols registered for this pack's type — offered when adding a condition rule.
    availableConditions: Lite<TypeConditionSymbol>[];
    // The type's configured type-condition SETS for this role — the selectable slices in the editor
    // (Signum's AvailableTypeConditions). Empty when the type/role has no condition rules.
    availableTypeConditions: TypeConditionSetModel[];
    rules: OperationAllowedRule[];
}

// ---- Query rules (Signum's QueryRulePack / QueryAllowedRule) ------------------------------------------
//
// RuleQueryEntity (the persisted rule, resource = Lite<QueryEntity>, allowed: QueryAllowed) already exists
// above. These are the admin transport: PER-TYPE (like the operation pack) — one pack per (role, type)
// listing that type's queries. `coerced` is the upper bound the UI must not exceed (Signum's
// AllowedRuleCoerced); the first slice sets it to Allow. QueryAllowed: None (hidden) < EmbeddedOnly
// (embedded search only, not full-screen) < Allow (everywhere).
@reflect
export class QueryAllowedRule extends EmbeddedEntity {
    resource: Lite<QueryEntity>;   // the query (toStr = its key)
    allowed: QueryAllowed = QueryAllowed.None;
    allowedBase: QueryAllowed = QueryAllowed.None;
    coerced: QueryAllowed = QueryAllowed.Allow;
}

@reflect
export class QueryRulePack extends ModelEntity {
    role: Lite<RoleEntity>;
    type: Lite<TypeEntity>;
    strategy: string = "";
    rules: QueryAllowedRule[];
}

// ---- Property rules (Signum's RulePropertyEntity / PropertyRulePack / PropertyAllowedRule) -----------
//
// DIVERGENCE (recommended): altea does NOT persist PropertyRouteEntity. A property rule is keyed directly
// by (role, rootType, path) — the `path` is the route's PropertyString ("name", "address.city",
// "[MixinName].field") — dropping the whole PropertyRoute-table subsystem. PropertyAllowed: None (hidden)
// < Read (read-only) < Write. Now WITH row-level type conditions (`fallback` + ordered `conditionRules`),
// evaluated last-match-wins against the ROOT entity being serialized — the conditions are the root type's.
@uniqueIndex((e: RulePropertyEntity) => [e.role, e.rootType, e.path])
@entity("System", "Master")
export class RulePropertyEntity extends RuleEntity {
    rootType: Lite<TypeEntity>;
    path: string = "";
    fallback: PropertyAllowed = PropertyAllowed.None;
    conditionRules: RulePropertyConditionEntity[];
}

// One condition-row of a RuleProperty (mirrors RuleTypeConditionEntity): the SET of TypeConditionSymbols
// (of the ROOT type) that must ALL hold, the granted PropertyAllowed, and the evaluation `order`.
@entity("Part")
export class RulePropertyConditionEntity extends Entity {
    @backReference ruleProperty: Lite<RulePropertyEntity>;
    @rowOrder order: int = toInt(0);
    // Signum's [PreserveOrder, NoRepeatValidator, CountIsValidator(ComparisonType.GreaterThan, 0)] —
    // a condition row that ANDs nothing would match every row, so it must name at least one condition.
    @noRepeatValidator()
    @countIsValidator(ComparisonType.GreaterThan, 0)
    conditions: RulePropertyConditionEntity_Condition[];
    allowed: PropertyAllowed = PropertyAllowed.None;
}

@entity("Part")
export class RulePropertyConditionEntity_Condition extends Entity {
    @backReference rulePropertyCondition: Lite<RulePropertyConditionEntity>;
    @valueField symbol: Lite<TypeConditionSymbol>;
}

// Signum's ConditionRuleModel<PropertyAllowed> / WithConditionsModel<PropertyAllowed> — the mutable
// transport twin of the runtime WithConditions<PropertyAllowed>.
@reflect
export class PropertyConditionRuleModel extends EmbeddedEntity {
    // Signum's [PreserveOrder, NoRepeatValidator, CountIsValidator(ComparisonType.GreaterThan, 0)].
    @noRepeatValidator()
    @countIsValidator(ComparisonType.GreaterThan, 0)
    typeConditions: Lite<TypeConditionSymbol>[];
    allowed: PropertyAllowed = PropertyAllowed.None;
}

@reflect
export class PropertyWithConditionsModel extends EmbeddedEntity {
    fallback: PropertyAllowed = PropertyAllowed.None;
    conditionRules: PropertyConditionRuleModel[];
}

// The admin transport (Signum's PropertyRulePack / PropertyAllowedRule). PER-TYPE: one pack per (role,
// type) listing that type's property routes. `coerced` is the type's UI-read ceiling a property can't
// exceed (Signum's AllowedRuleCoerced — a property can be at most as accessible as its type is readable).
// `availableConditions` (on the pack) are the ROOT type's registered TypeConditionSymbols.
@reflect
export class PropertyAllowedRule extends EmbeddedEntity {
    path: string = "";               // the route PropertyString (the row's identity + display)
    allowed: PropertyWithConditionsModel;
    allowedBase: PropertyWithConditionsModel;
    // The type's UI-read ceiling PER SLICE (Signum's WithConditionsModel coerced): a property can't exceed
    // its type for a given condition — so a slice where the type is None caps that slice's properties at None.
    coerced: PropertyWithConditionsModel;
}

@reflect
export class PropertyRulePack extends ModelEntity {
    role: Lite<RoleEntity>;
    type: Lite<TypeEntity>;
    strategy: string = "";
    // The ROOT type's registered TypeConditionSymbols — offered when adding a condition rule.
    availableConditions: Lite<TypeConditionSymbol>[];
    // The type's configured type-condition SETS for this role — the selectable slices in the editor
    // (Signum's AvailableTypeConditions). Empty when the type/role has no condition rules.
    availableTypeConditions: TypeConditionSetModel[];
    rules: PropertyAllowedRule[];
}

// ---- Reflection-metadata expansion (Signum's TypeInfo.maxTypeAllowed / MemberInfo.propertyAllowed) ---
//
// The authorization dimensions the CLIENT needs, widened onto the core metadata model rather than
// shipped as a parallel side-channel map. altea's core neither reads nor understands these; the server
// stamps them per request (server/AuthReflection) and the client's Navigator gates + Lines layer read
// them. Declared HERE, in the data layer, because a `declare module` only applies to programs that
// compile the declaring file — and the client tsconfig does not compile server/.
//
// Both enums are numeric and ASCENDING (None < Read < Write); undefined = unrestricted (not shipped).
declare module "@altea/altea/data/metadata" {
    interface TypeMetadata {
        minTypeAllowed?: TypeAllowedBasic;
        maxTypeAllowed?: TypeAllowedBasic;
    }
    interface FieldMetadata {
        /** The allowance when no type condition matches — what a row with no conditions on it sees. */
        propertyAllowed?: PropertyAllowed;
        /**
         * The range across every type-condition slice. The UI gates on `max`: hiding a property the user
         * might be allowed to edit for THIS row would be wrong, and the serializer still enforces the
         * exact per-instance answer on the way in and out.
         */
        minPropertyAllowed?: PropertyAllowed;
        maxPropertyAllowed?: PropertyAllowed;
        /**
         * PERMISSION containers only (Signum's `isPermissionAuthorized`, which reads its own
         * `AuthClient.Options.isPermissionAuthorized` map). A symbol container's members already ride in
         * the blob (`meta.types["WorkflowPermission"].fields["ViewCaseFlow"]`), so the role's answer goes
         * on the very entry that carries the member's label and id rather than in a parallel map.
         * Shipped only when DENIED — absent means allowed, as everywhere else here.
         */
        allowed?: boolean;
    }
}
