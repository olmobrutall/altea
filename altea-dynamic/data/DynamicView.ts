import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, backReference, rowOrder, stringLengthValidator, fieldValidation, quoted, uniqueIndex,
} from "@altea/altea/data/decorators";
import { type int } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { ConstructSymbol, ExecuteSymbol, DeleteSymbol, From } from "@altea/altea/data/operations";
import { ValidationMessage } from "@altea/altea/data/validators";

// Port of Signum.Dynamic's Views/DynamicView.cs — a view defined in the DATABASE rather than compiled into
// the app: a tree of nodes (`viewContent`, JSON) plus an optional `locals` hook body and declared `props`.
// Nothing here is compiled: the client INTERPRETS the tree (see client/View/NodeUtils + Nodes), which is
// why this half of Signum.Dynamic ports at all — see the package's DynamicLogic.server.ts header.
//
// altea divergences, documented inline:
//  - `MList<DynamicViewPropEmbedded>` becomes a `@part` row collection (altea has no MList).
//  - `TryGetDynamicView`, a static Func hook on the entity that the server logic fills, is not needed: the
//    lookup lives on the server logic itself (DynamicViewLogic.tryGetDynamicView) and the entity stays a
//    plain field bag. Signum puts it on the entity so its client-side ToString can reach it; altea's
//    toString is a `@quoted` expression, which the LINQ provider lowers into SQL instead.

// ---- prop rows (Signum's MList<DynamicViewPropEmbedded>) -----------------------------------------------

/**
 * Signum's `DynamicViewPropEmbedded` — one declared prop of the view, so a caller can pass values into it
 * (`props` in the node expressions). `type` is a TypeScript type ANNOTATION as text: it is only ever shown
 * to whoever edits the view, never parsed.
 */
@entity("Part")
export class DynamicViewEntity_Prop extends Entity {
    @backReference dynamicView: Lite<DynamicViewEntity>;
    @rowOrder order: int;

    @stringLengthValidator({ max: 100 })
    @fieldValidation<DynamicViewEntity_Prop>(p => propNameError(p))
    name: string;

    @stringLengthValidator({ max: 100 })
    type: string;
}

// Signum's `ForbiddenNames` + the two PropertyValidation rules on DynamicViewPropEmbedded.Name. These are
// the identifiers the interpreter itself binds in a node expression's scope, so a prop may not shadow them.
const forbiddenPropNames = new Set(["ctx", "initialDynamicView", "ref", "key", "children"]);

