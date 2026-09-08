import { Entity, EmbeddedEntity } from './entity';
import type { BaseEntity, Type } from './entity';
import type { FieldInfo } from './reflection';
import { tryGetTypeInfo, TypeReference } from './reflection';
import { cleanTypeName, resolveCleanType } from './registration';
import { getLambdaMembers } from './lambdaMembers';
import type { Quoted } from 'quote-transformer/quoted';
import { MixinDeclarations } from './mixinDeclarations';
import { Implementations } from './implementations';

// Port of Signum's `PropertyRouteType` (Basics/PropertyRoute.cs). String-valued (not the
// numeric C# enum) so route dumps read clearly.
export enum PropertyRouteType {
    Root = "Root",
    FieldOrProperty = "FieldOrProperty",
    Mixin = "Mixin",
    LiteEntity = "LiteEntity",
    MListItems = "MListItems",
}

// Faithful port of Signum's `PropertyRoute` (Basics/PropertyRoute.cs), scoped to what the
// DynamicQuery token layer needs. A route is a typed navigation path from a root entity through
// fields / mixins / lite-dereferences / collection items.
//
// Key divergences from Signum (recorded for the port log):
//  - `type` is an altea `RuntimeType`, not a .NET `Type` (unifies with the expression model).
//  - Implementations resolve off `FieldInfo` (see Implementations.tryFromFieldInfo), so there is
//    no `FindImplementations` callback.
//  - In-memory materialisation (`GetLambdaExpression`/`GetBody`), `MatchesEntity`, and
//    `GenerateRoutes` are NOT ported yet (deferred with the token layer's in-memory evaluator).
/**
 * LEGACY MODE: write a route's members the way Signum spells them, PascalCase — `Id`, `ShipAddress.City`,
 * `Elements/Label`. altea's member IS the TypeScript field name, so a `propertyString()` is camelCase,
 * and `basics.property_route.path` is the one place that difference is visible to a database: pointed at
 * a Signum one, every stored route read as a different route and the sync offered each as a rename.
 *
 * Only the CASE differs — the structure (`.` between members, `/` for a collection element, `[Mixin]`,
 * `.Entity`) is already Signum's. Reversing it is exact because altea's member name is Signum's with a
 * lower-cased initial, and `add` accepts either spelling regardless of this flag.
 *
 * Set from the app's shared entity-overrides module, so BOTH TIERS agree: a route is built CLIENT-side
 * too (the tour editor, the validation designer) and arrives id-less for the server to resolve against
 * the row that already exists — which it can only do if both spell the path the same way. It is also
 * the key of `TypeMetadata.fields`, which the server builds and the client reads.
 */
let legacyPropertyPaths = false;
export function setLegacyPropertyPaths(value: boolean): void {
    legacyPropertyPaths = value;
}

/** Whether routes are currently spelled Signum's way — see {@link setLegacyPropertyPaths}. */
export function usingLegacyPropertyPaths(): boolean {
    return legacyPropertyPaths;
}

/**
 * Is `ctor` a `@part` ROW — an entity that exists only as part of the one entity that owns it?
 *
 * This is what decides whether a navigation step RE-ROOTS. Signum re-roots at every entity reference
 * (`AddImp`) because in Signum a part is not an entity at all: an `MList` element or an owned
 * `EmbeddedEntity` is FLATTENED into its owner's route, so `Columns/DisplayName` and
 * `ShipAddress.City` are routes OF the owner. altea gives both a table and therefore a class, which
 * would make them look like ordinary references and re-root — turning the same two routes into
 * `(UserChartColumn).DisplayName` and `(Address).City`, rooted at something a Signum database has
 * never heard of.
 *
 * So a `@part` step CONTINUES the route, inside an array (the old MList) or not. `SharedPart` is
 * deliberately excluded: it has more than one owner, so "continue the parent" has no single answer
 * and re-rooting is the only unambiguous thing to do — which is exactly the distinction Signum's
 * `EntityKind.SharedPart` draws.
 */
export function isPartType(ctor: Function | undefined): boolean {
    return ctor != undefined && tryGetTypeInfo(ctor)?.entityKind === "Part";
}

/**
 * How ONE member is spelled inside a stored path, under whichever mode is active — `PropertyRoute
 * .storedMember` made public so a caller that composes a path WITHOUT a PropertyRoute spells it exactly
 * as a real route would. Its consumer is the synchronizer's expression-route seam
 * (`PropertyRouteLogic.extraSyncRoutes`), which names a member altea has no FieldInfo for: two
 * implementations of "PascalCase in legacy mode" would silently disagree the day either changed.
 */
