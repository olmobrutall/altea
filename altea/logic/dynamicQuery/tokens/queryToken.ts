import { Entity, EmbeddedEntity, ModelEntity } from "../../../entities/entity";
import { PropertyRoute } from "../../../entities/propertyRoute";
import { tryGetTypeInfo, type FieldInfo } from "../../../entities/reflection";
import { Implementations } from "../../../entities/implementations";
import {
    RuntimeType, ClassType, LiteType, ArrayType, EnumType, TemporalType, LiteralType,
} from "../../../entities/runtimeTypes";
import {
    Expression, ParameterExpression, PropertyExpression, CallExpression,
} from "../../linq/expressions";
import { FilterType, tryGetFilterType, type QueryName } from "../queryUtils";

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

// ---- Expression helpers — the BuildExpression retarget onto altea's model -------------------
// Ports of Signum's ExtractEntity / BuildLiteNullifyUnwrapPrimaryKey (QueryUtils.cs). They emit
// altea `Expression` nodes the Phase-D binder already understands (`.entity`, `.toLite`).

// Signum's `ExtractEntity`: yield the entity behind a reference expression. A `toLite(x)` call is
// unwrapped straight back to `x` (so navigation through a reference column stays clean, no
// `toLite().entity` round-trip); a plain Lite value dereferences via `.entity`; a full entity is
// returned as-is. `late` (id / toString) is a no-op — the binder late-binds `.id`/`.toString`
// over either a lite or an entity.
export function extractEntity(expr: Expression, late = false): Expression {
    if (isToLiteCall(expr))
        return expr.func.object;
    if (!late && expr.type instanceof LiteType)
        return new PropertyExpression(expr, "entity");
    return expr;
}

function isToLiteCall(expr: Expression): expr is CallExpression & { func: PropertyExpression } {
    return expr instanceof CallExpression && expr.func instanceof PropertyExpression && expr.func.propertyName === "toLite";
}

// Signum's `BuildLiteNullifyUnwrapPrimaryKey`: a full-entity reference projects as a `Lite<T>`
// (altea's decision that queries return the typed lite). A value / already-lite / embedded
// expression is returned unchanged.
export function buildLite(expr: Expression): Expression {
    const t = expr.type;
    if (t instanceof ClassType && isEntityCtor(t.constructorFunction))
        return new CallExpression(new PropertyExpression(expr, "toLite"), [], new LiteType(t));
    return expr;
}

// ---- BuildExpressionContext / ExpressionBox (Signum's, in QueryToken.cs) --------------------

// One replacement entry: the raw altea expression a token resolves to. (Signum's MListElementRoute
// / SubQueryContext / AlreadyHidden are not modelled yet — no MList, no auth-hiding.)
export class ExpressionBox {
    constructor(public readonly rawExpression: Expression) { }
    getExpression(): Expression { return this.rawExpression; }
}

// The context threaded through BuildExpression: the row parameter plus the map of already-known
// token expressions (seeded from the query's projected columns). Keyed by `token.fullKey()` — a
// string key gives value equality where JS Map object-identity would not.
export class BuildExpressionContext {
    constructor(
        public readonly elementType: RuntimeType,
        public readonly parameter: ParameterExpression,
        public readonly replacements: Map<string, ExpressionBox>,
    ) { }
}

// Faithful port of Signum's abstract `QueryToken` (DynamicQuery/Tokens/QueryToken.cs), scoped to
// Phase 2 (base + ColumnToken + EntityPropertyToken). Leaf/value-type/collection sub-token
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
    protected abstract buildExpressionInternal(context: BuildExpressionContext): Expression;
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

    // Signum's QueryToken.BuildExpression: resolve from the seeded replacements (a projected
    // column), else recurse into buildExpressionInternal. (Auth value-hiding is not modelled.)
    buildExpression(context: BuildExpressionContext): Expression {
        const box = context.replacements.get(this.fullKey());
        if (box != undefined)
            return box.getExpression();
        return this.buildExpressionInternal(context);
    }

    fullKey(): string {
        return this.parent == undefined ? this.key : this.parent.fullKey() + "." + this.key;
    }

    // Signum's QueryToken.IsEntity(): true only for the row's own "Entity" ColumnToken. Overridden
    // by ColumnToken; false for every other token.
    isEntity(): boolean {
        return false;
    }

    // ---- Sub-token discovery + cache (Signum's CachedSubTokensOverride/SubTokenInternal/…) ----

    private subTokenCache = new Map<SubTokensOptions, Map<string, QueryToken>>();

    private cachedSubTokensOverride(options: SubTokensOptions): Map<string, QueryToken> {
        let m = this.subTokenCache.get(options);
        if (m == undefined) {
            m = new Map();
            for (const t of this.subTokensOverride(options))
                m.set(t.key, t);
            // TODO(phase4): merge QueryLogic.Expressions extension tokens here.
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
        return tokens;
    }

    // Signum's list.AndHasValue(this): every value/entity list gets a trailing HasValue token.
    protected andHasValue(list: QueryToken[]): QueryToken[] {
        list.push(tokenFactories!.hasValue(this));
        return list;
    }

    // Signum's StringTokens(): the string `Length` sub-token. (FullText/Snippet/Translated TODO.)
    protected stringTokens(): QueryToken[] {
        return [tokenFactories!.netProperty(this, "length", LiteralType.number, "Length", false)];
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
            tokenFactories!.netProperty(this, name, LiteralType.number, capitalize(name), method);
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
            tokenFactories!.netProperty(this, name, LiteralType.number, capitalize(name), method);
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

    // ---- Classification (Signum's IsGroupable / NiceTypeName) --------------------------------

    get isGroupable(): boolean {
        switch (tryGetFilterType(this.type)) {
            case FilterType.Boolean:
            case FilterType.Enum:
            case FilterType.Guid:
            case FilterType.Integer:
            case FilterType.Lite:
            case FilterType.String:
                return true;
            // TODO(phase3): DateTime is groupable only at Days precision (DateOnly / validator).
            default:
                return false;
        }
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

// Factory hook (Signum builds these directly; altea injects them to break the static import cycle
// — every concrete token extends QueryToken, so the base can't import them). `tokens/factories.ts`
// imports all concrete tokens and registers them; consumers import that module (or the barrel).
export interface TokenFactories {
    entityProperty(parent: QueryToken, fieldInfo: FieldInfo, route: PropertyRoute): QueryToken;
    idProperty(parent: QueryToken): QueryToken;
    entityToString(parent: QueryToken): QueryToken;
    hasValue(parent: QueryToken): QueryToken;
    netProperty(parent: QueryToken, memberName: string, resultType: RuntimeType, displayName: string, isMethod: boolean, format?: string, unit?: string): QueryToken;
    asType(parent: QueryToken, entityCtor: Function): QueryToken;
    dateToken(parent: QueryToken): QueryToken;
    modulo(parent: QueryToken, divisor: number): QueryToken;
    count(parent: QueryToken): QueryToken;
    collectionElement(parent: QueryToken, elementType: string): QueryToken;
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
