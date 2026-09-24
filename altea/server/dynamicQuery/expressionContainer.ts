import type { Quoted } from "quote-transformer/quoted";
import { BaseEntity, Entity, type Type } from "../../data/entity";
import { Implementations } from "../../data/implementations";
import { ClassType, ArrayType, LiteType, EnumType, TemporalType, LiteralType, RuntimeType } from "../runtimeTypes";
import { TypeReference } from "../../data/reflection";
import { Expression, ParameterExpression } from "../linq/expressions";
import { ExpressionVisitor } from "../linq/visitors/ExpressionVisitor";
import { QueryToken, entityCtorOf, expressionSourceKeyOf } from "../../data/dynamicQuery/tokens";
import { extractEntity } from "./tokenExpressions";
import { ExtensionToken, IndexerContainerToken, type ExtensionInfo, type IndexerInfo, type IndexerKey } from "../../data/dynamicQuery/tokens";
import { ConstantExpression } from "../linq/expressions";
import { Meta, CleanMeta } from "./meta";
import { MetadataVisitor } from "./metadataVisitor";
import { LocalizableMessage } from "../../data/utils/localization";
import { expressionKeyOf } from "../../data/lambdaMembers";
import { enumNameOf } from "../../data/registration";
import { Enum } from "../../data/enum";

// The SERVER-side registration of a cross-entity expression (Signum's ExtensionInfo). Holds the
// un-serializable bits — the quoted `lambda` and its provenance `meta` — that only the server needs
// (to build the SQL expression + derive auth/route). getExtensionsTokens() projects this into the
// serializable entities ExtensionInfo, stashing `this` as the token's opaque `serverInfo`.
interface RegisteredExpression {
    readonly sourceType: Function;
    readonly key: string;
    readonly resultType: RuntimeType;
    readonly isProjection: boolean;
    readonly implementations?: Implementations;
    readonly niceName: () => string; // culture-dependent thunk, resolved per request
    readonly lambda: unknown;        // Quoted<(source) => result>
    readonly meta: Meta;
}

// Port of Signum's `ExpressionContainer` (DynamicQuery/ExpressionContainer.cs): registers a
// cross-entity expression `(source) => result` so it shows up as a sub-token on `source`'s tokens
// (an ExtensionToken) — e.g. `Customer.Orders`. On navigation the token inlines the registered
// lambda's body against the parent expression, which the binder then translates.
export class ExpressionContainer {
    // source type → (extension key → server registration). Keyed by `object`, not `Function`: the source
    // of an expression is any BaseEntity class today (an entity, an embedded, a model), and an ENUM —
    // which has no constructor and is identified by the enum object itself — is the next key this map has
    // to hold. `expressionSourceKeyOf` is what turns a token's type into this key; see it for what is
    // deliberately still out (value types).
    private readonly registered = new Map<object, Map<string, RegisteredExpression>>();

