import {
    Expression, BinaryExpression, UnaryExpression, ConstantExpression,
    LambdaExpression, ParameterExpression, PropertyExpression,
} from "@altea/altea/server/linq/expressions";
import { ExpressionVisitor } from "@altea/altea/server/linq/visitors/ExpressionVisitor";
import { LiteralType, type RuntimeType } from "@altea/altea/server/runtimeTypes";
import { TypeConditionSymbol, TypeAllowed, TypeAllowedBasic, typeAllowedGet } from "../data/Rules";
import { WithConditions } from "./WithConditions";
import { TypeConditionLogic } from "./TypeConditionLogic";
import type { Type, Entity } from "@altea/altea/data/entity";

// Port of Signum.Authorization's Rules/TypeConditionAlgebra.cs — see port/Auth.md.
//
// Compile a role's WithConditions<TypeAllowed> for a type into a boolean SQL predicate over the entity:
// build a node tree (True / False + And / Or / Not / Symbol) from the fallback + condition rules for a
// requested access level, simplify it, then lower it to an `Expression`. The result is what filters which
// rows a role may read — the SQL mirror of the in-memory reverse scan in TypeAuthLogic.isAllowedFor.
//
// A SymbolNode is lowered by SUBSTITUTING the predicate lambda's parameter with the shared entity
// parameter and splicing its body directly: there is no Invoke node here, and a splice lowers to SQL with
// nothing to inline.
//
// A QUERY-AUDITOR condition has no predicate of its own — its verdict comes from auditing the CALLER'S
// query, resolved one phase earlier — so its lambda arrives pre-resolved in `auditedConditions` and is
// spliced in exactly like a registered one. A SymbolNode with NEITHER is a registration bug, and is
// treated as NOT satisfied rather than crashing a query: a type condition can only ever GRANT access, so
// denying is the safe reading.

// Re-base a quoted predicate's body onto a shared parameter — each fromQuotedLambda call mints its own
// ParameterExpression instance.
class ParamReplacer extends ExpressionVisitor {
    constructor(private readonly from: ParameterExpression, private readonly to: ParameterExpression) { super(); }
    override visitParameter(node: ParameterExpression): Expression {
        return node === this.from ? this.to : node;
    }
}

// ---- boolean node tree -----------------------------------------------------------------------------

abstract class Node {
    abstract constantValue(): boolean | undefined; // undefined = not constant
    abstract key(): string;
    isMoreSimpleAndGeneralThan(_og: Node): boolean { return false; }
}
class AndNode extends Node {
    readonly nodes: Node[];
    constructor(nodes: Node[]) { super(); this.nodes = dedup(nodes); }
    constantValue(): boolean | undefined { return this.nodes.length === 0 ? true : undefined; }
    key(): string { return "AND(" + this.nodes.map(n => n.key()).sort().join(",") + ")"; }
    override isMoreSimpleAndGeneralThan(og: Node): boolean {
        return og instanceof AndNode && this.nodes.every(n => og.nodes.some(x => x.key() === n.key()));
    }
}
class OrNode extends Node {
    readonly nodes: Node[];
    constructor(nodes: Node[]) { super(); this.nodes = dedup(nodes); }
    constantValue(): boolean | undefined { return this.nodes.length === 0 ? false : undefined; }
    key(): string { return "OR(" + this.nodes.map(n => n.key()).sort().join(",") + ")"; }
}
class NotNode extends Node {
    constructor(readonly operand: Node) { super(); }
    constantValue(): boolean | undefined { const v = this.operand.constantValue(); return v === undefined ? undefined : !v; }
    key(): string { return "NOT(" + this.operand.key() + ")"; }
}
class SymbolNode extends Node {
    constructor(readonly symbol: TypeConditionSymbol) { super(); }
    constantValue(): boolean | undefined { return undefined; }
    key(): string { return "S:" + this.symbol.key; }
    override isMoreSimpleAndGeneralThan(og: Node): boolean {
        return og instanceof AndNode && og.nodes.some(x => x.key() === this.key());
    }
}
const TRUE = new AndNode([]);
const FALSE = new OrNode([]);

