import { Entity } from './entity';
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
    ) { }

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
        if (this.propertyRouteType !== PropertyRouteType.Root && !this.type.array && this.type.is(Entity)) {
            const imp = this.getImplementations();
            const only = imp.only();
            if (imp.isByAll || only == undefined)
                throw new Error(`Attempt to navigate '${member}' through a polymorphic reference (${imp}) on ${this}. Cast first.`);
            return PropertyRoute.root(only).add(member);
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

        const fi = tryGetTypeInfo(owner)?.fields[member];
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

    propertyString(): string {
        switch (this.propertyRouteType) {
            case PropertyRouteType.Root:
                throw new Error("Root has no PropertyString");
            case PropertyRouteType.FieldOrProperty:
                switch (this.parent!.propertyRouteType) {
                    case PropertyRouteType.Root: return this.member;
                    case PropertyRouteType.FieldOrProperty:
                    case PropertyRouteType.Mixin: return this.parent!.propertyString() + "." + this.member;
                    case PropertyRouteType.MListItems: return this.parent!.propertyString() + this.member;
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