export function storedMemberName(member: string): string {
    return legacyPropertyPaths ? member.firstUpper() : member;
}

export class PropertyRoute {
    // `isAllowedCallback` mirrors Signum's `PropertyRoute.SetIsAllowedCallback` (auth). Unset ⇒
    // everything allowed.
    static isAllowedCallback?: (route: PropertyRoute) => string | null;

    private constructor(
        public readonly propertyRouteType: PropertyRouteType,
        public readonly parent: PropertyRoute | undefined,
        private readonly rootCtor: Function | undefined,
        public readonly fieldInfo: FieldInfo | undefined,
        private readonly mixinCtor: Function | undefined,
        /** Only {@link memberPaths} passes this — see there for the one consumer a part root is right for. */
        allowPartRoot = false,
    ) {
        // A `@part` may not be the ROOT of a route — only a continuation of the entity that owns it.
        // Checked HERE rather than at each call site because `root()` is not the only way in (`add`'s
        // re-root branch builds one too) and because the whole point is that there is no second name for
        // a member: `Product.AdditionalInformation/Key` and `(Product_AdditionalInformation).Key` cannot
        // both exist, or a rule written under one is invisible to a lookup made through the other.
        // See {@link isPartType}.
        if (!allowPartRoot && propertyRouteType === PropertyRouteType.Root && isPartType(rootCtor))
            throw new Error(
                `${rootCtor!.name} is a @part, so it cannot be the ROOT of a PropertyRoute — a part is a ` +
                `continuation of the entity that owns it. Reach the member through the owner ` +
                `(\`owner.thePart.member\`, \`owner.theParts/member\`), or hold the OWNER's route and add to it.`);
    }

    private static rootCache = new Map<Function, PropertyRoute>();

    static root(rootEntity: Function | Type<BaseEntity>): PropertyRoute {
        const ctor = typeof rootEntity === 'function' ? rootEntity : rootEntity;
        let r = PropertyRoute.rootCache.get(ctor);
        if (r == undefined) {
            r = new PropertyRoute(PropertyRouteType.Root, undefined, ctor, undefined, undefined);
            PropertyRoute.rootCache.set(ctor, r);
        }
        return r;
    }

    // The route's type facet. For a field/property it IS the field's FieldInfo (a TypeReference);
    // Root/Mixin wrap the class; MListItems unwraps the collection element; LiteEntity unwraps the Lite.
    get type(): TypeReference {
        switch (this.propertyRouteType) {
            case PropertyRouteType.Root: return new TypeReference({ type: () => this.rootCtor! });
            case PropertyRouteType.Mixin: return new TypeReference({ type: () => this.mixinCtor! });
            case PropertyRouteType.FieldOrProperty: return this.fieldInfo!;
            case PropertyRouteType.MListItems: return this.parent!.type.elementType ?? new TypeReference();
            case PropertyRouteType.LiteEntity: {
                const p = this.parent!.type;
                return p.lite ? Object.assign(new TypeReference(), p, { lite: false }) : new TypeReference();
            }
        }
    }

    get rootType(): Function {
        let r: PropertyRoute = this;
        while (r.propertyRouteType !== PropertyRouteType.Root)
            r = r.parent!;
        return r.rootCtor!;
    }

    // The field/property name this route step navigates ("" for non-FieldOrProperty steps).
    get member(): string {
        return this.fieldInfo?.name ?? "";
    }

    // The concrete entity ctor this route references (through a Lite<T> if present), or undefined
    // if it is not an entity reference (value / embedded / collection).
    private entityCtor(): Function | undefined {
        const t = this.type;
        if (t.array) return undefined;                 // a collection is not a single entity reference
        return t.is(Entity) ? t.getFunction() : undefined;
    }

    // The ctor whose fields the next member is read from.
    private ownerCtor(): Function | undefined {
        switch (this.propertyRouteType) {
            case PropertyRouteType.Root: return this.rootCtor!;
            case PropertyRouteType.Mixin: return this.mixinCtor!;
            default: return this.type.getFunction();
        }
    }

    addMany(fieldOrProperties: string): PropertyRoute {
        let r: PropertyRoute = this;
        for (const f of fieldOrProperties.split("."))
            r = r.add(f);
        return r;
    }

