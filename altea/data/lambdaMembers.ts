// Member-path extraction from a property lambda (Signum's getLambdaMembers). altea uses the
// quote-transformer's compile-time expression tree (`__quoted`) instead of Signum's runtime
// `lambda.toString()` regex parse — it's exact and minification-proof, and consistent with how altea
// navigates the query model everywhere else. NO regex fallback: the lambda MUST be quoted, i.e. an
// inline property lambda passed to a `Quoted<...>`-typed parameter (the transformer then emits
// `__quoted`). A non-quoted lambda (e.g. a stored function reference the transformer never saw) throws.
//
// Lives in entities (not react/binding) so PropertyRoute.addLambda can use it; re-exported from
// react/binding.ts for that layer's importers.
import type { Quoted, ExLambda, QuotedEx } from 'quote-transformer/quoted';

export function getLambdaMembers(lambda: Function): LambdaMember[] {
  const ex: ExLambda | undefined = (lambda as Quoted<Function>).__quoted?.();
  if (ex == null)
    throw new Error(
      "getLambdaMembers: the lambda carries no `__quoted` expression tree. It must be an inline " +
      "property lambda passed to a `Quoted<...>` parameter (there is no regex/toString fallback).");

  // ExLambda = ["=>", params, body]. Walk the body's property/index chain down to the parameter,
  // collecting members leaf-first, then reverse to root-first.
  const result: LambdaMember[] = [];
  let node: any = ex[2];
  while (true) {
    switch (node[0] as QuotedEx[0]) {
      case ".":
      case "?.":
        result.push({ name: node[2] as string, type: "Member" });
        node = node[1];
        break;
      case "[i]":
        result.push({ name: "", type: "Indexer" });
        node = node[1];
        break;
      case "as": // a cast (e => (e.a as X).b) — transparent to the member path
        node = node[1];
        break;
      case "()":
      case "?.()": { // a method call — `.mixin(SomeMixin)` OR an altea @quoted expression member
        const callee = node[1];
        if ((callee[0] === "." || callee[0] === "?.") && callee[2] === "mixin") {
          const ctor = node[2][0]?.[0] === "c" ? node[2][0][1] : undefined; // args[0] = ["c", MixinCtor]
          if (typeof ctor !== "function")
            throw new Error("getLambdaMembers: `.mixin(...)` expects a mixin class constant argument");
          result.push({ name: (ctor as Function).name, type: "Mixin" });
          node = callee[1]; // continue from the receiver of `.mixin(...)`
          break;
        }
        // ALTEA DIVERGENCE: Signum's computed/expression members are C# PROPERTIES (`a.TotalPrice`);
        // altea models them as @quoted METHODS (`a.totalPrice()`), so a navigation to one reaches it as
        // a call off a property access. Treat the called member as a Member step (its name) so a query
        // token can navigate an expression column: `token(a => a.totalPrice())` → "TotalPrice".
        if (callee[0] === "." || callee[0] === "?.") {
          result.push({ name: callee[2] as string, type: "Member" });
          node = callee[1];
          break;
        }
        throw new Error("getLambdaMembers: only `.mixin(MixinClass)` or an expression-member call (`a.foo()`) are allowed in a property lambda");
      }
      case "p": // reached the lambda parameter — done
        return result.reverse();
      default:
        throw new Error(`getLambdaMembers: unsupported expression node '${node[0]}' in a property lambda`);
    }
  }
}

export function getFieldMembers(field: string): LambdaMember[] {
  if (field.includes(".")) {
    const mixinType = field.before(".").after("[").before("]");
    const fieldName = field.after(".");
    return [
      { type: "Mixin", name: mixinType },
      { type: "Member", name: fieldName.firstLower() }
    ];
  } else {
    return [
      { type: "Member", name: field.firstLower() }
    ];
  }
}

export interface LambdaMember {
  name: string;
  type: MemberType;
}

export type MemberType = "Member" | "Mixin" | "Indexer";

/**
 * The KEY of a registered expression, from its quoted lambda — the tail member of the RAW body (before
 * @quoted expansion): `a => a.albumCount()` → "AlbumCount", `a => a.address` → "Address". Mirrors
 * Signum's ReflectionTools.GetMethodInfo / property-name extraction from the un-inlined
 * MethodCallExpression — PascalCased, because a token key is (see EntityPropertyToken.key), and because
 * Signum derives its own from a PascalCase C# member.
 *
 * Shared by the server's `ExpressionContainer.register` and the client's `Finder.addExpressionSettings`,
 * so the two name the same expression the same way.
 */
export function expressionKeyOf(lambda: Function): string {
  const q = (lambda as Quoted<Function>).__quoted;
  if (q == undefined)
    throw new Error("Extension lambda is not quoted (needs the quote-transformer)");
  const ex = q(); // ["=>", params, body]
  return tailMember(ex[2]).firstUpper();
}

function tailMember(node: unknown): string {
  if (Array.isArray(node)) {
    if (node[0] === "()" || node[0] === "?.()")
      return tailMember(node[1]);        // a call → the member being called
    if (node[0] === "." || node[0] === "?.")
      return node[2] as string;          // a property access → its name
  }
  throw new Error("Cannot derive an extension key from the lambda body: it must end in a member (a => a.foo or a => a.foo()), named what the token should be called");
}
