import { Entity, type Type } from "../data/entity";
import type { Lite } from "../data/lite";
import { PropertyRoute, PropertyRouteType } from "../data/propertyRoute";
import type { TranslatableRouteType } from "../data/reflection";
import { setTranslatedFieldProvider } from "../data/serializer";
import type { SchemaBuilder } from "./schema/schemaBuilder";

// Port of Signum's `PropertyRouteTranslationLogic` (Signum/Basics/PropertyRouteTranslationLogic.cs) —
// the registry of which property routes carry a PER-INSTANCE translation, and the resolver that turns a
// (instance, route) pair into the text for the current UI culture.
//
// It lives in the FRAMEWORK, exactly where Signum puts it, because the READ side is used everywhere: an
// entity view, a query, an e-mail template. What is NOT here is the storage — the TranslatedInstance
// table, the editor pages, the excel round-trip and the auto-translators are @altea/altea-translations,
// which installs itself into {@link translatedFieldFunc} and flips {@link isActivated}. With the module
// absent every call falls through to the fallback string, so a consumer needs no null checks.
//
// altea divergences from Signum's file:
//  - **no rowId, and no MList routes.** Signum keys a translation by (root instance, route THROUGH an
//    MList, rowId), because an MList row is not an entity. altea has no MList: a collection is `@part`
//    child ENTITIES, each with its own id and its own PropertyRoute root — so a translatable field on a
//    collection row is keyed by that ROW's lite, and `PropertyRoute.generateRoutes` never descends into
//    one anyway. The whole `RowId` column, its PropertyValidation, the MList primary-key parsing and the
//    `"route;rowId"` composite key collapse. (An EMBEDDED's fields keep the owner's dotted route, as in
//    Signum.)
//  - **the QUERY form is not ported.** Signum swaps in a `TranslatedFieldExpression` so a query can
//    SELECT the translated text; that needs `As.ReplaceExpression`, which altea has no counterpart for
//    (the quote-transformer stamps expression trees at BUILD time — see CLAUDE.md on withQuoted). The
//    in-memory resolver below is the ported half, and the client gets translations through the
//    `<field>_translated` JSON property the serializer ships (see setTranslatedFieldProvider).
//  - `TranslatedField<T>(entity, e => e.Name)` / `TranslatedMList` / `TranslatedElement` are one
//    function here — {@link translatedField} — since without MLists there is only one shape.
export namespace PropertyRouteTranslationLogic {

    /** Signum's `TranslateableRoutes`: root ctor → route `propertyString()` → how it is edited. */
    export const translateableRoutes = new Map<Function, Map<string, TranslatableRouteType>>();

    /** Signum's `IsActivated` — true once @altea/altea-translations has started. */
    export let isActivated = false;

    /**
     * Signum's `Start(sb)`: on schema completion, scan every included type's property routes for
     * `@translatable` and register them. Called by @altea/altea-translations, not by core — a route is
     * only "translatable" if something can actually store the translation.
     */
    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.schema.schemaCompleted.push(schema => {
            for (const type of schema.tables.keys())
                for (const route of PropertyRoute.generateRoutes(type)) {
                    const fi = route.fieldInfo;
                    if (fi == undefined || fi.translatable == undefined || fi.translatable === false)
                        continue;
                    if (fi.notMapped)
                        continue; // Signum's `[Ignore]` exclusion: nothing to translate on an unmapped field
                    if (isTranslationDisabledByAncestor(route))
                        continue;
                    registerRoute(route, fi.translatable);
                }
        });
    }

    // Signum's `IsTranslationDisabledByAncestor`: `@translatable(false)` on an embedded switches the whole
    // sub-tree off, however its descendants are marked.
    function isTranslationDisabledByAncestor(route: PropertyRoute): boolean {
        for (let pr = route.parent; pr != undefined && pr.propertyRouteType !== PropertyRouteType.Root; pr = pr.parent)
            if (pr.propertyRouteType === PropertyRouteType.FieldOrProperty && pr.fieldInfo?.translatable === false)
                return true;
        return false;
    }

    /** Signum's `RegisterRoute` — the manual form, for a route the decorator cannot reach. */
    export function registerRoute(route: PropertyRoute, routeType: TranslatableRouteType = "Text"): void {
        if (route.propertyRouteType !== PropertyRouteType.FieldOrProperty)
            throw new Error(`Routes of type ${route.propertyRouteType} can not be translatable`);
        if (route.fieldInfo?.typeName !== "String")
            throw new Error(`Only string routes can be translatable ('${route.toString()}')`);

        const rootCtor = route.rootType;
        let map = translateableRoutes.get(rootCtor);
        if (map == undefined)
            translateableRoutes.set(rootCtor, map = new Map());
        map.set(route.propertyString(), routeType);
    }

    /** Signum's typed `RegisterRoute<T, S>(e => e.name)`. */
    export function registerRouteFor<T extends Entity>(
        type: Type<T>, propertyString: string, routeType: TranslatableRouteType = "Text"): void {
        registerRoute(PropertyRoute.parse(type, propertyString), routeType);
    }

    /** The translatable routes of a root type (Signum's `TranslateableRoutes.GetOrThrow(type)`). */
    export function routesOf(rootCtor: Function): Map<string, TranslatableRouteType> {
        return translateableRoutes.get(rootCtor) ?? new Map();
    }

    /** Every root type that has at least one translatable route. */
    export function translatableTypes(): Function[] {
        return [...translateableRoutes.keys()];
    }

    export function isTranslateable(route: PropertyRoute): boolean {
        return isActivated && translateableRoutes.get(route.rootType)?.has(route.propertyString()) === true;
    }

    export function routeType(route: PropertyRoute): TranslatableRouteType | undefined {
        return translateableRoutes.get(route.rootType)?.get(route.propertyString());
    }

    /**
     * Signum's `TranslatedFieldFunc` — the swappable resolver. @altea/altea-translations replaces it with
     * one that reads its cache for the current UI culture; the default returns the fallback, which is
     * what makes every call site safe with the module absent.
     */
    export let translatedFieldFunc: (lite: Lite<Entity>, route: PropertyRoute, fallback: string | null) => string | null =
        (_lite, _route, fallback) => fallback;

    /** Signum's `TranslatedField(lite, route, fallbackString)`. */
    export function translatedField(lite: Lite<Entity>, route: PropertyRoute, fallback: string | null): string | null {
        return translatedFieldFunc(lite, route, fallback);
    }

    /**
     * Install the resolver into the JSON serializer, so every translatable field on an entity leaving the
     * server is accompanied by `<field>_translated` — the current culture's text (Signum ships the same
     * property, through a per-type JSON PropertyConverter). This is what lets a Line show the translation
     * as help text without a round-trip. @altea/altea-translations calls it from its start.
     */
    export function installSerializerHook(): void {
        setTranslatedFieldProvider((entity, route) => {
            if (!isActivated || entity.isNew)
                return undefined;
            if (translateableRoutes.get(route.rootType)?.has(route.propertyString()) !== true)
                return undefined;
            return translatedFieldFunc(entity.toLite(), route, null);
        });
    }
}
