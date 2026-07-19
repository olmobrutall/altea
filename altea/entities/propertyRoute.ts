import { Entity } from './entity';
import type { BaseEntity, Type } from './entity';
import { typeConstructor } from './entity';
import type { FieldInfo } from './reflection';
import { tryGetTypeInfo, fieldType, fieldEnum, fieldTypeName } from './reflection';
import { cleanTypeName, resolveCleanType } from './registration';
import { MixinDeclarations } from './mixinDeclarations';
import { Implementations } from './implementations';
import {
    RuntimeType, ClassType, LiteType, ArrayType, EnumType, TemporalType, LiteralType,
} from './runtimeTypes';

// Port of Signum's `PropertyRouteType` (Basics/PropertyRoute.cs). String-valued (not the
// numeric C# enum) so route dumps read clearly.
export enum PropertyRouteType {
    Root = "Root",
    FieldOrProperty = "FieldOrProperty",
    Mixin = "Mixin",
    LiteEntity = "LiteEntity",
    MListItems = "MListItems",
}

// A field's altea RuntimeType (Phase-0 counterpart of the binder's private `baseTypeOfFieldInfo`,
// with container flags applied). Diverges from the binder in one place: an enum field yields a
// real `EnumType` here (the token layer classifies enums — IsGroupable, sub-tokens), whereas the
// binder's `resolveMemberType` still returns null for enums. The two are consumed independently:
// this feeds token metadata; expression nodes type themselves via the binder.
function fieldRuntimeType(fi: FieldInfo): RuntimeType {
    let t = baseFieldType(fi);
    if (fi.lite)
        t = new LiteType(t);
    if (fi.array)
        t = new ArrayType(t);
    return t;
}

// An entity reference targets a concrete entity, an abstract entity base (an inheritance
// root like AwardEntity), or the `Entity` base itself (a polymorphic @implementedBy(All)
// reference typed as Entity/an interface). All three re-root / carry implementations.
function isEntityCtor(ctor: Function): boolean {
    return ctor === Entity || ctor.prototype instanceof Entity;
}

function baseFieldType(fi: FieldInfo): RuntimeType {
    if (fi.isEnum) {
        const e = fieldEnum(fi);
        return e != undefined ? new EnumType(e, fieldTypeName(fi) ?? "") : LiteralType.null;
    }
    switch (fi.typeName) {
        case "Number": return LiteralType.number;
        case "String": return LiteralType.string;
        case "Boolean": return LiteralType.boolean;
        case "PlainDateTime": return new TemporalType("dateTime");
        case "PlainDate": return new TemporalType("date");
        case "Duration": return new TemporalType("duration");
    }
    const ctor = fieldType(fi);
    if (ctor != undefined)
        return new ClassType(ctor);
    // A polymorphic reference declared with an interface type (no runtime ctor) is still an
    // entity reference — type it as the Entity base (mirrors the binder's baseTypeOfFieldInfo).
    if (fi.implementations != undefined)
        return new ClassType(Entity);
    return LiteralType.null;
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
        const ctor = typeof rootEntity === 'function' ? rootEntity : typeConstructor(rootEntity);
        let r = PropertyRoute.rootCache.get(ctor);
        if (r == undefined) {
            r = new PropertyRoute(PropertyRouteType.Root, undefined, ctor, undefined, undefined);
            PropertyRoute.rootCache.set(ctor, r);
        }
        return r;
    }

    // The route's runtime type.
    get type(): RuntimeType {
        switch (this.propertyRouteType) {
            case PropertyRouteType.Root: return new ClassType(this.rootCtor!);
            case PropertyRouteType.Mixin: return new ClassType(this.mixinCtor!);
            case PropertyRouteType.FieldOrProperty: return fieldRuntimeType(this.fieldInfo!);
            case PropertyRouteType.MListItems: return this.parent!.type.elementType ?? LiteralType.null;
            case PropertyRouteType.LiteEntity: {
                const p = this.parent!.type;
                return p instanceof LiteType ? p.entityType : LiteralType.null;
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
        const ct = t instanceof LiteType ? t.entityType : t;
        if (ct instanceof ClassType && isEntityCtor(ct.constructorFunction))
            return ct.constructorFunction;
        return undefined;
    }

    // The ctor whose fields the next member is read from.
    private ownerCtor(): Function | undefined {
        switch (this.propertyRouteType) {
            case PropertyRouteType.Root: return this.rootCtor!;
            case PropertyRouteType.Mixin: return this.mixinCtor!;
            default: {
                const t = this.type;
                const ct = t instanceof LiteType ? t.entityType : t;
                return ct instanceof ClassType ? ct.constructorFunction : undefined;
            }
        }
    }

    addMany(fieldOrProperties: string): PropertyRoute {
        let r: PropertyRoute = this;
        for (const f of fieldOrProperties.split("."))
            r = r.add(f);
        return r;
    }

    // Port of Signum's `PropertyRoute.Add` (+ `AddImp`): appends one navigation step. Navigating
    // through a single-implementation entity reference RE-ROOTS at the referenced concrete type
    // (Signum's AddImp), so a sub-route belongs to that entity, not the owner. A polymorphic
    // (implementedBy-many / byAll) reference throws — cast first (AsTypeToken).
    add(member: string): PropertyRoute {
        if (member.startsWith("["))
            return this.addMixin(member);

        if (this.propertyRouteType !== PropertyRouteType.Root && this.entityCtor() != undefined) {
            const imp = this.getImplementations();
            const only = imp.only();
            if (imp.isByAll || only == undefined)
                throw new Error(`Attempt to navigate '${member}' through a polymorphic reference (${imp}) on ${this}. Cast first.`);
            return PropertyRoute.root(only).add(member);
        }

        // Collection element (Signum's "Item").
        if ((member === "Item" || member === "item") && this.type instanceof ArrayType)
            return new PropertyRoute(PropertyRouteType.MListItems, this, undefined, undefined, undefined);

        // Lite dereference (Signum's ".Entity").
        if ((member === "Entity" || member === "entity" || member === "EntityOrNull" || member === "entityOrNull")
            && this.type instanceof LiteType)
            return new PropertyRoute(PropertyRouteType.LiteEntity, this, undefined, undefined, undefined);

        const owner = this.ownerCtor();
        if (owner == undefined)
            throw new Error(`Cannot navigate '${member}' from ${this} (no owner type)`);

        const fi = tryGetTypeInfo(owner)?.fields[member];
        if (fi == undefined)
            throw new Error(`'${member}' does not exist on ${owner.name} (route ${this})`);

        return new PropertyRoute(PropertyRouteType.FieldOrProperty, this, undefined, fi, undefined);
    }

    private addMixin(member: string): PropertyRoute {
        const mixinName = member.slice(1, -1); // strip the surrounding [ ]
        const owner = this.ownerCtor();
        const mixinCtor = owner == undefined ? undefined :
            MixinDeclarations.getMixins(owner as Type<BaseEntity>).map(typeConstructor).find(m => m.name === mixinName);
        if (mixinCtor == undefined)
            throw new Error(`Mixin ${member} does not exist on ${owner?.name} (route ${this})`);
        return new PropertyRoute(PropertyRouteType.Mixin, this, undefined, undefined, mixinCtor);
    }

    // ---- Implementations -------------------------------------------------------------------

    tryGetImplementations(): Implementations | undefined {
        if (this.propertyRouteType !== PropertyRouteType.Root && this.entityCtor() != undefined)
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