function dedup(nodes: Node[]): Node[] {
    const seen = new Map<string, Node>();
    for (const n of nodes) seen.set(n.key(), n);
    return [...seen.values()];
}

// Fold the condition rules (in order) over the fallback base value. A rule
// that GRANTS (allowed >= requested) OR-s its symbol-AND onto the accumulator; one that DENIES AND-s a NOT.
function toNode(wc: WithConditions<TypeAllowed>, requested: TypeAllowedBasic, ui: boolean): Node {
    let acum: Node = typeAllowedGet(wc.fallback, ui) >= requested ? TRUE : FALSE;
    for (const cr of wc.conditionRules) {
        const iExp = new AndNode(cr.typeConditions.map(s => new SymbolNode(s)));
        acum = typeAllowedGet(cr.allowed, ui) >= requested
            ? new OrNode([iExp, acum])
            : new AndNode([new NotNode(iExp), acum]);
    }
    return acum;
}

function simplify(node: Node): Node {
    if (node instanceof SymbolNode)
        return node;
    if (node instanceof AndNode) {
        const kept = node.nodes.map(simplify).filter(n => n.constantValue() !== true);
        const flat = dedup(kept.flatMap(n => n instanceof AndNode ? n.nodes : [n]));
        if (flat.some(n => n.constantValue() === false)) return FALSE;
        return flat.length === 1 ? flat[0] : new AndNode(flat);
    }
    if (node instanceof OrNode) {
        const kept = node.nodes.map(simplify).filter(n => n.constantValue() !== false);
        const flat = dedup(kept.flatMap(n => n instanceof OrNode ? n.nodes : [n]));
        if (flat.some(n => n.constantValue() === true)) return TRUE;
        const subsumed = flat.filter(og => !flat.some(og2 => og2.key() !== og.key() && og2.isMoreSimpleAndGeneralThan(og)));
        return subsumed.length === 1 ? subsumed[0] : new OrNode(subsumed);
    }
    if (node instanceof NotNode) {
        const simp = simplify(node.operand);
        const cv = simp.constantValue();
        return cv === true ? FALSE : cv === false ? TRUE : new NotNode(simp);
    }
    throw new Error("simplify: unexpected node");
}

// The compiled row-filter for (role's WithConditions, requested level, ui): a boolean LambdaExpression
// over the entity, or "all" (every row passes — no filter) / "none" (no row passes).
export type AuthFilter = LambdaExpression | "all" | "none";

export function buildAuthFilter(
    ctor: Type<Entity>,
    elementType: RuntimeType,
    wc: WithConditions<TypeAllowed>,
    requested: TypeAllowedBasic,
    userInterface: boolean,
    /** Pre-resolved verdicts for this type's QUERY-AUDITOR conditions — see the header. */
    auditedConditions?: ReadonlyMap<TypeConditionSymbol, LambdaExpression>,
): AuthFilter {
    const node = simplify(toNode(wc, requested, userInterface));
    const cv = node.constantValue();
    if (cv === true) return "all";
    if (cv === false) return "none";

    const param = new ParameterExpression("e", elementType);
    const toExpr = (n: Node): Expression => {
        const c = n.constantValue();
        if (c === true) return new ConstantExpression(true, LiteralType.boolean);
        if (c === false) return new ConstantExpression(false, LiteralType.boolean);
        if (n instanceof SymbolNode) {
            const lambda = symbolLambda(ctor, elementType, n.symbol, auditedConditions);
            if (lambda == null)
                return new ConstantExpression(false, LiteralType.boolean);
            return new ParamReplacer(lambda.parameters[0], param).visit(lambda.body);
        }
        if (n instanceof NotNode) return new UnaryExpression("!", toExpr(n.operand));
        if (n instanceof AndNode) return n.nodes.map(toExpr).reduce((a, b) => new BinaryExpression("&&", a, b));
        if (n instanceof OrNode) return n.nodes.map(toExpr).reduce((a, b) => new BinaryExpression("||", a, b));
        throw new Error("toExpr: unexpected node");
    };
    return new LambdaExpression([param], toExpr(node));
}

