import { init, MAX_SIZE } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { column, entity, quoted } from "@altea/altea/data/decorators";
import { stringLengthValidator, ValidationMessage, validate } from "@altea/altea/data/validators";
import { registerEnum } from "@altea/altea/data/registration";
import { msg } from "@altea/altea/data/utils/localization";
import type { ConstructSymbol, From, ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";

// A TYPE defined from inside the running application, stored as its SOURCE: a DATA module (the entity, and
// any `@part` rows, embeddeds, models and enums it needs) and a SERVER module (its `<Name>Logic`: the
// include, the operations, the queries). DynamicCodeCompiler compiles both with the quote-transformer
// applied and loads them at startup; imports are added the way an eval script gets them (the "DynamicType"
// import profile), so the source names `Entity`, `OrderEntity` or `stringLengthValidator` and nothing else.
//
// The rules a parser is needed for — exactly one real entity, named after the row — are checked on the
// SERVER (DynamicTypeLogic), which is where the TypeScript compiler is.

export enum DynamicBaseType {
    Entity,
    MixinEntity,
    EmbeddedEntity,
    ModelEntity,
}
export type DynamicBaseTypeKeys = keyof typeof DynamicBaseType;
registerEnum(DynamicBaseType);

/** The eval import profile a type's source resolves its names through — on both tiers. */
export const DynamicTypeImportsProfile = "DynamicType";

/** A class name: PascalCase ASCII. */
export const PascalAscii = /^[A-Z][a-zA-Z0-9]*$/;

/** `Pizza` + Entity → `PizzaEntity`: the class the data module must declare. */
export function typeNameWithSuffix(typeName: string, baseType: DynamicBaseType): string {
    return typeName + (
        baseType === DynamicBaseType.MixinEntity ? "Mixin" :
            baseType === DynamicBaseType.EmbeddedEntity ? "Embedded" :
                baseType === DynamicBaseType.ModelEntity ? "Model" : "Entity");
}

/** The namespace the server module must export, with its `start(sb)`. */
export function logicName(typeName: string): string {
    return typeName + "Logic";
}

@entity("Main", "Master")
export class DynamicTypeEntity extends Entity {

    baseType: DynamicBaseType = DynamicBaseType.Entity;

    // Also a unique index, declared on the include (DynamicTypeLogic).
    @validate<DynamicTypeEntity>((e, fi) => PascalAscii.test(e.typeName) ? null
        : ValidationMessage._0DoesNotHaveAValid1Format.niceToString(fi.niceToString(), "PascalAscii"))
    @stringLengthValidator({ min: 3, max: 100 })
    typeName: string;

    /** The data module: the one entity (see the header) and whatever it needs. */
    @stringLengthValidator({ min: 1, multiLine: true })
    @column({ size: MAX_SIZE })
    dataCode: string;

    /** The server module: `export namespace <Name>Logic { export function start(sb) … }`. Empty for a type with no logic. */
    @stringLengthValidator({ multiLine: true })
    @column({ size: MAX_SIZE })
    serverCode: string | null;

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
    TheEntityShouldBeSynchronizedToApplyMixins:
        msg("The entity should be synchronized to apply mixins"),
    TheDataModuleMustDeclare0: msg("The data module must declare the exported class '{0}'"),
    TheDataModuleDeclaresMoreThanOneEntity0: msg("The data module may declare only one entity that is not a part, but declares {0}"),
    _0MustBeAnEntity: msg("'{0}' must be an @entity that is not a part"),
    TheServerModuleMustExport0: msg("The server module must export a namespace '{0}' with a function start(sb)"),
    AnEntityNeedsAServerModule: msg("An entity needs a server module, which includes it in the schema"),
    Data: msg("Data"),
    Server: msg("Server"),
};

/** The recipe panel beside the source (client/Type/DynamicTypeRecipes). */
export const DynamicTypeRecipeMessage = {
    PlaceTheCursorOnAClassOrAField: msg("Place the cursor on a class or a field to edit it here."),
    Field: msg("Field"),
    Class: msg("Class"),
    Name: msg("Name"),
    Type: msg("Type"),
    Nullable: msg("Nullable"),
    Lite: msg("Lite"),
    UniqueIndex: msg("Unique index"),
    BackReference: msg("Back reference"),
    ValueField: msg("Value field"),
    Unit: msg("Unit"),
    Format: msg("Format"),
    Validators: msg("Validators"),
    AddValidator: msg("Add validator…"),
    AddField: msg("Add field"),
    Add: msg("Add"),
    Remove: msg("Remove"),
    DoesNotApplyTo0: msg("Does not apply to {0}"),
    AddCollection: msg("Add collection"),
    ElementType: msg("Element type"),
    PreserveOrder: msg("Preserve order"),
    AddToString: msg("Add toString"),
    Operations: msg("Operations"),
    Registered: msg("Registered"),
    Register: msg("Register"),
    AddOperation: msg("Add operation"),
    Kind: msg("Kind"),
    TheServerModuleHasNo0: msg("The server module has no {0}"),
    PlaceTheCursorInside0: msg("Place the cursor inside {0} to edit the operations here."),
    EditOperations: msg("Edit operations"),
    AddOperations: msg("Add operations"),
    LiteHelp: msg("A Lite reference holds only the id and the toString of the entity: it is not loaded with this one, and it is retrieved when needed. Recommended for references to other entities."),
    ConvertToCollection: msg("Convert to a collection"),
    ValueKind: msg("Value"),
    EntityKind: msg("Entity"),
    EmbeddedKind: msg("Embedded"),
    EnumKind: msg("Enum"),
    ModelKind: msg("Model"),
};