    /**
     * `register(SourceType, e => e.member(), Caption)` — the caption may be the MESSAGE itself.
     *
     * A registered expression's caption almost always IS a `msg()` member, because a `@quoted` method is
     * not a PropertyRoute and so has no `<Member>` entry a translation could live under (see
     * `@legacyPropertyRoute`). Taking the `LocalizableMessage` directly saves every call site the same
     * `{ niceName: () => X.niceToString() }` wrapper, and the `key` is derived from the lambda's tail
     * member anyway — so the whole registration is three arguments and no object.
     *
     * The options form stays for the captions that are NOT a message: a target type's plural
     * (`() => AlertEntity.nicePluralName()`), an enum's own name, or a key the derivation would get wrong.
     */
    register<E extends BaseEntity, S>(sourceType: Type<E>, lambda: Quoted<(source: E) => S>, caption?: LocalizableMessage | ExpressionOptions): RegisteredExpression {
        const opts = toExpressionOptions(caption);
        // resultType / isProjection come from the EXPANDED body (fromQuotedLambda inlines the @quoted
        // method); the key must come from the RAW quoted body's tail member, since after expansion the
        // original method name (`albumCount`) is gone (replaced by its body's tail, e.g. `count`).
        const bound = Expression.fromQuotedLambda(lambda as never, [new ClassType(sourceType)]);
        const body = bound.body;
        const key = opts?.key ?? expressionKeyOf(lambda as Function);
        // Fail-fast on a forgotten @quoted. Signum catches this at compile time (the lambda IS the
        // expression tree); here the tail method silently falls through to fromQuoted's residual-call
        // path, which types the body as `null` — a token that then shows up broken (or not at all) on
        // the client. A registered expression MUST resolve to a real value type, so reject a null body.
        if (body.type instanceof LiteralType && body.type.typeName === "null")
            throw new Error(
                `Expression '${key}' on '${(sourceType as Function).name}' did not resolve to a translatable value: ` +
                `its tail method is neither @quoted nor @resultType (a forgotten @quoted?).`);
        const isProjection = body.type instanceof ArrayType;
        const elementType = isProjection ? (body.type as ArrayType).elementType : body.type;
        const implementations = opts?.implementations ?? autoImplementations(elementType);
        // Default niceName (Signum's WithExpressionFrom/To behaviour): when the result is an entity,
        // use the target type's NicePluralName (collection/projection) or NiceName (single); otherwise
        // fall back to the key. A thunk, since the display name is culture-dependent.
        const targetCtor = entityCtorOf(toTypeReference(elementType));
        const defaultNiceName: () => string = targetCtor != undefined
            ? (isProjection ? () => targetCtor.nicePluralName() : () => targetCtor.niceName())
            : () => key;
        // Provenance of the expression (Signum's Meta): which source columns it reads, so the token
        // inherits IsAllowed from them. Computed once here off the inlined body + source parameter.
        const meta = MetadataVisitor.gatherMeta(body, bound.parameters[0], sourceType);
        const reg: RegisteredExpression = {
            sourceType, key, resultType: body.type, isProjection, implementations,
            niceName: opts?.niceName ?? defaultNiceName, lambda, meta,
        };
        let map = this.registered.get(sourceType);
        if (map == undefined) { map = new Map(); this.registered.set(sourceType, map); }
        map.set(key, reg);
        return reg;
    }

    // source type → (prefix → registration with a parameter).
    private readonly indexers = new Map<object, Map<string, RegisteredIndexer>>();

    /**
     * Signum's `RegisterWithParameter`: an expression with a PARAMETER, shown as a `[Prefix]` container
     * whose children `[Prefix].[<key>]` are one per key `getKeys` lists, each evaluating `lambda(e, key)`.
     *
     * `keyType` is what `key` is inside the lambda — an entity class, an enum object, or a scalar name —
     * so the body binds (`us.skill.is(sk)`). The container's prefix is the caption message's MEMBER name
     * (Signum's `enumMessage.ToString()`), and a key's text is its `toString()`, as Signum's: a stored
     * column must mean the same thing in every environment, and ids differ between them.
     *
     * `getKeys` is SYNCHRONOUS — a token is resolved while a query is parsed — so it reads a cache that is
     * already warm (a lazy loaded at start-up, read with `valueOrUndefined`).
     */
    registerWithParameter<E extends BaseEntity, K, V>(
        sourceType: Type<E>,
        keyType: Function | object | "string" | "number",
        lambda: Quoted<(source: E, key: K) => V>,
        getKeys: (parent: QueryToken) => readonly K[],
        caption: LocalizableMessage | IndexerOptions<K>,
    ): RegisteredIndexer {
        const opts: IndexerOptions<K> = caption instanceof LocalizableMessage
            ? { prefix: caption.member!, niceName: () => caption.niceToString() }
            : caption;
        const keyRuntimeType = toKeyRuntimeType(keyType);
        const bound = Expression.fromQuotedLambda(lambda as never, [new ClassType(sourceType), keyRuntimeType]);
        const body = bound.body;
        if (body.type instanceof LiteralType && body.type.typeName === "null")
            throw new Error(`Expression with parameter '${opts.prefix}' on '${(sourceType as Function).name}' did not resolve to a translatable value (a forgotten @quoted?).`);
        const elementType = body.type instanceof ArrayType ? body.type.elementType : body.type;
        const reg: RegisteredIndexer = {
            sourceType, prefix: opts.prefix, niceName: opts.niceName ?? (() => opts.prefix),
            resultType: body.type, implementations: opts.implementations ?? autoImplementations(elementType),
            keyRuntimeType, lambda, getKeys: getKeys as (parent: QueryToken) => readonly unknown[],
            keyText: (opts.keyText as ((k: unknown) => string) | undefined) ?? defaultKeyText(keyRuntimeType),
            keyNiceName: (opts.keyNiceName as ((k: unknown) => string) | undefined) ?? (opts.keyText as ((k: unknown) => string) | undefined) ?? defaultKeyNiceName(keyRuntimeType),
            autoExpand: opts.autoExpand ?? false,
            // The key parameter reads no column, so the provenance is the source parameter's alone.
            meta: MetadataVisitor.gatherMeta(body, bound.parameters[0], sourceType),
        };
        let map = this.indexers.get(sourceType);
        if (map == undefined) { map = new Map(); this.indexers.set(sourceType, map); }
        map.set(reg.prefix, reg);
        return reg;
    }

