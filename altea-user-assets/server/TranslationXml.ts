import type { Quoted } from "quote-transformer/quoted";
import type { Entity, Type } from "@altea/altea/data/entity";
import { PropertyRoute, PropertyRouteType, isPartType } from "@altea/altea/data/propertyRoute";
import { getLambdaMembers } from "@altea/altea/data/lambdaMembers";
import { PropertyRouteTranslationLogic, type InstanceTranslationLookup } from "@altea/altea/server/propertyRouteTranslation";
import { A } from "./XmlUtils";

// A translatable field written next to its translations, one per culture that has a CURRENT one (a stale
// translation, made against an older text, is not written):
//     DisplayName="Next orders" DisplayName_es="Próximos pedidos" DisplayName_de="Nächste Bestellungen"
// or, for a field written as an element (multi-line text), sibling elements <Description_de>…</Description_de>.
// The instance is the entity passed in — the asset, a row, a part's content — and the field is the lambda,
// so an embedded field reads `f => f.pinned!.label` on its row. A row's field is translated under the route
// its OWNER registers (`steps/title` of a tour), which is the one the serializer shows it by.

type Field<T extends Entity> = Quoted<(entity: T) => string | null>;

/** Where a field's translations are stored: `path` is a route of `rootType`. */
interface TranslatedRoute {
    rootType: Type<Entity>;
    path: string;
}

const culturePattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/;

function translatedRoute<T extends Entity>(entity: T, field: Field<T>): TranslatedRoute | undefined {
    if (!PropertyRouteTranslationLogic.isActivated)
        return undefined;
    const type = entity.getType();
    if (!isPartType(type)) {
        const route = PropertyRoute.root(type).addLambda(field);
        return PropertyRouteTranslationLogic.isTranslateable(route) ? { rootType: type, path: route.propertyString() } : undefined;
    }
    return partRoutes().get(type)?.get(getLambdaMembers(field).map(m => m.name).join("."));
}

// part type → member path inside the part → the owner's registered route. Built once, after the schema.
let partRoutesCache: Map<Type<Entity>, Map<string, TranslatedRoute>> | undefined;
function partRoutes(): Map<Type<Entity>, Map<string, TranslatedRoute>> {
    if (partRoutesCache != undefined)
        return partRoutesCache;
    const result = new Map<Type<Entity>, Map<string, TranslatedRoute>>();
    for (const [rootType, routes] of PropertyRouteTranslationLogic.translateableRoutes)
        for (const path of routes.keys()) {
            // The innermost step that enters a part: a collection's element, or the cast of a polymorphic one.
            let step = PropertyRoute.parse(rootType, path).parent;
            while (step != undefined && step.propertyRouteType !== PropertyRouteType.MListItems && step.propertyRouteType !== PropertyRouteType.Cast)
                step = step.parent;
            const part = step?.type.typeInfos()[0]?.ctor as Type<Entity> | undefined;
            if (step == undefined || part == undefined || !isPartType(part))
                continue;
            const member = path.slice(step.propertyString().length).replace(/^[./]/, "");
            (result.get(part) ?? result.set(part, new Map()).get(part)!).set(member, { rootType: rootType as Type<Entity>, path });
        }
    return partRoutesCache = result;
}

function translationsOf<T extends Entity>(entity: T, field: Field<T>, value: string, translations: InstanceTranslationLookup): [string, string][] {
    if (entity.isNew)
        return [];
    const route = translatedRoute(entity, field);
    if (route == undefined)
        return [];
    return [...translations.get(entity.toLite(), route.path, value)]
        .filter(([, text]) => text !== "")
        .sort(([a], [b]) => a.localeCompare(b));
}

export function writeAttributeWithTranslations<T extends Entity>(x: Record<string, unknown>, name: string,
    entity: T, field: Quoted<(entity: T) => string | null>, ctx: { readonly translations: InstanceTranslationLookup }): void {
    const value = field(entity);
    if (value == null)
        return;
    x[A + name] = value;
    for (const [culture, text] of translationsOf(entity, field, value, ctx.translations))
        x[`${A}${name}_${culture}`] = text;
}

export function writeElementWithTranslations<T extends Entity>(x: Record<string, unknown>, name: string,
    entity: T, field: Quoted<(entity: T) => string | null>, ctx: { readonly translations: InstanceTranslationLookup }): void {
    const value = field(entity);
    if (value == null)
        return;
    x[name] = value;
    for (const [culture, text] of translationsOf(entity, field, value, ctx.translations))
        x[`${name}_${culture}`] = text;
}

/** The attribute's value; its translations are queued on the context, saved once the entity is. */
export function readAttributeWithTranslations<T extends Entity>(x: Record<string, unknown>, name: string,
    entity: T, field: Quoted<(entity: T) => string | null>, ctx: { readonly translations: TranslationQueue }): string | null {
    const value = textOf(x[A + name]);
    ctx.translations.set(entity, translatedRoute(entity, field), value, suffixed(x, A + name + "_"));
    return value;
}

export function readElementWithTranslations<T extends Entity>(x: Record<string, unknown>, name: string,
    entity: T, field: Quoted<(entity: T) => string | null>, ctx: { readonly translations: TranslationQueue }): string | null {
    const value = textOf(x[name]);
    ctx.translations.set(entity, translatedRoute(entity, field), value, suffixed(x, name + "_"));
    return value;
}

function suffixed(x: Record<string, unknown>, prefix: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const [key, v] of Object.entries(x)) {
        if (!key.startsWith(prefix))
            continue;
        const culture = key.slice(prefix.length);
        const text = textOf(v);
        if (culturePattern.test(culture) && text != null && text !== "")
            result.set(culture, text);
    }
    return result;
}

// An attribute is a scalar; an element is an array (the parser's isArray), of a string or of { "#text" }.
function textOf(v: unknown): string | null {
    const one = Array.isArray(v) ? v[0] : v;
    if (one == null)
        return null;
    if (typeof one === "object")
        return (one as Record<string, unknown>)["#text"] == null ? "" : String((one as Record<string, unknown>)["#text"]);
    return String(one);
}

/**
 * The translations an import READ, applied once their entities are saved (a new row has no id before).
 * A field read with no translations still replaces what the database has, deleting them.
 */
export class TranslationQueue {
    private readonly items: { entity: Entity; route: TranslatedRoute; original: string | null; texts: Map<string, string> }[] = [];

    set(entity: Entity, route: TranslatedRoute | undefined, original: string | null, texts: Map<string, string>): void {
        if (route != undefined)
            this.items.push({ entity, route, original, texts });
    }

    async save(): Promise<void> {
        for (const i of this.items.splice(0))
            await PropertyRouteTranslationLogic.saveInstanceTranslations(i.entity.toLite(), i.route.rootType, i.route.path, i.original, i.texts);
    }

    /** Whether saving would change what the database has. Read-only, so from the translations cache. */
    async differs(): Promise<boolean> {
        if (this.items.length == 0)
            return false;
        const current = await PropertyRouteTranslationLogic.loadInstanceTranslations({ cached: true });
        return this.items.some(i => i.entity.isNew
            || !sameTexts(current.get(i.entity.toLite(), i.route.path, i.original), i.original == null ? new Map() : i.texts));
    }
}

function sameTexts(a: Map<string, string>, b: Map<string, string>): boolean {
    return a.size === b.size && [...a].every(([culture, text]) => b.get(culture) === text);
}