    // Signum's `PropertyRoute.addMember(...)` — altea's single navigation step is `add(name)` (it
    // already dispatches Item / Entity / mixin), so addMember is the Signum-named alias.
    addMember(member: string): PropertyRoute {
        return this.add(member);
    }

    // Signum's `PropertyRoute.addLambda(e => e.a.b)` — navigate a property-access lambda (incl.
    // `a.mixin(SomeMixin).field`). Each parsed member becomes a step: Mixin → addMixin, Indexer → the
    // collection "Item", plain member → add(name). (getLambdaMembers returns them root-first.)
    addLambda(lambda: Quoted<(val: any) => any>): PropertyRoute {
        return getLambdaMembers(lambda).reduce<PropertyRoute>(
            (pr, m) => m.type == "Mixin" ? pr.addMixin(m.name) : pr.add(m.type == "Indexer" ? "Item" : m.name),
            this);
    }

    tryAddLambda(lambda: Quoted<(val: any) => any>): PropertyRoute | undefined {
        try {
            return this.addLambda(lambda);
        } catch {
            return undefined;
        }
    }

    // Signum's `PropertyRoute.subMembers()` — the fields navigable from here (the fields of the type
    // whose next member this route reads: the referenced entity, embedded, or root/mixin type).
    subMembers(): { [name: string]: FieldInfo } {
        const owner = this.ownerCtor();
        return owner ? (tryGetTypeInfo(owner)?.fields ?? {}) : {};
    }

    // Port of Signum's `PropertyRoute.Add` (+ `AddImp`): appends one navigation step. Navigating
    // through a single-implementation entity reference RE-ROOTS at the referenced concrete type
    // (Signum's AddImp), so a sub-route belongs to that entity, not the owner. A polymorphic
    // (implementedBy-many / byAll) reference throws — cast first (AsTypeToken).
    add(member: string): PropertyRoute {
        // An entity/lite reference (NOT a collection — that navigates via "Item" below) re-roots.
        // is(Entity) also holds for a polymorphic @implementedBy interface (no single ctor), so this
        // fires for it too — and getImplementations().only() being undefined then throws "Cast first".
        // NOT through a `@part`, in an array or not: a part is altea's stand-in for an MList element or
        // an owned embedded, both of which Signum FLATTENS into the owner's route — so it only LOOKS
        // like a reference, and re-rooting would turn `Columns/DisplayName` and `ShipAddress.City` into
        // routes of a type a Signum database has never heard of. See isPartType.
        if (this.propertyRouteType !== PropertyRouteType.Root && !this.type.array && this.type.is(Entity)) {
            const imp = this.getImplementations();
            const only = imp.only();
            if (!isPartType(only)) {
                if (imp.isByAll || only == undefined)
                    throw new Error(`Attempt to navigate '${member}' through a polymorphic reference (${imp}) on ${this}. Cast first.`);
                return PropertyRoute.root(only).add(member);
            }
        }

        // Collection element (Signum's "Item").
        if ((member === "Item" || member === "item") && this.type.array)
            return new PropertyRoute(PropertyRouteType.MListItems, this, undefined, undefined, undefined);

        // Lite dereference (Signum's ".Entity").
        if ((member === "Entity" || member === "entity" || member === "EntityOrNull" || member === "entityOrNull")
            && this.type.lite)
            return new PropertyRoute(PropertyRouteType.LiteEntity, this, undefined, undefined, undefined);

        const owner = this.ownerCtor();
        if (owner == undefined)
            throw new Error(`Cannot navigate '${member}' from ${this} (no owner type)`);

    // A member is matched by its OWN name first and then with a lower-cased initial, so a route STORED
    // in Signum's PascalCase (`Id`, `ShipAddress.City` — see setLegacyPropertyPaths) parses whichever
    // mode is on. The same tolerance `resolveType` already has for a name that came from a URL.
        const info = tryGetTypeInfo(owner);
        const fields = info?.fields;
        let fi = fields?.[member] ?? fields?.[member.firstLower()];

        // LEGACY MODE: a stored path writes the collection ROW's `@valueField` wrapper away, so the
        // member after `/` names the ELEMENT's field and is not on the row at all — see
        // isValueFieldStep. Step through the wrapper to find it, which is what makes the path a
        // ROUND TRIP rather than only a spelling.
        if (fi == undefined && legacyPropertyPaths && this.propertyRouteType === PropertyRouteType.MListItems) {
            const valueField = info?.valueField;
            if (valueField != undefined)
                return new PropertyRoute(PropertyRouteType.FieldOrProperty, this, undefined, valueField, undefined).add(member);
        }

        if (fi == undefined)
            throw new Error(`'${member}' does not exist on ${owner.name} (route ${this})`);
        return new PropertyRoute(PropertyRouteType.FieldOrProperty, this, undefined, fi, undefined);
    }