    /** The containers, grouped by declaring type — shipped in the blob beside the plain expressions. */
    declaredIndexers(): Map<object, IndexerInfo[]> {
        const out = new Map<object, IndexerInfo[]>();
        for (const [source, byPrefix] of this.indexers)
            out.set(source, [...byPrefix.values()].map(reg => this.toIndexerInfo(reg)));
        return out;
    }

    /** The server's listing of a container's children (the indexer-keys provider). */
    indexerKeys(container: IndexerContainerToken): IndexerKey[] {
        const reg = container.info.serverInfo as RegisteredIndexer | undefined;
        if (reg == undefined)
            return [];
        return reg.getKeys(container.parent!).map(k => ({ key: reg.keyText(k), niceName: reg.keyNiceName(k), value: k }));
    }

    // The body with the source replaced by the parent and the key by a constant — Signum's
    // `t => LambdaExpression.Evaluate(t, key)`.
    buildExtensionWithParameter(serverInfo: unknown, key: unknown, parentExpression: Expression): Expression {
        const reg = serverInfo as RegisteredIndexer;
        const bound = Expression.fromQuotedLambda(reg.lambda as never, [new ClassType(reg.sourceType), reg.keyRuntimeType]);
        const pe = parentExpression.type instanceof LiteType ? extractEntity(parentExpression, false) : parentExpression;
        const withSource = new ParameterReplacer(bound.parameters[0], pe).visit(bound.body);
        // An enum key is its NUMERIC member inside a query, as any captured enum constant is.
        const value = reg.keyRuntimeType instanceof EnumType && typeof key === "string" ? Enum.toValue(reg.keyRuntimeType.enumObject as never, key as never) : key;
        return new ParameterReplacer(bound.parameters[1], new ConstantExpression(value, reg.keyRuntimeType)).visit(withSource);
    }

    private toIndexerInfo(reg: RegisteredIndexer): IndexerInfo {
        const propertyRoute = reg.meta instanceof CleanMeta && reg.meta.propertyRoutes.length === 1 ? reg.meta.propertyRoutes[0] : undefined;
        return {
            prefix: reg.prefix,
            niceName: reg.niceName,
            resultType: toTypeReference(reg.resultType),
            implementations: reg.implementations,
            propertyRoute,
            autoExpand: reg.autoExpand,
            allowedReason: () => reg.meta.isAllowed(),
            serverInfo: reg,
        };
    }

    /**
     * Every registration, grouped by the source type that DECLARES it — what the metadata blob ships, so
     * the client can build an extension token without asking per token of that type. The key is the same
     * one `expressionSourceKeyOf` produces: a ctor for a BaseEntity source, the enum object for an enum.
     */
    declaredExtensions(): Map<object, ExtensionInfo[]> {
        const out = new Map<object, ExtensionInfo[]>();
        for (const [source, byKey] of this.registered)
            out.set(source, [...byKey.values()].map(reg => this.toExtensionInfo(reg)));
        return out;
    }