function propNameError(prop: DynamicViewEntity_Prop): string | null {
    const name = prop.name;
    if (name == undefined || name === "")
        return null;

    const niceName = DynamicViewEntity_Prop.nicePropertyName(p => p.name);

    // Signum's `IdentifierValidator(IdentifierType.Ascii)` plus its "should start by lowercase" rule, as one
    // check: a prop name becomes a JavaScript identifier in the generated scope.
    if (!/^[a-z][A-Za-z0-9_]*$/.test(name)) {
        if (/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
            return DynamicViewValidationMessage._0ShouldStartByLowercase.niceToString(niceName);
        return DynamicViewValidationMessage._0IsNotAValidIdentifier.niceToString(niceName);
    }

    if (forbiddenPropNames.has(name))
        return DynamicViewValidationMessage._0CanNotBe1.niceToString(niceName, name);

    return null;
}

// ---- the three entities -------------------------------------------------------------------------------

/** Signum's `DynamicViewEntity` — one named view for one entity type. */
@reflect
@entity("Main", "Master")
@uniqueIndex<DynamicViewEntity>(v => [v.viewName, v.entityType])
export class DynamicViewEntity extends Entity {

    @stringLengthValidator({ min: 3, max: 100 })
    viewName: string = "Default";

    entityType: TypeEntity;

    // Signum's PropertyValidation for `Props` is `NoRepeatValidatorAttribute.ByKey(Props, a => a.Name)`.
    // altea's `@noRepeatValidator` cannot express it: it compares a `@part` row through the row's
    // `@valueField`, and a prop row has two members and so has none — it would compare object identity and
    // never report anything. Hence a `@fieldValidation`, which receives the whole entity.
    @fieldValidation<DynamicViewEntity>(v => noRepeatedPropNames(v))
    props: DynamicViewEntity_Prop[];

    /** The body of a `useMemo`-like hook the interpreter runs before rendering; its result is `locals`. */
    @stringLengthValidator({ multiLine: true })
    locals: string | null;

    /** The node TREE, as JSON. Interpreted by client/View/NodeUtils — never compiled. */
    @stringLengthValidator({ min: 3, multiLine: true })
    viewContent: string;

    @quoted
    override toString(): string {
        return this.viewName + ": " + this.entityType;
    }
}

/** Signum's DynamicViewEntity.PropertyValidation for `Props` (NoRepeatValidatorAttribute.ByKey). */
function noRepeatedPropNames(view: DynamicViewEntity): string | null {
    const seen = new Set<string>();
    const dups: string[] = [];

    for (const p of view.props ?? []) {
        if (p.name == undefined)
            continue;
        if (seen.has(p.name)) {
            if (!dups.includes(p.name))
                dups.push(p.name);
        } else {
            seen.add(p.name);
        }
    }

    if (dups.length === 0)
        return null;

    return ValidationMessage._0HasSomeRepeatedElements1.niceToString(
        DynamicViewEntity.nicePropertyName(v => v.props), dups.join(", "));
}

export namespace DynamicViewOperation {
    export const Create: ConstructSymbol<DynamicViewEntity> = init();
    export const Clone: ConstructSymbol<DynamicViewEntity, From<DynamicViewEntity>> = init();
    export const Save: ExecuteSymbol<DynamicViewEntity> = init();
    export const Delete: DeleteSymbol<DynamicViewEntity> = init();
}

/**
 * Signum's `DynamicViewSelectorEntity` — ONE per type: a JS function body returning the view NAME to use
 * for a given entity, so which view renders can depend on the row. Two names are reserved: "STATIC" falls
 * back to the code-compiled view, "NEW" opens a fresh unsaved dynamic view.
 */
@reflect
@entity("Main", "Master")
export class DynamicViewSelectorEntity extends Entity {

    @uniqueIndex
    entityType: TypeEntity;

    @stringLengthValidator({ min: 3, multiLine: true })
    script: string;

    @quoted
    override toString(): string {
        return "ViewSelector " + this.entityType;
    }
}

export namespace DynamicViewSelectorOperation {
    export const Save: ExecuteSymbol<DynamicViewSelectorEntity> = init();
    export const Delete: DeleteSymbol<DynamicViewSelectorEntity> = init();
}

/**
 * Signum's `DynamicViewOverrideEntity` — a JS function body that receives a ViewReplacer and rewrites an
 * EXISTING view (compiled or dynamic). `viewName` null means the type's default view.
 */
@reflect
@entity("Main", "Master")
export class DynamicViewOverrideEntity extends Entity {

    entityType: TypeEntity;

    @stringLengthValidator({ min: 3, max: 100 })
    viewName: string | null;

    @stringLengthValidator({ min: 3, multiLine: true })
    script: string;

    @quoted
    override toString(): string {
        return "DynamicViewOverride " + this.entityType;
    }
}

export namespace DynamicViewOverrideOperation {
    export const Save: ExecuteSymbol<DynamicViewOverrideEntity> = init();
    export const Delete: DeleteSymbol<DynamicViewOverrideEntity> = init();
}

// ---- messages -----------------------------------------------------------------------------------------

// Signum's DynamicViewMessage enum.
export const DynamicViewMessage = {
    AddChild: msg("Add child"),
    AddSibling: msg("Add sibling"),
    Remove: msg(),
    GenerateChildren: msg("Generate children"),
    ClearChildren: msg("Clear children"),
    SelectATypeOfComponent: msg("Select a type of component"),
    SelectANodeFirst: msg("Select a node first"),
    UseExpression: msg("Use expression"),
    SuggestedFindOptions: msg("Suggested find options"),
    TheFollowingQueriesReference0: msg("The following queries reference {0}:"),
    ChooseAView: msg("Choose a view"),
    SinceThereIsNoDynamicViewSelectorYouNeedToChooseAViewManually:
        msg("Since there is no DynamicViewSelector you need to choose a view manually:"),
    ExampleEntity: msg("Example entity"),
    ShowHelp: msg("Show help"),
    HideHelp: msg("Hide help"),
    ModulesHelp: msg("modules"),
    PropsHelp: msg("props"),
};

// Signum's DynamicViewValidationMessage enum. `_0IsNotAValidIdentifier` is an altea addition: Signum gets
// that message from its `IdentifierValidator`, which altea has no counterpart for, so the prop-name check
// that replaces it needs its own text.
export const DynamicViewValidationMessage = {
    OnlyChildNodesOfType0Allowed: msg("Only child nodes of type '{0}' allowed"),
    Type0DoesNotContainsField1: msg("Type '{0}' does not contain field '{1}'"),
    Member0IsMandatoryFor1: msg("Member '{0}' is mandatory for '{1}'"),
    _0RequiresA1: msg("{0} requires a {1}"),
    Entity: msg(),
    CollectionOfEntities: msg("Collection of entities"),
    Value: msg(),
    CollectionOfEnums: msg("Collection of enums"),
    EntityOrValue: msg("Entity or value"),
    FilteringWithNew0ConsiderChangingVisibility: msg("Filtering with new {0}. Consider changing visibility."),
    AggregateIsMandatoryFor01: msg("Aggregate is mandatory for '{0}' ({1})."),
    ValueTokenCanNotBeUseFor0BecauseIsNotAnEntity:
        msg("ValueToken can not be use for '{0}' because is not an Entity."),
    ViewNameIsNotAllowedWhileHavingChildren: msg("View name is not allowed while having children"),
    _0ShouldStartByLowercase: msg("{0} should start by lowercase"),
    _0CanNotBe1: msg("{0} can not be '{1}'"),
    _0IsNotAValidIdentifier: msg("{0} is not a valid identifier"),
};
