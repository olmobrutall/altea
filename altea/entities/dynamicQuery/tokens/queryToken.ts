import { Entity, EmbeddedEntity, ModelEntity } from "../../entity";
import { PropertyRoute } from "../../propertyRoute";
import { tryGetTypeInfo, type FieldInfo } from "../../reflection";
import { Implementations } from "../../implementations";
import {
    RuntimeType, ClassType, LiteType, ArrayType, EnumType, TemporalType, LiteralType,
} from "../../runtimeTypes";
import { tryGetFilterType, tryGetFilterTypeFromTypeName, type QueryName, type FilterType } from "../queryUtils";
import { niceName } from "../../utils/localization";
import { QueryTokenMessage, QueryTokenDateMessage, CollectionMessage } from "../../dynamicQueries";
import type { CollectionToArrayToken } from "./collectionToArrayToken";

// Port of Signum's `SubTokensOptions` (DynamicQuery/QueryUtils.cs). A bit-flag set controlling
// which families of sub-tokens a token exposes (aggregates, element access, operations, …).
export enum SubTokensOptions {
    CanAggregate = 1,
    CanAnyAll = 2,
    CanElement = 4,
    CanOperation = 8,
    CanToArray = 16,
    CanSnippet = 32,
    CanManual = 64,
    CanTimeSeries = 128,
    CanNested = 256,
}
export const SubTokensOptionsAll =
    SubTokensOptions.CanAggregate | SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement |
    SubTokensOptions.CanOperation | SubTokensOptions.CanToArray | SubTokensOptions.CanSnippet |
    SubTokensOptions.CanManual | SubTokensOptions.CanTimeSeries | SubTokensOptions.CanNested;

// ---- RuntimeType helpers (Signum's Type.CleanType()/ElementType()/IsIEntity()) -------------

export function cleanType(rt: RuntimeType): RuntimeType {
    return rt instanceof LiteType ? rt.entityType : rt;
}
function isEntityCtor(ctor: Function): boolean {
    return ctor === Entity || ctor.prototype instanceof Entity;
}
// The concrete entity ctor a type references (through a Lite), or undefined.
export function entityCtorOf(rt: RuntimeType): Function | undefined {
    const ct = cleanType(rt);
    return ct instanceof ClassType && isEntityCtor(ct.constructorFunction) ? ct.constructorFunction : undefined;
}
function embeddedOrModelCtorOf(rt: RuntimeType): Function | undefined {
    if (rt instanceof ClassType && (rt.constructorFunction.prototype instanceof EmbeddedEntity || rt.constructorFunction.prototype instanceof ModelEntity))
        return rt.constructorFunction;
    return undefined;
}

// NOTE: the ExpressionTree-building half of the token model (extractEntity / buildLite /
// ExpressionBox / BuildExpressionContext and every token's buildExpressionInternal) is EXTERNALIZED
// to logic/dynamicQuery/tokenExpressions.ts. It can't live here: it depends on logic/linq/expressions,
// and this module is the shared (client-runnable) token MODEL. tokenExpressions augments the classes
// below (prototypal augmentation) with buildExpression/buildExpressionInternal. This file therefore
// carries only metadata + sub-token GENERATION, which the client can run without a server round-trip.

// Faithful port of Signum's abstract `QueryToken` (DynamicQuery/Tokens/QueryToken.cs), scoped to
// Phase 2 (base + RootToken + EntityPropertyToken). Leaf/value-type/collection sub-token
// generators are Phase 3 — stubbed to [] and marked TODO below, so navigation through entity /
// embedded references works end to end now.
export abstract class QueryToken {
    priority = 0;

    abstract get key(): string;
    abstract toString(): string;
    abstract niceName(): string;
    abstract get type(): RuntimeType;
    abstract get format(): string | undefined;
    abstract get unit(): string | undefined;
    abstract get parent(): QueryToken | undefined;

    abstract getImplementations(): Implementations | undefined;
    abstract getPropertyRoute(): PropertyRoute | undefined;
    abstract isAllowed(): string | null;
    protected abstract subTokensOverride(options: SubTokensOptions): QueryToken[];

    get queryName(): QueryName {
        return this.parent!.queryName;
    }

    // Signum's GetElementImplementations: the implementations of a collection's element type
    // (this token's property route + "Item").
    getElementImplementations(): Implementations | undefined {
        const pr = this.getPropertyRoute();
        return pr != undefined ? pr.add("Item").tryGetImplementations() : undefined;
    }