    // Navigate into a mixin declared on the owner (Signum's mixin route step). `mixinName` is the
    // mixin class name — from `a.mixin(SomeMixin)` in a Quoted lambda (getLambdaMembers) or the
    // subCtx(Type) overload. altea keeps mixin fields flat on the entity, but the route still models
    // the mixin so `.field` off it resolves against the mixin's reflected fields.
    addMixin(mixinName: string): PropertyRoute {
        const owner = this.ownerCtor();
        const mixinCtor = owner == undefined ? undefined :
            MixinDeclarations.getMixins(owner as Type<BaseEntity>).find(m => m.name === mixinName);
        if (mixinCtor == undefined)
            throw new Error(`Mixin '${mixinName}' does not exist on ${owner?.name} (route ${this})`);
        return new PropertyRoute(PropertyRouteType.Mixin, this, undefined, undefined, mixinCtor);
    }

    // Port of Signum's PropertyRoute.GenerateRoutes: every value/embedded property route reachable from
    // the root, descending embeddeds, `@part` references + mixins but STOPPING at ordinary entity/Lite
    // references (they re-root, so their sub-properties belong to that entity's own routes). A `@part`
    // is descended for the same reason it does not re-root: it stands in for an owned embedded, whose
    // members ARE routes of the owner (see isPartType). Used to enumerate a type's properties for
    // property authorization, for the routes table's sync, for help and for translated instances.
    //
    // `includeArrayElements` is Signum's `includeMListElements` and means exactly what Signum's means:
    // whether the BARE element route (`additionalInformation/`) is one of the results. It does NOT gate
    // descending INTO the element — Signum calls `GenerateEmbeddedProperties(itemRoute, …)` outside the
    // flag, so `AdditionalInformation/Key` is a route of Product whoever is asking. altea had gated the
    // whole descent on it, so the property-auth pack (which passes false, as Signum's does) never saw a
    // single collection member: Southwind's `Product|AdditionalInformation/Key` rule had no counterpart
    // here and eastwind's AuthRules.xml carries it commented out.
    static generateRoutes(rootType: Function, includeArrayElements = false): PropertyRoute[] {
        // A `@part` has NONE of its own: its members are routes of the entity that owns it, which this
        // walk descends into from there. Answering `[]` rather than throwing is what lets the half-dozen
        // enumerators that loop over every mapped type — property authorization, the routes table's sync,
        // translatable routes, help, the dynamic-view designer — stay a plain loop; each of them wants
        // exactly this, and none of them should have to know the rule. The two consumers that DO want a
        // part's own members ask for them by name (see memberPaths / rootStandalone).
        if (isPartType(rootType))
            return [];
        const result: PropertyRoute[] = [];
        PropertyRoute.root(rootType).generateRoutesInto(result, includeArrayElements);
        return result;
    }

    /**
     * A type's member paths as STRINGS — `generateRoutes(...).map(propertyString)`, and the one thing that
     * also answers for a `@part`.
     *
     * A part may not be a route ROOT (see the constructor), which is right for every consumer that stores
     * or resolves a route: there is one spelling of a part's member and it goes through the owner. But a
     * part class still HAS members, and one consumer needs exactly that list without caring where the
     * members hang: the reflection blob's per-type label dictionary, which `FieldInfo.niceToString()`
     * reads by (declaring type, member) — so `AlbumEntity_Song.name` must have an entry under the SONG,
     * whatever route reaches it.
     *
     * It hands back strings rather than routes precisely so the answer cannot be mistaken for one and
     * stored: a `@part` root exists for the length of this call and never escapes it.
     */
    static memberPaths(rootType: Function, includeArrayElements = false): string[] {
        const result: PropertyRoute[] = [];
        PropertyRoute.rootStandalone(rootType).generateRoutesInto(result, includeArrayElements);
        return result.map(r => r.propertyString());
    }