    // Signum's GetExtensionsTokens: the ExtensionTokens applicable to `parent` (by its clean entity
    // type, walking the base chain so a base-type registration shows on subtypes). This is the SERVER
    // implementation of the divergent extension-token source (setExtensionTokensProvider): it reads
    // the local registration table and projects each entry into the serializable entities
    // ExtensionInfo — resolving the culture-dependent niceName, and deriving the clean property route
    // and the auth reason from the expression's Meta — while stashing the registration as the token's
    // opaque `serverInfo` so buildExtension can inline the lambda.
    getExtensionsTokens(parent: QueryToken): QueryToken[] {
        // A registered expression belongs on tokens of its source TYPE, not on the RAW COLLECTION nav of
        // that type: "Details" (OrderLine[]) must NOT expose OrderLine's subTotalPrice — it surfaces under
        // the collection's .Element / .Any sub-tokens (Details.Element.SubTotalPrice, Details.Any.SubTotalPrice).
        // entityCtorOf ignores `.array` (Type.is unwraps it) and the .Element/.Any tokens also carry an array
        // type, so the discriminator is: skip a collection token that is NOT itself an element/quantifier.
        // Mirrors Signum (extensions hang off the element token, never the collection).
        if (parent.type.array && !parent.isElement() && !parent.isAnyOrAll())
            return [];
        // Not `entityCtorOf`: an expression may be registered on any BaseEntity — an EMBEDDED or a model
        // as much as an entity — and an enum is keyed by its own object. A source with no class to walk
        // (an enum) answers from its single entry; only a class has a base chain, which is what makes a
        // registration on `Entity` show on every subtype.
        const key = expressionSourceKeyOf(parent.type);
        if (key == undefined)
            return [];
        const out: QueryToken[] = [];
        if (typeof key !== "function") {
            for (const reg of this.registered.get(key)?.values() ?? [])
                out.push(new ExtensionToken(parent, this.toExtensionInfo(reg)));
            for (const reg of this.indexers.get(key)?.values() ?? [])
                out.push(new IndexerContainerToken(parent, this.toIndexerInfo(reg)));
            return out;
        }
        for (let c: Function | undefined = key; c != undefined && c !== Object; c = Object.getPrototypeOf(c)) {
            const map = this.registered.get(c);
            if (map != undefined)
                for (const reg of map.values())
                    out.push(new ExtensionToken(parent, this.toExtensionInfo(reg)));
            // …and the [Prefix] containers of the expressions with a parameter, walked the same way.
            for (const reg of this.indexers.get(c)?.values() ?? [])
                out.push(new IndexerContainerToken(parent, this.toIndexerInfo(reg)));
        }
        return out;
    }

    private toExtensionInfo(reg: RegisteredExpression): ExtensionInfo {
        // A clean single-route expression exposes that route (Signum's ExtensionToken over CleanMeta);
        // a computed/multi-route (DirtyMeta) expression has none.
        const propertyRoute = reg.meta instanceof CleanMeta && reg.meta.propertyRoutes.length === 1
            ? reg.meta.propertyRoutes[0] : undefined;
        const resultType = toTypeReference(reg.resultType);
        // Decimal inference. Signum gets this free from the C# `decimal` result type; altea's query
        // value-type system collapses every numeric to "number" (see runtimeTypes), so infer it from the
        // SOURCE columns: a numeric value computed from any decimal column is itself decimal. This lets a
        // computed money column (e.g. Order.totalPrice = Σ subTotalPrice) format as "N2" / 0.00 like the
        // columns it is built from, with no per-registration format needed.
        if (!reg.isProjection && resultType.typeName === "Number" && resultType.subTypeName == null
            && reg.meta.cleanRoutes.some(r => r.fieldInfo?.subTypeName === "decimal" || r.fieldInfo?.typeName === "Decimal"))
            resultType.subTypeName = "decimal";
        return {
            key: reg.key,
            niceName: reg.niceName,
            resultType,
            isProjection: reg.isProjection,
            implementations: reg.implementations,
            propertyRoute,
            allowedReason: () => reg.meta.isAllowed(),
            serverInfo: reg,
        };
    }

    // Signum's BuildExtension: inline the registered lambda's body against the parent expression.
    // `serverInfo` is the token's opaque handle — the RegisteredExpression stashed above.
    buildExtension(serverInfo: unknown, parentExpression: Expression): Expression {
        const reg = serverInfo as RegisteredExpression;
        const bound = Expression.fromQuotedLambda(reg.lambda as never, [new ClassType(reg.sourceType)]);
        const param = bound.parameters[0];
        // Adapt the parent to the lambda's entity parameter (a lite parent → its entity).
        const pe = parentExpression.type instanceof LiteType ? extractEntity(parentExpression, false) : parentExpression;
        return new ParameterReplacer(param, pe).visit(bound.body);
    }
}

function autoImplementations(elementType: RuntimeType): Implementations | undefined {
    const ctor = entityCtorOf(toTypeReference(elementType));
    return ctor != undefined ? Implementations.by(ctor) : undefined;
}