// The predicate for ONE symbol: the audited verdict when this is a query-auditor condition, else the
// registered `@quoted` predicate. Undefined when it is an auditor condition whose verdict was not
// resolved — see the header on why that denies rather than throws.
function symbolLambda(
    ctor: Type<Entity>,
    elementType: RuntimeType,
    symbol: TypeConditionSymbol,
    auditedConditions: ReadonlyMap<TypeConditionSymbol, LambdaExpression> | undefined,
): LambdaExpression | undefined {
    if (TypeConditionLogic.isQueryAuditor(ctor, symbol))
        return auditedConditions?.get(symbol);
    return Expression.fromQuotedLambda(TypeConditionLogic.getCondition(ctor, symbol), [elementType]);
}

// The row-filter as a boolean LambdaExpression for the LINQ binder's `EntityEvents.queryFilter` hook:
// "all" → undefined (no WHERE), "none" → `e => false`, else the built predicate.
export function authFilterLambda(filter: AuthFilter, elementType: RuntimeType): LambdaExpression | undefined {
    if (filter === "all")
        return undefined;
    if (filter === "none")
        return new LambdaExpression([new ParameterExpression("e", elementType)], new ConstantExpression(false, LiteralType.boolean));
    return filter;
}

// The raw per-condition boolean predicate as a LambdaExpression `(e) => <condition body>`, for the
// retrieve-time additional binding. Unlike buildAuthFilter this
// is ONE condition, un-combined and un-negated — the binder folds it straight into the retrieval SELECT
// (QueryBinder.withAdditionalBindings binds it against the entity). fromQuotedLambda already yields a
// single-parameter lambda over `elementType`, so it needs no re-basing.
export function conditionValueLambda(ctor: Type<Entity>, elementType: RuntimeType, symbol: TypeConditionSymbol): LambdaExpression {
    return Expression.fromQuotedLambda(TypeConditionLogic.getCondition(ctor, symbol), [elementType]);
}

// Replace a lambda parameter with an arbitrary EXPRESSION (not just another parameter) — for rebasing a
// root's filter body onto a navigation off a different parameter.
class ExprReplacer extends ExpressionVisitor {
    constructor(private readonly from: ParameterExpression, private readonly to: Expression) { super(); }
    override visitParameter(node: ParameterExpression): Expression {
        return node === this.from ? this.to : node;
    }
}

// Rebase a ROOT's AuthFilter onto a PART for a STANDALONE `table(Part)` query: navigate the Part's
// back-reference chain up to the root (`part.<f1>.<f2>…`) and apply the root's condition there. So a Part
// queried alone is restricted exactly as its root is ("apply the parent's TypeCondition when the
// part is queried in isolation"); via-owner access never reaches here (the collection projection bypasses
// the queryFilter marker). "all" → no filter; "none" → no row passes.
export function rebasePartFilter(rootFilter: AuthFilter, partElementType: RuntimeType, chain: readonly string[]): LambdaExpression | undefined {
    if (rootFilter === "all")
        return undefined;
    const part = new ParameterExpression("e", partElementType);
    if (rootFilter === "none")
        return new LambdaExpression([part], new ConstantExpression(false, LiteralType.boolean));
    const nav = chain.reduce<Expression>((obj, field) => new PropertyExpression(obj, field, false), part);
    const body = new ExprReplacer(rootFilter.parameters[0], nav).visit(rootFilter.body);
    return new LambdaExpression([part], body);
}