    /**
     * The root route of a type that is STANDING ALONE — the deliberate, named way past the constructor's
     * refusal of a `@part` root, and the only one.
     *
     * The refusal is about a part reached THROUGH its owner having two names. Two things reach a part with
     * no owner in the picture at all, and for them a root is the only answer there is:
     *
     *  - the reflection blob's per-type LABEL dictionary ({@link memberPaths}), keyed by (declaring type,
     *    member) — `AlbumEntity_Song.name` needs an entry under the SONG whatever route reaches it;
     *  - a part's OWN registered query (`sb.include(x).withQuery()` on a row type — @altea/altea-agent does
     *    it for a chat message's tool calls), whose columns are its own members. A stored token there is
     *    scoped by the QUERY key, so it cannot collide with the owner's spelling of the same member.
     *
     * Everything else goes through {@link root} and is refused, which is the point: those two are a short
     * list that can be read, and an accidental third is a throw rather than a second name for a member.
     */
    static rootStandalone(rootType: Function): PropertyRoute {
        if (!isPartType(rootType))
            return PropertyRoute.root(rootType);
        let r = PropertyRoute.partRootCache.get(rootType);
        if (r == undefined)
            PropertyRoute.partRootCache.set(rootType,
                r = new PropertyRoute(PropertyRouteType.Root, undefined, rootType, undefined, undefined, true));
        return r;
    }

    private static partRootCache = new Map<Function, PropertyRoute>();

    private generateRoutesInto(result: PropertyRoute[], includeArrayElements: boolean, visiting: Set<Function> = new Set()): void {
        // Inside a `@part` the row's BOOKKEEPING is not part of the model: the part stands in for a
        // Signum embedded / MList element, which has no `Id`, no `Ticks`, no `Parent` and no `Order`
        // property at all — Signum's `Parent`/`Order` are MList TABLE columns built with a null route.
        // Emitting them would offer four routes per collection that a Signum database has no counterpart
        // for, in the property-auth grid and in the routes table's diff alike. The part's own root still
        // shows them (that is the class, and the client's metadata is keyed by it) — this is about the
        // routes reached THROUGH an owner.
        const insidePart = isPartType(this.ownerCtor()) && this.propertyRouteType !== PropertyRouteType.Root;
        for (const [name, fi] of Object.entries(this.subMembers())) {
            if (fi.noSerialize) // @serialize(false) bookkeeping (isNew / _snapshot) — not a real property
                continue;
            if (insidePart && (fi.isBackReference || fi.isRowOrder || name === "id" || name === "ticks"))
                continue;
            const pr = this.add(name);
            result.push(pr);
            const t = pr.type;
            if (t.array) {
                const item = pr.add("Item");
                if (includeArrayElements)
                    result.push(item);
                // Signum descends an MList's element when it is an EMBEDDED, which is the only kind
                // its elements come in. altea's collection element is a `@part` ROW entity instead —
                // the MList divergence — so descending only into embeddeds skipped every element
                // route a Signum database has (`Columns/DisplayName`, `Parts/Title`, `Elements/Label`).
                // `visiting` guards the cycle an entity element makes possible and an embedded cannot.
                const infos = item.type.typeInfos();
                const element = infos.length === 1 ? infos[0]!.ctor : undefined;
                if (item.type.is(EmbeddedEntity)) {
                    item.generateRoutesInto(result, includeArrayElements, visiting);
                } else if (isPartType(element) && !visiting.has(element!)) {
                    visiting.add(element!);
                    item.generateRoutesInto(result, includeArrayElements, visiting);
                    visiting.delete(element!);
                }
            } else if (t.is(EmbeddedEntity)) {
                pr.generateRoutesInto(result, includeArrayElements, visiting); // descend embedded
            } else {
                // A SINGLE `@part` reference continues the route exactly as an embedded does — it is what
                // altea writes where Signum declares an owned EmbeddedEntity, so `ShipAddress.City` has to
                // be generated or the route a Signum database stores has no counterpart here. Guarded
                // against the cycle a reference makes possible and an embedded cannot.
                const infos = t.typeInfos();
                const single = infos.length === 1 ? infos[0]!.ctor : undefined;
                if (isPartType(single) && !visiting.has(single!)) {
                    visiting.add(single!);
                    pr.generateRoutesInto(result, includeArrayElements, visiting);
                    visiting.delete(single!);
                }
            }
            // ordinary entity / Lite reference: the route is pushed above, but we do NOT descend (re-roots).
        }
        const owner = this.ownerCtor();
        if (owner != undefined)
            for (const mixin of MixinDeclarations.getMixins(owner as Type<BaseEntity>))
                this.addMixin(mixin.name).generateRoutesInto(result, includeArrayElements, visiting);
    }