    fullKey(): string {
        if (this.parent == undefined)
            return this.key;
        // The entity-root token has key "" (altea's rootless convention — no "Entity." prefix), so a
        // child of it is just its own key: navigations read "State", "Customer.Name", not ".State".
        const pk = this.parent.fullKey();
        return pk === "" ? this.key : pk + "." + this.key;
    }

    // Signum's QueryToken.IsEntity(): true only for the row's own "Entity" RootToken. Overridden
    // by RootToken; false for every other token.
    isEntity(): boolean {
        return false;
    }

    // A collection quantifier/element token (Element/AnyAll/Nested). Overridden by those tokens; used
    // by `dominates` to reset domination across a collection boundary (avoids the base importing the
    // subclasses — an import cycle).
    isCollectionToken(): boolean {
        return false;
    }

    // Signum's QueryToken.HasToArray(): the nearest CollectionToArrayToken ancestor (itself included),
    // or undefined. The DQueryable select layer uses it to string-aggregate a token's value over the
    // collection instead of navigating it plainly. Overridden by CollectionToArrayToken to return this.
    hasToArray(): CollectionToArrayToken | undefined {
        return this.parent?.hasToArray();
    }

    // Port of Signum's QueryToken.Dominates: `this` is a strict ancestor of `t` reached by pure
    // navigation — no collection token (Element/AnyAll/Nested) in between. Crossing a collection
    // multiplies rows, so a descendant there is NOT functionally determined by the ancestor and
    // domination stops. Used by GroupBy to drop redundant (determined) group keys.
    dominates(t: QueryToken): boolean {
        if (t.isCollectionToken())
            return false;
        if (t.parent == undefined)
            return false;
        return t.parent.equals(this) || this.dominates(t.parent);
    }

    // ---- Sub-token discovery + cache (Signum's CachedSubTokensOverride/SubTokenInternal/…) ----

    private subTokenCache = new Map<SubTokensOptions, Map<string, QueryToken>>();

    private cachedSubTokensOverride(options: SubTokensOptions): Map<string, QueryToken> {
        let m = this.subTokenCache.get(options);
        if (m == undefined) {
            m = new Map();
            for (const t of this.subTokensOverride(options))
                m.set(t.key, t);
            // Registered cross-entity expression tokens (Signum's QueryLogic.Expressions.
            // GetExtensionsTokens). The provider is wired by expressionContainer.ts; a normal member
            // never gets overridden (only added when absent).
            if (extensionTokensProvider != undefined)
                for (const t of extensionTokensProvider(this))
                    if (!m.has(t.key))
                        m.set(t.key, t);
            this.subTokenCache.set(options, m);
        }
        return m;
    }

    subToken(key: string, options: SubTokensOptions): QueryToken | undefined {
        const t = this.cachedSubTokensOverride(options).get(key);
        if (t == undefined)
            return undefined;
        const allowed = t.isAllowed();
        if (allowed != null)
            throw new Error(`Access to token '${this.fullKey()}.${key}' is not allowed: ${allowed}`);
        return t;
    }

    subTokens(options: SubTokensOptions): QueryToken[] {
        return [...this.cachedSubTokensOverride(options).values()]
            .filter(t => t.isAllowed() == null)
            .sort((a, b) => (b.priority - a.priority) || a.toString().localeCompare(b.toString()));
    }

    // ---- Property-route normalisation (Signum's NormalizePropertyRoute) ----------------------

    protected normalizePropertyRoute(): PropertyRoute | undefined {
        const modelCtor = this.type instanceof ClassType && this.type.constructorFunction.prototype instanceof ModelEntity
            ? this.type.constructorFunction : undefined;
        if (modelCtor != undefined)
            return PropertyRoute.root(modelCtor);

        // Only a Lite re-roots here; a full-entity reference re-roots inside PropertyRoute.add (AddImp).
        if (this.type instanceof LiteType) {
            const ec = entityCtorOf(this.type);
            if (ec != undefined)
                return PropertyRoute.root(ec);
        }
        return this.getPropertyRoute();
    }

    // ---- SubTokensBase — the type-driven sub-token generator (Signum's SubTokensBase) --------