// Map an expression's RuntimeType (the server query engine's type system) to the client-facing
// TypeReference an extension token carries. The one place a RuntimeType→TypeReference bridge is needed:
// extension tokens are server-produced, so their result type is derived from the built expression.
export function toTypeReference(rt: RuntimeType): TypeReference {
    if (rt instanceof ArrayType) return Object.assign(toTypeReference(rt.elementType!), { array: true });
    if (rt instanceof LiteType) return Object.assign(toTypeReference(rt.entityType), { lite: true });
    if (rt instanceof ClassType) return new TypeReference({ type: () => rt.constructorFunction });
    if (rt instanceof EnumType) return new TypeReference({ type: () => rt.enumObject });
    if (rt instanceof TemporalType) return new TypeReference({ typeName: rt.kind === "date" ? "PlainDate" : rt.kind === "duration" ? "Duration" : "PlainDateTime" });
    if (rt instanceof LiteralType) return new TypeReference({ typeName: rt.typeName === "boolean" ? "Boolean" : rt.typeName === "string" ? "String" : rt.typeName === "number" ? "Number" : rt.typeName === "decimal" ? "Decimal" : "String" });
    return new TypeReference();
}

/** What a registration can say beyond the source type and the lambda. */
export interface ExpressionOptions {
    /**
     * TESTS ONLY — for a throwaway lambda with no member worth naming (`e => table(X).filter(…)`). Real
     * registrations take the key from the lambda's tail member (`expressionKeyOf`), so it stays typed:
     * name the member what the token should be called.
     */
    key?: string;
    /** A caption that is not a plain message: a target type's plural, an enum's own name, a format. */
    niceName?: () => string;
    implementations?: Implementations;
}

/** The message overload, normalised — a `LocalizableMessage` becomes the `niceName` thunk it stands for. */
function toExpressionOptions(arg: LocalizableMessage | ExpressionOptions | undefined): ExpressionOptions | undefined {
    return arg instanceof LocalizableMessage ? { niceName: () => arg.niceToString() } : arg;
}

// Replaces the lambda's parameter with the parent expression when inlining a registered expression.
class ParameterReplacer extends ExpressionVisitor {
    constructor(private readonly param: ParameterExpression, private readonly replacement: Expression) { super(); }
    override visitParameter(node: ParameterExpression): Expression {
        return node === this.param ? this.replacement : node;
    }
}

// The server registration of an expression with a parameter (Signum's ExtensionWithParameterInfo).
interface RegisteredIndexer {
    readonly sourceType: Function;
    readonly prefix: string;
    readonly niceName: () => string;
    readonly resultType: RuntimeType;
    readonly implementations?: Implementations;
    readonly keyRuntimeType: RuntimeType;
    readonly lambda: unknown; // Quoted<(source, key) => result>
    readonly getKeys: (parent: QueryToken) => readonly unknown[];
    readonly keyText: (key: unknown) => string;
    readonly keyNiceName: (key: unknown) => string;
    readonly autoExpand: boolean;
    readonly meta: Meta;
}

/** What a registration with a parameter can say beyond the source, the key type and the lambda. */
export interface IndexerOptions<K> {
    /** The container's key, `[prefix]` — a message's member name when the caption is a message. */
    prefix: string;
    niceName?: () => string;
    /** A key's text — the child token's key. Default: `toString()`, as Signum's. */
    keyText?: (key: K) => string;
    /** A key's caption. Default: its text. */
    keyNiceName?: (key: K) => string;
    implementations?: Implementations;
    /** Signum's AutoExpand: the picker lists the children inline. */
    autoExpand?: boolean;
}

// Signum's `ParameterValue?.ToString() ?? "null"` — an enum by its MEMBER NAME, whichever form the key is in.
function defaultKeyText(keyType: RuntimeType): (key: unknown) => string {
    if (keyType instanceof EnumType)
        return key => typeof key === "number" ? Enum.toName(keyType.enumObject as never, key as never) : String(key);
    return key => key == null ? "null" : String(key);
}

// Signum's NiceName: an enum member's own nice name, anything else its text.
function defaultKeyNiceName(keyType: RuntimeType): (key: unknown) => string {
    if (keyType instanceof EnumType)
        return key => Enum.niceName(keyType.enumObject as never, key as never);
    return defaultKeyText(keyType);
}

function toKeyRuntimeType(keyType: Function | object | "string" | "number"): RuntimeType {
    if (keyType === "string") return LiteralType.string;
    if (keyType === "number") return LiteralType.number;
    if (typeof keyType === "function") return new ClassType(keyType);
    return new EnumType(keyType, enumNameOf(keyType) ?? "Enum");
}