    // ---- Implementations -------------------------------------------------------------------

    tryGetImplementations(): Implementations | undefined {
        // An entity reference (incl. a polymorphic @implementedBy interface, which has no single ctor
        // but is still is(Entity)); collections and value/embedded fields have none.
        if (this.propertyRouteType !== PropertyRouteType.Root && !this.type.array && this.type.is(Entity))
            return this.getImplementations();
        return undefined;
    }

    getImplementations(): Implementations {
        if (this.propertyRouteType === PropertyRouteType.FieldOrProperty && this.fieldInfo != undefined) {
            const imp = Implementations.tryFromFieldInfo(this.fieldInfo);
            if (imp != undefined)
                return imp;
        }
        const ec = this.entityCtor();
        if (ec != undefined)
            return Implementations.by(ec);
        throw new Error(`No implementations for route ${this} (not an entity reference)`);
    }

    isAllowed(): string | null {
        return PropertyRoute.isAllowedCallback ? PropertyRoute.isAllowedCallback(this) : null;
    }

    /**
     * Refuse a route ROOTED at a `@part`. A part is a continuation of the one entity that owns it —
     * `Product.AdditionalInformation/Key`, never `(Product_AdditionalInformation).Key` — so the two
     * spellings would be two names for one thing, and whichever one a row happens to carry is then the
     * one that resolves. That is the ambiguity: a rule stored under the part is invisible to a lookup
     * made through the owner, a Signum database's row for the same member has no counterpart at all, and
     * the routes table offers each as a rename of the other.
     *
     * It is asserted at the STORAGE boundary, not in `root()`, because a part root is a perfectly good
     * TRANSIENT handle and some of them have no parent to continue: a `@backReference` navigation walks
     * UP and out of the owner's subtree, and a part rendered in a modal or handed to the codec on its own
     * has no enclosing route at all. What must never happen is one of those being written down.
     */
    assertNotPartRoot(context?: string): this {
        if (isPartType(this.rootType))
            throw new Error(
                `${context ?? "This route"} is rooted at the @part ${this.rootType.name} (${this}). A part's routes belong to ` +
                `the entity that owns it — reach the member through the owner (\`owner.thePart.member\`, ` +
                `\`owner.theParts/member\`) so there is one spelling of it.`);
        return this;
    }

    // ---- Simplification helpers (Signum's SimplifyTo* / GetMListItemsRoute) -----------------

    simplifyToProperty(): PropertyRoute {
        switch (this.propertyRouteType) {
            case PropertyRouteType.FieldOrProperty: return this;
            case PropertyRouteType.LiteEntity:
            case PropertyRouteType.MListItems: return this.parent!.simplifyToProperty();
            default: throw new Error(`PropertyRoute of type ${this.propertyRouteType} not expected`);
        }
    }

    simplifyToPropertyOrRoot(): PropertyRoute {
        switch (this.propertyRouteType) {
            case PropertyRouteType.Root:
            case PropertyRouteType.FieldOrProperty: return this;
            case PropertyRouteType.LiteEntity:
            case PropertyRouteType.MListItems:
            case PropertyRouteType.Mixin: return this.parent!.simplifyToPropertyOrRoot();
        }
    }

    getMListItemsRoute(): PropertyRoute | undefined {
        for (let r: PropertyRoute | undefined = this; r != undefined; r = r.parent)
            if (r.propertyRouteType === PropertyRouteType.MListItems)
                return r;
        return undefined;
    }

    // ---- Parsing (Signum's PropertyRoute.Parse) --------------------------------------------

    static parse(rootType: Function, propertyString: string): PropertyRoute {
        let result = PropertyRoute.root(rootType);
        for (const part of splitRoute(propertyString))
            result = result.add(part);
        return result;
    }