    protected subTokensBase(type: RuntimeType, options: SubTokensOptions, implementations: Implementations | undefined): QueryToken[] {
        if (type === LiteralType.string)
            return this.andHasValue(this.stringTokens());

        // Integer buckets. TODO(phase3b+): StepTokens (the Step/Multiplier/Rounding chain).
        // altea's RuntimeType collapses int/decimal to number, so modulo is offered for all numbers.
        if (type === LiteralType.number)
            return this.andHasValue(this.andModuloTokens([]));

        if (type instanceof TemporalType) {
            if (type.kind === "dateTime")
                return this.andHasValue(this.dateTimeProperties());
            if (type.kind === "date")
                return this.andHasValue(this.dateOnlyProperties());
            return this.andHasValue([]); // duration TODO(phase3b+): TimeSpanProperties
        }

        if (type === LiteralType.boolean || type instanceof EnumType)
            return this.andHasValue([]);

        const ct = cleanType(type);
        const entityCtor = entityCtorOf(ct);
        if (entityCtor != undefined) {
            const imp = implementations;
            if (imp == undefined)
                return [];
            if (imp.isByAll) {
                // @implementedByAll: one AsTypeToken per mapped entity type assignable to `entityCtor`
                // (Signum's QueryLogic.GetImplementedByAllSubTokens). The provider is wired by
                // queryLogic.ts (needs the Schema). TODO(phase3c): PreAnd(EntityTypeToken).
                const provider = implementedByAllTypesProvider;
                return provider == undefined ? [] : provider(entityCtor).map(t => tokenFactories!.asType(this, t));
            }

            const only = imp.only();
            if (only != undefined && only === entityCtor) {
                // Single concrete implementation: id + ToString + the entity's own properties.
                // TODO(phase3b/4): EntityType/PartitionId, system-time, operations, manual.
                return this.andHasValue([
                    this.idPropertyToken(),
                    tokenFactories!.entityToString(this),
                    ...this.entityProperties(entityCtor),
                ]);
            }

            // Polymorphic (implementedBy many): one AsTypeToken per implementation.
            // TODO(phase3c): PreAnd(EntityTypeToken) — the "[EntityType]" sub-token.
            return imp.types.map(t => tokenFactories!.asType(this, t));
        }

        const embeddedCtor = embeddedOrModelCtorOf(type);
        if (embeddedCtor != undefined)
            return this.andHasValue(this.entityProperties(embeddedCtor));

        if (type instanceof ArrayType)
            return this.collectionProperties(options);

        return [];
    }

    // Signum's CollectionProperties: the sub-tokens of a collection. Count + one CollectionElement
    // token per CollectionElementType (Element/Element2/Element3, gated by CanElement).
    // TODO(phase3d+): CanNested/CanAnyAll/CanToArray + MListElementPropertyToken (RowId/RowOrder).
    protected collectionProperties(options: SubTokensOptions): QueryToken[] {
        const tokens: QueryToken[] = [tokenFactories!.count(this)];
        if (options & SubTokensOptions.CanElement)
            for (const et of ["Element", "Element2", "Element3"])
                tokens.push(tokenFactories!.collectionElement(this, et));
        if (options & SubTokensOptions.CanAnyAll)
            for (const aa of ["Any", "All", "NotAny", "NotAll"])
                tokens.push(tokenFactories!.collectionAnyAll(this, aa));
        if (options & SubTokensOptions.CanToArray)
            for (const ta of ["SeparatedByComma", "SeparatedByCommaDistinct", "SeparatedByNewLine", "SeparatedByNewLineDistinct"])
                tokens.push(tokenFactories!.collectionToArray(this, ta));
        return tokens;
    }

    // Signum's list.AndHasValue(this): every value/entity list gets a trailing HasValue token.
    protected andHasValue(list: QueryToken[]): QueryToken[] {
        list.push(tokenFactories!.hasValue(this));
        return list;
    }

    // Signum's StringTokens(): the string `Length` sub-token. (FullText/Snippet/Translated TODO.)
    protected stringTokens(): QueryToken[] {
        return [tokenFactories!.objectProperty(this, "length", LiteralType.number, "Length", false)];
    }

    // Signum's AndModuloTokens: integer bucket sub-tokens.
    protected andModuloTokens(list: QueryToken[]): QueryToken[] {
        for (const d of [10, 100, 1000, 10000])
            list.push(tokenFactories!.modulo(this, d));
        return list;
    }

    // Signum's DateTimeProperties: the date/time part sub-tokens. Members are altea's binder names
    // (quarter is a method; weekNumber is unsupported by the binder → skipped, as are the
    // DatePartStart "Month/Quarter/… Start" and TimeOfDay tokens — Phase 3b+).
    protected dateTimeProperties(): QueryToken[] {
        const part = (name: string, method = false) =>
            tokenFactories!.objectProperty(this, name, LiteralType.number, capitalize(name), method);
        return [
            part("year"), part("quarter", true), part("month"),
            part("dayOfYear"), part("day"), part("dayOfWeek"),
            part("hour"), part("minute"), part("second"), part("millisecond"),
            tokenFactories!.dateToken(this),
        ];
    }

