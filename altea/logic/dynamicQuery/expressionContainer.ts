import type { Quoted } from "quote-transformer/quoted";
import { Entity } from "../../entities/entity";
import { Implementations } from "../../entities/implementations";
import { niceName, nicePluralName } from "../../entities/utils/localization";
import { ClassType, ArrayType, LiteType, RuntimeType } from "../../entities/runtimeTypes";
import { Expression, ParameterExpression } from "../linq/expressions";
import { ExpressionVisitor } from "../linq/visitors/ExpressionVisitor";
import { QueryToken, entityCtorOf, cleanType, extractEntity } from "./tokens/queryToken";
import { ExtensionToken, type ExtensionInfo } from "./tokens/extensionToken";
import { MetadataVisitor } from "./metadataVisitor";

// Port of Signum's `ExpressionContainer` (DynamicQuery/ExpressionContainer.cs): registers a
// cross-entity expression `(source) => result` so it shows up as a sub-token on `source`'s tokens
// (an ExtensionToken) — e.g. `Customer.Orders`. On navigation the token inlines the registered
// lambda's body against the parent expression, which the binder then translates.
export class ExpressionContainer {
    // sourceType clean-key → (extension key → info).
    private readonly registered = new Map<Function, Map<string, ExtensionInfo>>();

    register<E extends Entity, S>(sourceType: Function, lambda: Quoted<(source: E) => S>, opts?: { key?: string; niceName?: () => string; implementations?: Implementations }): ExtensionInfo {
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
        const targetCtor = entityCtorOf(cleanType(elementType));
        const defaultNiceName: () => string = targetCtor != undefined
            ? (isProjection ? () => nicePluralName(targetCtor) : () => niceName(targetCtor))
            : () => key;
        // Provenance of the expression (Signum's Meta): which source columns it reads, so the token
        // inherits IsAllowed from them. Computed once here off the inlined body + source parameter.
        const meta = MetadataVisitor.gatherMeta(body, bound.parameters[0], sourceType);
        const info: ExtensionInfo = {
            sourceType, key, resultType: body.type, isProjection, implementations,
            niceName: opts?.niceName ?? defaultNiceName, lambda, meta,
        };
        let map = this.registered.get(sourceType);
        if (map == undefined) { map = new Map(); this.registered.set(sourceType, map); }
        map.set(key, info);
        return info;
    }

    // Signum's GetExtensionsTokens: the ExtensionTokens applicable to `parent` (by its clean entity
    // type, walking the base chain so a base-type registration shows on subtypes).
    getExtensionsTokens(parent: QueryToken): QueryToken[] {
        const ctor = entityCtorOf(cleanType(parent.type));
        if (ctor == undefined)
            return [];
        const out: QueryToken[] = [];
        for (let c: Function | undefined = ctor; c != undefined && c !== Object; c = Object.getPrototypeOf(c)) {
            const map = this.registered.get(c);
            if (map != undefined)
                for (const info of map.values())
                    out.push(new ExtensionToken(parent, info));
        }
        return out;
    }

    // Signum's BuildExtension: inline the registered lambda's body against the parent expression.
    buildExtension(info: ExtensionInfo, parentExpression: Expression): Expression {
        const bound = Expression.fromQuotedLambda(info.lambda as never, [new ClassType(info.sourceType)]);
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
    const q = (lambda as { __quoted?: () => unknown }).__quoted;
    if (q == undefined)
        throw new Error("Extension lambda is not quoted (needs the quote-transformer); pass { key } explicitly");
    const ex = q() as unknown[]; // ["=>", params, body]
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
    const ct = cleanType(elementType);
    const ctor = ct instanceof ClassType && (ct.constructorFunction === Entity || ct.constructorFunction.prototype instanceof Entity)
        ? ct.constructorFunction : undefined;
    return ctor != undefined ? Implementations.by(ctor) : undefined;
}

// Replaces the lambda's parameter with the parent expression when inlining a registered expression.
class ParameterReplacer extends ExpressionVisitor {
    constructor(private readonly param: ParameterExpression, private readonly replacement: Expression) { super(); }
    override visitParameter(node: ParameterExpression): Expression {
        return node === this.param ? this.replacement : node;
    }
}
