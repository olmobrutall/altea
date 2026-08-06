import type { Quoted } from "quote-transformer/quoted";
import { Entity } from "../../data/entity";
import { Implementations } from "../../data/implementations";
import { Localization } from "../../data/utils/localization";
import { ClassType, ArrayType, LiteType, EnumType, TemporalType, LiteralType, RuntimeType } from "../runtimeTypes";
import { TypeReference } from "../../data/reflection";
import { Expression, ParameterExpression } from "../linq/expressions";
import { ExpressionVisitor } from "../linq/visitors/ExpressionVisitor";
import { QueryToken, entityCtorOf } from "../../data/dynamicQuery/tokens";
import { extractEntity } from "./tokenExpressions";
import { ExtensionToken, type ExtensionInfo } from "../../data/dynamicQuery/tokens";
import { Meta, CleanMeta } from "./meta";
import { MetadataVisitor } from "./metadataVisitor";

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
    // sourceType clean-key → (extension key → server registration).
    private readonly registered = new Map<Function, Map<string, RegisteredExpression>>();

    register<E extends Entity, S>(sourceType: Function, lambda: Quoted<(source: E) => S>, opts?: { key?: string; niceName?: () => string; implementations?: Implementations }): RegisteredExpression {
        // resultType / isProjection come from the EXPANDED body (fromQuotedLambda inlines the @quoted
        // method); the key must come from the RAW quoted body's tail member, since after expansion the
        // original method name (`albumCount`) is gone (replaced by its body's tail, e.g. `count`).
        const bound = Expression.fromQuotedLambda(lambda as never, [new ClassType(sourceType)]);
        const body = bound.body;
        const key = opts?.key ?? deriveKeyFromQuoted(lambda);
        const isProjection = body.type instanceof ArrayType;
        const elementType = isProjection ? (body.type as ArrayType).elementType : body.type;
        const implementations = opts?.implementations ?? autoImplementations(elementType);
        // Default niceName (Signum's WithExpressionFrom/To behaviour): when the result is an entity,
        // use the target type's NicePluralName (collection/projection) or NiceName (single); otherwise
        // fall back to the key. A thunk, since the display name is culture-dependent.
        const targetCtor = entityCtorOf(toTypeReference(elementType));
        const defaultNiceName: () => string = targetCtor != undefined
            ? (isProjection ? () => Localization.nicePluralName(targetCtor) : () => Localization.niceName(targetCtor))
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

    // Signum's GetExtensionsTokens: the ExtensionTokens applicable to `parent` (by its clean entity
    // type, walking the base chain so a base-type registration shows on subtypes). This is the SERVER
    // implementation of the divergent extension-token source (setExtensionTokensProvider): it reads
    // the local registration table and projects each entry into the serializable entities
    // ExtensionInfo — resolving the culture-dependent niceName, and deriving the clean property route
    // and the auth reason from the expression's Meta — while stashing the registration as the token's
    // opaque `serverInfo` so buildExtension can inline the lambda.
    getExtensionsTokens(parent: QueryToken): QueryToken[] {
        const ctor = entityCtorOf(parent.type);
        if (ctor == undefined)
            return [];
        const out: QueryToken[] = [];
        for (let c: Function | undefined = ctor; c != undefined && c !== Object; c = Object.getPrototypeOf(c)) {
            const map = this.registered.get(c);
            if (map != undefined)
                for (const reg of map.values())
                    out.push(new ExtensionToken(parent, this.toExtensionInfo(reg)));
        }
        return out;
    }

    private toExtensionInfo(reg: RegisteredExpression): ExtensionInfo {
        // A clean single-route expression exposes that route (Signum's ExtensionToken over CleanMeta);
        // a computed/multi-route (DirtyMeta) expression has none.
        const propertyRoute = reg.meta instanceof CleanMeta && reg.meta.propertyRoutes.length === 1
            ? reg.meta.propertyRoutes[0] : undefined;
        return {
            key: reg.key,
            niceName: reg.niceName,
            resultType: toTypeReference(reg.resultType),
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

// The tail member of the RAW quoted lambda body (before @quoted expansion): `a => a.albumCount()`
// → "albumCount", `a => a.address` → "address". Mirrors Signum's ReflectionTools.GetMethodInfo /
// property-name extraction from the un-inlined MethodCallExpression.
function deriveKeyFromQuoted(lambda: unknown): string {
    const q = (lambda as Quoted<Function>).__quoted;
    if (q == undefined)
        throw new Error("Extension lambda is not quoted (needs the quote-transformer); pass { key } explicitly");
    const ex = q(); // ["=>", params, body]
    return tailMember(ex[2]);
}

function tailMember(node: unknown): string {
    if (Array.isArray(node)) {
        if (node[0] === "()" || node[0] === "?.()")
            return tailMember(node[1]);        // a call → the member being called
        if (node[0] === "." || node[0] === "?.")
            return node[2] as string;          // a property access → its name
    }
    throw new Error("Cannot derive an extension key from the lambda body; pass { key } explicitly");
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
    if (rt instanceof LiteralType) return new TypeReference({ typeName: rt.typeName === "boolean" ? "Boolean" : rt.typeName === "string" ? "String" : rt.typeName === "number" ? "Number" : "String" });
    return new TypeReference();
}

// Replaces the lambda's parameter with the parent expression when inlining a registered expression.
class ParameterReplacer extends ExpressionVisitor {
    constructor(private readonly param: ParameterExpression, private readonly replacement: Expression) { super(); }
    override visitParameter(node: ParameterExpression): Expression {
        return node === this.param ? this.replacement : node;
    }
}