    // Signum's DateOnlyProperties: the date (no time) part sub-tokens.
    protected dateOnlyProperties(): QueryToken[] {
        const part = (name: string, method = false) =>
            tokenFactories!.objectProperty(this, name, LiteralType.number, capitalize(name), method);
        return [part("year"), part("quarter", true), part("month"), part("dayOfYear"), part("day"), part("dayOfWeek")];
    }

    // Signum's EntityProperties: one EntityPropertyToken per queryable field of `type` (mixins
    // TODO). `id`/`ticks` and pure bookkeeping fields (noSerialize) are excluded; `id` is added
    // separately by subTokensBase (idPropertyToken).
    protected entityProperties(type: Function): QueryToken[] {
        const base = this.normalizePropertyRoute();
        const ti = tryGetTypeInfo(type);
        if (ti == undefined || base == undefined)
            return [];
        const out: QueryToken[] = [];
        for (const fi of Object.values(ti.fields)) {
            if (fi.noSerialize || fi.name === "id" || fi.name === "ticks")
                continue;
            out.push(tokenFactories!.entityProperty(this, fi, base.add(fi.name)));
        }
        return out;
    }

    protected idPropertyToken(): QueryToken {
        return tokenFactories!.idProperty(this);
    }

    // ---- Classification (Signum's IsGroupable / FilterType / NiceTypeName) -----------------------
    // (Signum's client "queryTokenType" string discriminator is not needed: altea's client has the
    // real token subclasses, so callers categorize with `instanceof` — see react/QueryToken.)

    // Signum's QueryToken.FilterType — the value category, refined by the field's declared typeName
    // (the Integer-vs-Decimal split that the plain RuntimeType loses).
    get filterType(): FilterType | undefined {
        return tryGetFilterTypeFromTypeName(this.getPropertyRoute()?.fieldInfo?.typeName, this.type);
    }

    get isGroupable(): boolean {
        switch (tryGetFilterType(this.type)) {
            case "Boolean":
            case "Enum":
            case "Guid":
            case "Integer":
            case "Lite":
            case "String":
                return true;
            // TODO(phase3): DateTime is groupable only at Days precision (DateOnly / validator).
            default:
                return false;
        }
    }

    // Signum's QueryToken.NiceTypeName — a human label for the token's value type (used by the
    // client's token tree). A collection reads "List of <element>".
    niceTypeName(): string {
        const t = this.type;
        if (t instanceof ArrayType)
            return QueryTokenMessage.ListOf0.niceToString(niceTypeNameOf(t.elementType!, undefined, undefined));
        return niceTypeNameOf(t, this.filterType, this.getImplementations());
    }

    // ---- Equality (Signum's Equals/GetHashCode over FullKey + QueryName) ----------------------

    equals(other: QueryToken): boolean {
        return other.constructor === this.constructor
            && other.fullKey() === this.fullKey()
            && getQueryKey(other.queryName) === getQueryKey(this.queryName);
    }

    hashKey(): string {
        return this.fullKey() + "|" + getQueryKey(this.queryName);
    }
}

