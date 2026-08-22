import { Entity, EmbeddedEntity, ModelEntity } from "../../entity";
import { PropertyRoute } from "../../propertyRoute";
import { tryGetTypeInfo, TypeReference, type FieldInfo } from "../../reflection";
import { Implementations } from "../../implementations";
import { tryGetFilterType, type QueryName, type FilterType } from "../queryUtils";
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

// ---- TypeReference helpers (Signum's Type.CleanType()/IsIEntity()) --------------------------

// Value-type TypeReference singletons for computed tokens (Signum's LiteralType.number etc.). Count /
// date-parts / string length are integers (subTypeName "int" — the Integer-vs-Decimal accuracy that
// the old RuntimeType.number lost).
export const TR_INT = new TypeReference({ typeName: "Number", subTypeName: "int" });
export const TR_STRING = new TypeReference({ typeName: "String" });
export const TR_BOOLEAN = new TypeReference({ typeName: "Boolean" });
export const TR_DATE = new TypeReference({ typeName: "PlainDate" });

// The concrete entity ctor a reference type points to — `is`/`getFunction` are lite-agnostic, so no
// CleanType() unwrap is needed. undefined for value / embedded / enum / name-only-interface references.
export function entityCtorOf(tr: TypeReference): Function | undefined {
    return tr.is(Entity) ? tr.getFunction() : undefined;
}
function embeddedOrModelCtorOf(tr: TypeReference): Function | undefined {
    return (tr.is(EmbeddedEntity) || tr.is(ModelEntity)) ? tr.getFunction() : undefined;
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
    // Signum's QueryToken.preferEquals: a token (id / lite / enum) that should default to the EqualTo
    // operation when first selected in a filter. TODO(port): set true for id/lite/enum tokens; false
    // (the base default) keeps FilterBuilder falling back to getFilterOperations().first().
    preferEquals = false;

    abstract get key(): string;
    abstract toString(): string;
    abstract niceName(): string;
    abstract get type(): TypeReference;
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
            // Signum's SubTokens prepends AggregateTokens when CanAggregate is set (group aggregates:
            // the root's Count, and each value token's Sum/Avg/Min/Max/Count variants). Priority 10 sorts
            // them first; a real member of the same key still wins (added after, overriding the entry).
            if (options & SubTokensOptions.CanAggregate)
                for (const t of this.aggregateTokens())
                    m.set(t.key, t);
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
        const modelCtor = this.type.is(ModelEntity) ? this.type.getFunction() : undefined;
        if (modelCtor != undefined)
            return PropertyRoute.root(modelCtor);

        // Only a Lite re-roots here; a full-entity reference re-roots inside PropertyRoute.add (AddImp).
        if (this.type.lite) {
            const ec = entityCtorOf(this.type);
            if (ec != undefined)
                return PropertyRoute.root(ec);
        }

        const own = this.getPropertyRoute();
        if (own != undefined)
            return own;

        // A token with NO route of its own that nonetheless yields an ENTITY — a registered EXPRESSION
        // returning one (`previousOperationLog`, altea-workflow's `lastCaseActivity`, …). Its route is
        // derived from the expression's Meta, which is empty when the body is a whole sub-query rather
        // than a source column, so without this the token would expose only `id` / `ToString` and every
        // member below it would fail to resolve. The referenced entity IS the root from here on.
        const entityCtor = entityCtorOf(this.type);
        return entityCtor != undefined ? PropertyRoute.root(entityCtor) : undefined;
    }

    // ---- SubTokensBase — the type-driven sub-token generator (Signum's SubTokensBase) --------

    protected subTokensBase(type: TypeReference, options: SubTokensOptions, implementations: Implementations | undefined): QueryToken[] {
        // Collection first: an array TypeReference also carries an entity/value element type, so it
        // must be matched before the element-type checks below.
        if (type.array)
            return this.collectionProperties(options);

        if (type.typeName === "String")
            return this.andHasValue(this.stringTokens());

        // Integer buckets. TODO(phase3b+): StepTokens (the Step/Multiplier/Rounding chain).
        if (type.typeName === "Number" || type.typeName === "Decimal")
            return this.andHasValue(this.andModuloTokens([]));

        if (type.typeName === "PlainDateTime")
            return this.andHasValue(this.dateTimeProperties());
        if (type.typeName === "PlainDate")
            return this.andHasValue(this.dateOnlyProperties());
        if (type.typeName === "Duration" || type.typeName === "PlainTime")
            return this.andHasValue([]); // TODO(phase3b+): TimeSpanProperties

        if (type.typeName === "Boolean" || type.getEnum() != undefined)
            return this.andHasValue([]);

        // Entity reference — is(Entity) also holds for a polymorphic @implementedBy interface (which
        // has no single ctor, so getFunction() is undefined; it takes the implementedBy-many path).
        if (type.is(Entity)) {
            const entityCtor = type.getFunction();
            const imp = implementations;
            if (imp == undefined)
                return [];
            if (imp.isByAll) {
                // @implementedByAll: one AsTypeToken per mapped entity type assignable to `entityCtor`
                // (Signum's QueryLogic.GetImplementedByAllSubTokens). The provider is wired by
                // queryLogic.ts (needs the Schema). TODO(phase3c): PreAnd(EntityTypeToken).
                const provider = implementedByAllTypesProvider;
                return provider == undefined || entityCtor == undefined ? [] : provider(entityCtor).map(t => tokenFactories!.asType(this, t));
            }

            const only = imp.only();
            if (only != undefined && only === entityCtor) {
                // Single concrete implementation: id + ToString + (when CanManual) the [QuickLinks]
                // manual container + the entity's own properties. Signum adds QuickLinksToken here
                // (QueryToken.cs SubTokensBase, gated by CanManual), before EntityProperties.
                // TODO(phase3b/4): EntityType/PartitionId, system-time, operations container.
                return this.andHasValue([
                    this.idPropertyToken(),
                    tokenFactories!.entityToString(this),
                    ...(options & SubTokensOptions.CanManual ? [tokenFactories!.quickLinksContainer(this)] : []),
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

    // Signum's QueryUtils.AggregateTokens: the group-aggregate sub-tokens exposed when
    // SubTokensOptions.CanAggregate is set. On the query root (no parent) it's the group row Count; on a
    // value/reference token it's the numeric/date Sum/Avg/Min/Max plus the Count-null / Count-distinct
    // variants. An aggregate token exposes none (Signum's `!(token is AggregateToken)`). Prepended by
    // cachedSubTokensOverride, mirroring Signum's SubTokens inserting these at the front.
    protected aggregateTokens(): QueryToken[] {
        if (this.isAggregate())
            return [];
        // token == null in Signum ⇒ the query root: the group's row Count (queryName-anchored, no parent).
        if (this.parent == undefined)
            return [tokenFactories!.aggregate("Count", undefined, { queryName: this.queryName })];

        const result: QueryToken[] = [];
        const ft = this.filterType;
        if (ft === "Integer" || ft === "Decimal" || ft === "Boolean") {
            result.push(tokenFactories!.aggregate("Average", this));
            result.push(tokenFactories!.aggregate("Sum", this));
            result.push(tokenFactories!.aggregate("Min", this));
            result.push(tokenFactories!.aggregate("Max", this));
        }
        else if (ft === "DateTime" || ft === "Time") {
            result.push(tokenFactories!.aggregate("Min", this));
            result.push(tokenFactories!.aggregate("Max", this));
        }
        if (ft != undefined) {
            result.push(tokenFactories!.aggregate("Count", this, { filterOperation: "DistinctTo", value: null }));
            result.push(tokenFactories!.aggregate("Count", this, { filterOperation: "EqualTo", value: null }));
        }
        if (this.isGroupable)
            result.push(tokenFactories!.aggregate("Count", this, { distinct: true }));
        if (ft === "Boolean") {
            result.push(tokenFactories!.aggregate("Count", this, { filterOperation: "EqualTo", value: true }));
            result.push(tokenFactories!.aggregate("Count", this, { filterOperation: "EqualTo", value: false }));
        }
        // TODO(port): FilterType.Enum per-value Count EqualTo/DistinctTo — Signum iterates Enum.GetValues;
        // altea's enums are string-union + numeric XEnum, so this needs the enum's member set (deferred).
        return result;
    }

    // Signum's list.AndHasValue(this): every value/entity list gets a trailing HasValue token.
    protected andHasValue(list: QueryToken[]): QueryToken[] {
        list.push(tokenFactories!.hasValue(this));
        return list;
    }

    // Signum's StringTokens(): the string `Length` sub-token. (FullText/Snippet/Translated TODO.)
    protected stringTokens(): QueryToken[] {
        return [tokenFactories!.objectProperty(this, "length", TR_INT, "Length", false)];
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
            tokenFactories!.objectProperty(this, name, TR_INT, capitalize(name), method);
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
            tokenFactories!.objectProperty(this, name, TR_INT, capitalize(name), method);
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

    // Signum's QueryToken.FilterType — the value category. The TypeReference carries typeName +
    // subTypeName, so tryGetFilterType alone recovers the Integer-vs-Decimal split (no separate
    // fromTypeName pass needed).
    get filterType(): FilterType | undefined {
        return tryGetFilterType(this.type);
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
        if (t.array)
            return QueryTokenMessage.ListOf0.niceToString(niceTypeNameOf(t.elementType!, undefined, undefined));
        return niceTypeNameOf(t, this.filterType, this.getImplementations());
    }

    // ---- Token-category predicates (Signum's client `queryTokenType` string discriminator) --------
    // altea has no discriminator string: the base returns false and the collection/aggregate token
    // SUBCLASSES override their own to true (no `instanceof` in the base → no base→subclass cycle).
    // The `has*` walkers climb the parent chain. Exposed as instance methods (were react/QueryToken
    // free functions). `hasToArray()` is defined above (returns the ancestor token, not a boolean).
    isAggregate(): boolean { return false; }
    isAnyOrAll(): boolean { return false; }
    isElement(): boolean { return false; }
    isToArray(): boolean { return false; }

    // altea divergence (NOT in Signum): a token navigating a @backReference field — the child-side FK
    // that points back to the entity owning the collection. Overridden by EntityPropertyToken; the base
    // returns false. Used by `dimAsBackNavigation` (below) to grey the token in the token-tree picker.
    isBackReferenceToken(): boolean { return false; }

    // altea divergence (NOT in Signum): the token-tree picker dims a @backReference (opacity 50%) WHEN it
    // sits under a collection operator (Element / Any / All / ToArray). A @part row is always reached via
    // its owner's collection and its @backReference points straight back to that owner — so under a
    // collection operator the navigation is circular ("back where you came from") and gets a de-emphasis
    // hint. Reached WITHOUT a collection ancestor (a direct query on the part, or a scalar reference) it is
    // a normal forward navigation and stays full-opacity. NB: for a @backReference the nearest collection
    // ancestor's owner IS the back-ref target, so "has a collection-operator ancestor" is exact — no
    // target-type comparison is needed.
    get dimAsBackNavigation(): boolean {
        if (!this.isBackReferenceToken())
            return false;
        for (let p = this.parent; p != undefined; p = p.parent)
            if (p.isElement() || p.isAnyOrAll() || p.isToArray())
                return true;
        return false;
    }

    // Not-yet-ported exotic token kinds (Operation/Manual/Nested/TimeSeries/Snippet) — always false.
    hasOperation(): boolean { return false; }
    hasManual(): boolean { return false; }
    hasNested(): boolean { return false; }
    hasTimeSeries(): boolean { return false; }
    hasSnippet(): boolean { return false; }

    hasAnyOrAll(recursive: boolean = true): boolean {
        return this.isAnyOrAll() || (recursive && (this.parent?.hasAnyOrAll() ?? false));
    }
    hasAny(): boolean { return this.parent?.hasAny() ?? false; }
    hasAggregate(): boolean { return this.isAggregate(); }
    hasElement(): boolean { return this.isElement() || (this.parent?.hasElement() ?? false); }

    // ---- Auto-expand (Signum's QueryToken.AutoExpand / AutoExpandInternal / HideInAutoExpand) --------
    // When the token-tree picker expands a token's sub-tokens with auto-expand ON, an autoExpand token's
    // OWN sub-tokens are pulled inline (flattened) into the same dropdown — so an embedded / collection /
    // polymorphic reference doesn't need an extra click to reach its members. `hideInAutoExpand` tokens
    // (Count, HasValue, Any/All, ToArray, Element2/3, …) are omitted from that flattened list unless the
    // user drilled DIRECTLY into their parent. Consumed by the client TokenCompleter.getSubTokens.
    private _autoExpand: boolean | undefined;
    get autoExpand(): boolean {
        return this._autoExpand ??= this.calculateAutoExpand();
    }

    get hideInAutoExpand(): boolean { return false; }

    // Signum's CalculateAutoExpand: guard against a self-referential type expanding forever — walk the
    // auto-expanded ancestor chain and stop if a same-typed ancestor is already present.
    private calculateAutoExpand(): boolean {
        if (!this.autoExpandInternal)
            return false;
        for (let p = this.parent; p != undefined; p = p.parent) {
            if (!p.autoExpand)
                break;
            if (sameRuntimeType(p.type, this.type))
                return false;
        }
        return true;
    }

    // Signum's AutoExpandInternal. altea divergences: (1) the AutoExpandSubTokensAttribute override is
    // not ported (no such decorator yet); (2) Signum's `t.IsMList()` becomes `t.array` — altea models a
    // collection as a plain array (Signum's MList<T>), so any collection auto-expands. Embedded refs and
    // polymorphic (multi-implementation) entity refs also auto-expand; a mono-typed entity/lite ref does
    // not (its members are one click away and expanding every FK would flood the dropdown).
    protected get autoExpandInternal(): boolean {
        const t = this.type;
        if (t.is(EmbeddedEntity))
            return true;
        if (t.array)
            return true;
        if (t.is(Entity) || t.lite) {
            const imp = this.getImplementations();
            if (imp == undefined || imp.isByAll)
                return false;
            return imp.types.length != 1;
        }
        return false;
    }

    // Signum's getQueryTokenColor — a CSS custom-property colour for the token-tree picker, keyed by
    // its category (keyword for aggregate/collection-nav tokens, then collection/entity-root/filterType).
    get queryTokenColor(): string {
        if (this.isAggregate() || this.isAnyOrAll() || this.isElement() || this.isToArray())
            return "var(--qt-keyword)";
        if (this.type.array)
            return "var(--qt-collection)";
        if (this.parent == undefined)
            return "var(--qt-main-entity)";
        switch (this.filterType) {
            case "Integer":
            case "Decimal":
            case "String":
            case "Guid":
            case "Boolean": return "var(--qt-value)";
            case "DateTime": return "var(--qt-date)";
            case "Time": return "var(--qt-time)";
            case "Enum": return "var(--qt-enum)";
            case "Lite": return "var(--qt-lite)";
            case "Embedded": return "var(--qt-embedded)";
            default: return "var(--qt-exotic)";
        }
    }

    // The ancestor chain from the ROOT down to (and including) this token — Signum's free
    // `getTokenParents`. Root-first so `[0]` is the query root and the last is `this`.
    getTokenParents(): QueryToken[] {
        const result: QueryToken[] = [];
        let token: QueryToken | undefined = this;
        while (token) {
            result.unshift(token);
            token = token.parent;
        }
        return result;
    }

    // Whether THIS token is a prefix of `token` (same token, or `token`'s fullKey starts with
    // `this.fullKey() + "."`). Signum's free `isPrefix(prefix, token)` with `this` as the prefix.
    isPrefixOf(token: QueryToken): boolean {
        return this.fullKey() == token.fullKey() || token.fullKey().startsWith(this.fullKey() + ".");
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
function niceTypeNameOf(type: TypeReference, filterType: FilterType | undefined, implementations: Implementations | undefined): string {
    filterType ??= tryGetFilterType(type);
    switch (filterType) {
        case "Integer": return QueryTokenMessage.Number.niceToString();
        case "Decimal": return QueryTokenMessage.DecimalNumber.niceToString();
        case "String": return QueryTokenMessage.Text.niceToString();
        case "Time": return QueryTokenDateMessage.TimeOfDay.niceToString();
        case "DateTime":
            return type.typeName === "PlainDate"
                ? QueryTokenDateMessage.Date.niceToString()
                : QueryTokenMessage.DateTime.niceToString();
        case "Boolean": return QueryTokenMessage.Check.niceToString();
        case "Guid": return QueryTokenMessage.GlobalUniqueIdentifier.niceToString();
        case "Enum": return type.getTypeName() ?? ""; // TODO: localized enum type name
        case "Lite": {
            const impl = implementations ?? implementationsOf(type);
            if (impl == undefined || impl.isByAll)
                return QueryTokenMessage.AnyEntity.niceToString();
            return impl.types.map(t => t.niceName()).joinComma(CollectionMessage.Or.niceToString());
        }
        case "Embedded":
        case "Model": {
            const ctor = type.getFunction();
            return ctor != undefined ? ctor.niceName() : "";
        }
        default:
            return "";
    }
}

// The implementations implied by a reference type alone (for the collection-element recursion, which
// has no token to ask) — the @implementedBy list, else a single concrete entity ctor; undefined for
// non-references. Reuses Implementations.tryFromFieldInfo (which reads a TypeReference's facets).
function implementationsOf(type: TypeReference): Implementations | undefined {
    return Implementations.tryFromFieldInfo(type);
}

// Runtime-type equality for the auto-expand recursion guard (Signum's `p.Type == this.Type`): compare by
// resolved ctor when either side is a class reference, else by value type name; array / lite facets must
// match too so a collection and its element (or a lite and its entity) aren't treated as the same type.
function sameRuntimeType(a: TypeReference, b: TypeReference): boolean {
    const fa = a.getFunction(), fb = b.getFunction();
    if (fa != undefined || fb != undefined)
        return fa === fb && !!a.array === !!b.array && !!a.lite === !!b.lite;
    return a.typeName === b.typeName && !!a.array === !!b.array;
}

// Factory hook (Signum builds these directly; altea injects them to break the static import cycle
// — every concrete token extends QueryToken, so the base can't import them). `tokens/factories.ts`
// imports all concrete tokens and registers them; consumers import that module (or the barrel).
export interface TokenFactories {
    entityProperty(parent: QueryToken, fieldInfo: FieldInfo, route: PropertyRoute): QueryToken;
    idProperty(parent: QueryToken): QueryToken;
    entityToString(parent: QueryToken): QueryToken;
    hasValue(parent: QueryToken): QueryToken;
    objectProperty(parent: QueryToken, memberName: string, resultType: TypeReference, displayName: string, isMethod: boolean, format?: string, unit?: string): QueryToken;
    asType(parent: QueryToken, entityCtor: Function): QueryToken;
    dateToken(parent: QueryToken): QueryToken;
    modulo(parent: QueryToken, divisor: number): QueryToken;
    count(parent: QueryToken): QueryToken;
    aggregate(aggregateFunction: string, parent: QueryToken | undefined, options?: { filterOperation?: string; value?: unknown; distinct?: boolean; queryName?: QueryName }): QueryToken;
    collectionElement(parent: QueryToken, elementType: string): QueryToken;
    collectionAnyAll(parent: QueryToken, anyAllType: string): QueryToken;
    collectionToArray(parent: QueryToken, toArrayType: string): QueryToken;
    quickLinksContainer(parent: QueryToken): QueryToken;
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