    // Parse a full route string "(CleanName).a.b" — the inverse of toString(). Basic form only
    // (no mixin-in-parentheses); resolves the root via the clean-name registry.
    static parseFull(fullToString: string): PropertyRoute {
        const m = /^\(([^)]+)\)\.?(.*)$/.exec(fullToString);
        if (m == null)
            throw new Error(`'${fullToString}' should start with the root type between parentheses`);
        const ctor = resolveCleanType(m[1]);
        if (ctor == undefined)
            throw new Error(`Type '${m[1]}' is not recognized`);
        return m[2].length === 0 ? PropertyRoute.root(ctor) : PropertyRoute.parse(ctor, m[2]);
    }

    // ---- ToString / equality ---------------------------------------------------------------

    private cachedToString?: string;
    toString(): string {
        return this.cachedToString ??= this.calculateToString();
    }

    private calculateToString(): string {
        switch (this.propertyRouteType) {
            case PropertyRouteType.Root: {
                const c = this.rootCtor!;
                return `(${c.prototype instanceof Entity ? cleanTypeName(c) : c.name})`;
            }
            case PropertyRouteType.FieldOrProperty:
                return this.parent!.toString() + (this.parent!.propertyRouteType === PropertyRouteType.MListItems ? "" : ".") + this.member;
            case PropertyRouteType.Mixin:
                return this.parent!.toString() + `[${this.mixinCtor!.name}]`;
            case PropertyRouteType.MListItems:
                return this.parent!.toString() + "/";
            case PropertyRouteType.LiteEntity:
                return this.parent!.toString() + ".Entity";
        }
    }

    /**
     * LEGACY MODE: is this step the `@valueField` of a collection ROW — the field that IS the element?
     * Signum's MList holds the embedded directly, so its route is `Columns/DisplayName`; altea's row
     * WRAPS it (`columns/element.displayName`), and the wrapper is the same indirection legacy column
     * naming already inlines away (see legacyMListColumnBase). So the step contributes nothing to the
     * path, and the member after it reads as if it hung off the collection directly.
     */
    private isValueFieldStep(): boolean {
        return legacyPropertyPaths
            && this.propertyRouteType === PropertyRouteType.FieldOrProperty
            && this.fieldInfo?.isValueField === true
            && this.parent?.propertyRouteType === PropertyRouteType.MListItems;
    }

    /** This step's member as a stored path writes it — see {@link setLegacyPropertyPaths}. */
    private storedMember(): string {
        return storedMemberName(this.member);
    }

    propertyString(): string {
        switch (this.propertyRouteType) {
            case PropertyRouteType.Root:
                throw new Error("Root has no PropertyString");
            case PropertyRouteType.FieldOrProperty:
                if (this.isValueFieldStep())
                    return this.parent!.propertyString();
                // A parent that IS such a step already ends in the collection's `/`, so no separator.
                if (this.parent!.isValueFieldStep())
                    return this.parent!.propertyString() + this.storedMember();
                switch (this.parent!.propertyRouteType) {
                    case PropertyRouteType.Root: return this.storedMember();
                    case PropertyRouteType.FieldOrProperty:
                    case PropertyRouteType.Mixin: return this.parent!.propertyString() + "." + this.storedMember();
                    case PropertyRouteType.MListItems: return this.parent!.propertyString() + this.storedMember();
                    default: throw new Error("unexpected parent route type");
                }
            case PropertyRouteType.Mixin:
                return (this.parent!.propertyRouteType === PropertyRouteType.Root ? "" : this.parent!.propertyString()) + `[${this.mixinCtor!.name}]`;
            case PropertyRouteType.MListItems:
                return this.parent!.propertyString() + "/";
            case PropertyRouteType.LiteEntity:
                return this.parent!.toString() + ".Entity";
        }
    }

    // A canonical key (rootType + property path) for Map/Set usage and equality.
    private routeKey(): string {
        return this.propertyRouteType === PropertyRouteType.Root ? "" : this.propertyString();
    }

    hashKey(): string {
        return this.rootType.name + "|" + this.routeKey();
    }

    equals(other: PropertyRoute): boolean {
        return this.propertyRouteType === other.propertyRouteType
            && this.rootType === other.rootType
            && this.routeKey() === other.routeKey();
    }
}

// Tokenises a property string into navigation steps, expanding '/' into collection "Item"
// steps and keeping '[Mixin]' segments intact. Basic — covers "a.b/Item.c" and "[Mixin].a".
function splitRoute(propertyString: string): string[] {
    const out: string[] = [];
    for (const dotPart of propertyString.split(".")) {
        const segs = dotPart.split("/");
        segs.forEach((seg, i) => {
            if (seg.length > 0)
                out.push(seg);
            if (i < segs.length - 1)
                out.push("Item");
        });
    }
    return out;
}