function getQueryKey(queryName: QueryName): string {
    return typeof queryName === "function" ? queryName.name : String(queryName);
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// Port of Signum's getNiceTypeName, over an altea RuntimeType: a human label for a value type. The
// Signum server-token special result types (CellOperationDTO / OperationsContainerToken / …) are not
// modelled in altea, so those special cases are omitted.
function niceTypeNameOf(type: RuntimeType, filterType: FilterType | undefined, implementations: Implementations | undefined): string {
    filterType ??= tryGetFilterType(type);
    switch (filterType) {
        case "Integer": return QueryTokenMessage.Number.niceToString();
        case "Decimal": return QueryTokenMessage.DecimalNumber.niceToString();
        case "String": return QueryTokenMessage.Text.niceToString();
        case "Time": return QueryTokenDateMessage.TimeOfDay.niceToString();
        case "DateTime":
            return type instanceof TemporalType && type.kind === "date"
                ? QueryTokenDateMessage.Date.niceToString()
                : QueryTokenMessage.DateTime.niceToString();
        case "Boolean": return QueryTokenMessage.Check.niceToString();
        case "Guid": return QueryTokenMessage.GlobalUniqueIdentifier.niceToString();
        case "Enum": return type instanceof EnumType ? type.enumName : ""; // TODO: localized enum type name
        case "Lite": {
            const impl = implementations ?? implementationsOf(type);
            if (impl == undefined || impl.isByAll)
                return QueryTokenMessage.AnyEntity.niceToString();
            return impl.types.map(t => niceName(t)).joinComma(CollectionMessage.Or.niceToString());
        }
        case "Embedded":
        case "Model": {
            const ct = cleanType(type);
            return ct instanceof ClassType ? niceName(ct.constructorFunction) : "";
        }
        default:
            return "";
    }
}

// The implementations implied by a reference type alone (for the collection-element recursion, which
// has no token to ask). A single concrete entity ctor; undefined for non-references.
function implementationsOf(type: RuntimeType): Implementations | undefined {
    const ec = entityCtorOf(cleanType(type));
    return ec != undefined ? Implementations.by(ec) : undefined;
}

// Factory hook (Signum builds these directly; altea injects them to break the static import cycle
// — every concrete token extends QueryToken, so the base can't import them). `tokens/factories.ts`
// imports all concrete tokens and registers them; consumers import that module (or the barrel).
export interface TokenFactories {
    entityProperty(parent: QueryToken, fieldInfo: FieldInfo, route: PropertyRoute): QueryToken;
    idProperty(parent: QueryToken): QueryToken;
    entityToString(parent: QueryToken): QueryToken;
    hasValue(parent: QueryToken): QueryToken;
    objectProperty(parent: QueryToken, memberName: string, resultType: RuntimeType, displayName: string, isMethod: boolean, format?: string, unit?: string): QueryToken;
    asType(parent: QueryToken, entityCtor: Function): QueryToken;
    dateToken(parent: QueryToken): QueryToken;
    modulo(parent: QueryToken, divisor: number): QueryToken;
    count(parent: QueryToken): QueryToken;
    collectionElement(parent: QueryToken, elementType: string): QueryToken;
    collectionAnyAll(parent: QueryToken, anyAllType: string): QueryToken;
    collectionToArray(parent: QueryToken, toArrayType: string): QueryToken;
}
let tokenFactories: TokenFactories | undefined;
export function registerTokenFactories(f: TokenFactories): void {
    tokenFactories = f;
}

// The source of implementations for an @implementedByAll reference: all mapped entity types
// assignable to the given clean type (Signum's QueryLogic.GetImplementedByAllSubTokens type set).
// Wired by queryLogic.ts (needs the Schema, so it can't live in the base). Unset ⇒ byAll yields no
// sub-tokens.
let implementedByAllTypesProvider: ((cleanTypeCtor: Function) => Function[]) | undefined;
export function setImplementedByAllTypesProvider(fn: (cleanTypeCtor: Function) => Function[]): void {
    implementedByAllTypesProvider = fn;
}

// Registered-expression sub-tokens (Signum's QueryLogic.Expressions.GetExtensionsTokens). Wired by
// expressionContainer.ts; unset ⇒ no extension tokens.
let extensionTokensProvider: ((parent: QueryToken) => QueryToken[]) | undefined;
export function setExtensionTokensProvider(fn: (parent: QueryToken) => QueryToken[]): void {
    extensionTokensProvider = fn;
}

// The ASYNC source of the sub-tokens a caller can't compute from local metadata alone (extensions,
// and later manual / operations). This is the divergent extension point: on the SERVER it is unset —
// `subTokens` already merges the sync `extensionTokensProvider` off the local registration table — so
// `getSubTokens` is purely local; on the CLIENT it is wired to a cached ajax request that fetches the
// server-only tokens and rebuilds them as entities instances (via tokenSerializer.deserializeServerToken).
let serverTokensProvider: ((token: QueryToken, options: SubTokensOptions) => Promise<QueryToken[]>) | undefined;
export function setServerTokensProvider(fn: ((token: QueryToken, options: SubTokensOptions) => Promise<QueryToken[]>) | undefined): void {
    serverTokensProvider = fn;
}

// The public, side-agnostic way to expand a token's sub-tokens: the locally-generated metadata
// tokens, plus (when a server-token source is wired) the fetched server-only tokens. A local member
// wins over a server token of the same key (Signum: extensions never override normal members). The
// merged set is re-sorted like `subTokens` (priority desc, then display name).
export async function getSubTokens(token: QueryToken, options: SubTokensOptions): Promise<QueryToken[]> {
    const local = token.subTokens(options);
    if (serverTokensProvider == undefined)
        return local;
    const server = await serverTokensProvider(token, options);
    const seen = new Set(local.map(t => t.key));
    const merged = [...local, ...server.filter(t => !seen.has(t.key))];
    return merged.sort((a, b) => (b.priority - a.priority) || a.toString().localeCompare(b.toString()));
}
