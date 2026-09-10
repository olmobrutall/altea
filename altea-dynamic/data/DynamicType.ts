import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, quoted } from "@altea/altea/data/decorators";
import { stringLengthValidator, ValidationMessage, validate, ComparisonType } from "@altea/altea/data/validators";
import { registerEnum } from "@altea/altea/data/registration";
import { msg } from "@altea/altea/data/utils/localization";
import type { ConstructSymbol, From, ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";

// Port of Signum.Dynamic's Types/DynamicType.cs — a TYPE defined from inside the running application: its
// name, its base, its properties and their validators, its operations, and any hand-written code to splice
// in. `DynamicTypeLogic` turns one of these rows into generated TypeScript, which
// `DynamicCodeCompiler` compiles with the quote-transformer applied and loads (see that file).
//
// The definition is stored as JSON in one column, exactly as Signum stores it, and for the same reason: it
// is a document with optional parts and nested shapes, not a table. So everything below the entity is a
// plain interface — never a `@part` row — and `getDefinition()` / `setDefinition()` are the accessors.
//
// altea divergences:
//  - `DynamicValidator` is a DISCRIMINATED UNION on `type` rather than a class hierarchy behind a
//    hand-written `JsonConverter`. TypeScript narrows it for free, so Signum's converter, its
//    `GetDynamicValidatorType` switch and its `ExtraArguments()` overrides collapse into one generator
//    function (DynamicTypeLogic.validatorDecorator).
//  - a property's `type` is the ALTEA type expression's base name (`"string"`, `"int"`, `"OrderEntity"`,
//    `"Temporal.PlainDate"`), with `isLite` / `isMList` / `isNullable` refining it, as in Signum. The
//    generator composes the final annotation AND the import, which it can do without a `using` list
//    because `getLocation(typeName)` already knows which module declares a registered type — the
//    `__fileInfo` the transformer stamps.
//  - `IdentifierValidator(IdentifierType.PascalAscii)` has no altea counterpart, so the same rule is a
//    `@validate` on the two places Signum applies it (the type name, and each property name inside
//    the definition).
//  - `DynamicTypeMessage.TheEntityShouldBeSynchronizedToApplyMixins` is kept and so is
//    `ServerRestartedWithErrorsInDynamicCode…`: altea restarts for the same reason Signum does — a schema
//    is built once at startup, so a new type takes part only after a restart, and its TABLE only after a
//    `sync`.

export enum DynamicBaseType {
    Entity,
    MixinEntity,
    EmbeddedEntity,
    ModelEntity,
}
export type DynamicBaseTypeKeys = keyof typeof DynamicBaseType;
registerEnum(DynamicBaseType);

// These two live INSIDE the JSON definition, never in a column, so they are the member NAMES — which is
// what Signum stores (its `JsonStringEnumConverter` writes `"isNullable": "No"`). A numeric altea enum
// would have been wrong twice over: a stored definition would no longer round-trip with Signum, and the
// editor would show a bare `2` where the author wrote "No". `DynamicBaseType` above IS a column on the
// entity, so it stays a real altea enum.
export type IsNullable = "Yes" | "OnlyInMemory" | "No";
export const IsNullableValues: IsNullable[] = ["Yes", "OnlyInMemory", "No"];

export type DynamicUniqueIndex = "No" | "Yes" | "YesAllowNull";
export const DynamicUniqueIndexValues: DynamicUniqueIndex[] = ["No", "Yes", "YesAllowNull"];

// ---- the stored definition (JSON, not tables) -----------------------------------------------------------

export interface DynamicTypePrimaryKeyDefinition {
    name?: string;
    type?: string;
    identity?: boolean;
}

export interface DynamicTypeTicksDefinition {
    hasTicks?: boolean;
    name?: string;
    type?: string;
}

/**
 * How a COLLECTION property is stored — Signum's DynamicTypeBackMListDefinition, member for member.
 *
 * altea has no MList, so this describes the `@part` ROW type the generator emits: its table name, whether
 * the order is preserved (a `@rowOrder` column) and what the back reference is called. Signum's
 * `TableName` / `PreserveOrder` / `OrderName` / `BackReferenceName` keep their names, since they mean the
 * same things on the row table altea generates.
 */
export interface DynamicTypeBackMListDefinition {
    tableName?: string;
    preserveOrder?: boolean;
    orderName?: string;
    backReferenceName?: string;
}

export interface MultiColumnUniqueIndex {
    fields: string[];
    where?: string;
}

/** A block of hand-written code spliced into the generated module. */
export interface DynamicTypeCustomCode {
    code: string;
}

export interface OperationConstruct { construct: string }
export interface OperationExecute { canExecute?: string; execute: string }
export interface OperationDelete { canDelete?: string; delete: string }
export interface OperationConstructFrom { canConstruct?: string; construct: string }

/**
 * One validator on one property.
 *
 * A discriminated union, where Signum has a class hierarchy plus a JsonConverter. The member names are
 * Signum's so a stored definition round-trips between the two frameworks.
 */
export type DynamicValidator =
    | { type: "NotNull"; disabled?: boolean }
    | {
        type: "StringLength"; multiLine?: boolean; min?: number; max?: number;
        allowLeadingSpaces?: boolean; allowTrailingSpaces?: boolean;
    }
    | { type: "Decimals"; decimalPlaces: number }
    | { type: "NumberIs"; comparisonType: ComparisonType; number: number }
    | { type: "CountIs"; comparisonType: ComparisonType; number: number }
    | { type: "NumberBetween"; min: number; max: number }
    | { type: "StringCase"; textCase: "UpperCase" | "LowerCase" }
    // A validator with no arguments of its own (URL, EMail, Telephone,
    // NoRepeat…). The name is the decorator's, minus the "Validator" suffix.
    | { type: string; [extra: string]: unknown };

export interface DynamicProperty {
    /** Stable identity across renames, and what a rename is recorded against. */
    uid: string;
    name: string;
    columnName?: string;
    /** The base type: `"string"`, `"int"`, `"boolean"`, `"Temporal.PlainDate"`, `"OrderEntity"`, … */
    type: string;
    columnType?: string;
    isNullable: IsNullable;
    uniqueIndex: DynamicUniqueIndex;
    isLite?: boolean;
    /** Present when the property is a COLLECTION — see DynamicTypeBackMListDefinition. */
    isMList?: DynamicTypeBackMListDefinition;
    size?: number;
    scale?: number;
    unit?: string;
    format?: string;
    notifyChanges?: boolean;
    validators?: DynamicValidator[];
    /** Verbatim decorators to add to the FIELD. */
    customFieldAttributes?: string;
    /** Verbatim decorators to add to the PROPERTY. */
    customPropertyAttributes?: string;
}

export interface DynamicTypeDefinition {
    entityKind?: string;
    entityData?: string;
    tableName?: string;
    primaryKey?: DynamicTypePrimaryKeyDefinition;
    ticks?: DynamicTypeTicksDefinition;
    properties: DynamicProperty[];
    operationCreate?: OperationConstruct;
    operationSave?: OperationExecute;
    operationDelete?: OperationDelete;
    operationClone?: OperationConstructFrom;
    customInheritance?: DynamicTypeCustomCode;
    customEntityMembers?: DynamicTypeCustomCode;
    customStartCode?: DynamicTypeCustomCode;
    customLogicMembers?: DynamicTypeCustomCode;
    customTypes?: DynamicTypeCustomCode;
    customBeforeSchema?: DynamicTypeCustomCode;
    queryFields: string[];
    multiColumnUniqueIndex?: MultiColumnUniqueIndex;
    /** The body of the `@quoted toString()`. */
    toStringExpression?: string;
}

/** Signum's `IdentifierValidatorAttribute.PascalAscii`, for which there is no validator here. */
export const PascalAscii = /^[A-Z][a-zA-Z0-9]*$/;

// ---- the entity ----------------------------------------------------------------------------------------

@reflect
@entity("Main", "Master")
export class DynamicTypeEntity extends Entity {

    baseType: DynamicBaseType = DynamicBaseType.Entity;

    // A unique index plus the PascalAscii check. The index is declared in the logic layer
    // (altea declares indexes on the include, not as a decorator).
    @stringLengthValidator({ min: 3, max: 100 })
    @validate<DynamicTypeEntity>((e, fi) => PascalAscii.test(e.typeName) ? null
        : ValidationMessage._0DoesNotHaveAValid1Format.niceToString(fi.niceToString(), "PascalAscii"))
    typeName: string;

    /**
     * The definition, as JSON, in one unbounded text column.
     *
     * `customValidation` re-checks every PROPERTY name, which is the second place Signum applies its
     * identifier rule — a definition naming a property `order line` would generate source that does not
     * compile, and the author should hear that here rather than from the compiler.
     */
    @stringLengthValidator({ min: 3, multiLine: true })
    @validate<DynamicTypeEntity>(e => {
        let def: DynamicTypeDefinition;
        try {
            def = JSON.parse(e.typeDefinition) as DynamicTypeDefinition;
        } catch (err) {
            return (err as Error).message;
        }

        const bad = (def.properties ?? [])
            .filter(prop => prop.name != null && prop.name !== "" && !PascalAscii.test(prop.name))
            .map(prop => ValidationMessage._0DoesNotHaveAValid1Format.niceToString(prop.name, "PascalAscii"));

        return bad.length === 0 ? null : bad.join("\n");
    })
    typeDefinition: string;

    /**
     * The parsed definition. Signum caches it in an `[Ignore]` field and clears it when TypeDefinition is
     * set; altea parses on demand — the row is read at startup and edited by one person at a time, so the
     * cache bought nothing and an invalidation hook is a thing to get wrong.
     */
    getDefinition(): DynamicTypeDefinition {
        return JSON.parse(this.typeDefinition) as DynamicTypeDefinition;
    }

    setDefinition(definition: DynamicTypeDefinition): void {
        this.typeDefinition = JSON.stringify(definition, undefined, 2);
    }

    @quoted
    override toString(): string {
        return this.typeName;
    }
}

export namespace DynamicTypeOperation {
    export const Create: ConstructSymbol<DynamicTypeEntity> = init();
    export const Clone: ConstructSymbol<DynamicTypeEntity, From<DynamicTypeEntity>> = init();
    export const Save: ExecuteSymbol<DynamicTypeEntity> = init();
    export const Delete: DeleteSymbol<DynamicTypeEntity> = init();
}

export const DynamicTypeMessage = {
    TypeSaved: msg("Type saved"),
    DynamicType0SucessfullySavedGoToDynamicPanelNow:
        msg("DynamicType '{0}' successfully saved. Go to DynamicPanel now?"),
    ServerRestartedWithErrorsInDynamicCodeFixErrorsAndRestartAgain:
        msg("Server restarted with errors in dynamic code. Fix errors and restart again."),
    RemoveSaveOperation: msg("Remove Save Operation?"),
    TheEntityShouldBeSynchronizedToApplyMixins:
        msg("The entity should be synchronized to apply mixins"),
};
