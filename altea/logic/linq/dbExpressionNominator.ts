import {
    Expression, BinaryExpression, UnaryExpression, ConditionalExpression,
    ConstantExpression, CastExpression, ObjectExpression, NewExpression,
    CallExpression, PropertyExpression, ParameterExpression, LambdaExpression,
} from "./expressions";
import {
    ColumnExpression, SqlConstantExpression, PrimaryKeyExpression,
    IsNullExpression, IsNotNullExpression, LikeExpression, SqlFunctionExpression,
    AggregateExpression, CaseExpression, ScalarExpression, ExistsExpression, InExpression,
    EntityExpression, EmbeddedEntityExpression, MixinEntityExpression, ProjectionExpression,
} from "./expressions.sql";

// Minimal port of Signum's DbExpressionNominator. Decides which expressions can
// be evaluated on the SERVER (a "candidate"): a node is a candidate iff its type
// is server-supported AND all its descendants are candidates. The maximal
// candidate subtrees become columns in the SELECT (ColumnProjector takes the
// outermost candidate). Composite client-side nodes (Entity/Embedded/Object/New)
// are NOT candidates, but we still recurse into them to collect the column
// candidates inside (so a whole-entity projection materialises its columns).
//
// NOTE: this skeleton only *collects* candidates; it does not yet rewrite source
// calls into SQL nodes (Like/CONCAT/etc. — that's the function-mapping tier).

export function nominate(expr: Expression): Set<Expression> {
    const candidates = new Set<Expression>();

    // Returns whether `e` (and its whole subtree) is a server candidate.
    function visit(e: Expression | undefined): boolean {
        if (e == null)
            return true;

        // Leaf candidates.
        if (e instanceof ColumnExpression || e instanceof SqlConstantExpression) {
            candidates.add(e);
            return true;
        }
        // A captured constant becomes a SQL parameter.
        if (e instanceof ConstantExpression) {
            candidates.add(e);
            return true;
        }

        // PrimaryKey wraps a single column but is NOT itself collapsed into one
        // column — keep the wrapper so the reader can treat the id specially.
        // Nominate the inner column, but report the PK as non-candidate.
        if (e instanceof PrimaryKeyExpression) { visit(e.value); return false; }

        // Single-child server nodes.
        if (e instanceof UnaryExpression) return unary(e, e.expression);
        if (e instanceof CastExpression) return unary(e, e.expression);
        if (e instanceof IsNullExpression) return unary(e, e.expression);
        if (e instanceof IsNotNullExpression) return unary(e, e.expression);

        if (e instanceof BinaryExpression) return nary(e, [e.left, e.right]);
        if (e instanceof ConditionalExpression) return nary(e, [e.condition, e.whenTrue, e.whenFalse]);
        if (e instanceof LikeExpression) return nary(e, [e.expression, e.pattern]);
        if (e instanceof SqlFunctionExpression) return nary(e, [e.object, ...e.arguments]);
        if (e instanceof AggregateExpression) return nary(e, e.arguments);
        if (e instanceof CaseExpression) return nary(e, [...e.whens.flatMap(w => [w.condition, w.value]), e.defaultValue]);

        // Subqueries are server candidates as a whole (their inner select is its
        // own scope); we don't descend for column nomination here.
        if (e instanceof ScalarExpression || e instanceof ExistsExpression || e instanceof InExpression) {
            candidates.add(e);
            return true;
        }

        // Non-candidate composites — recurse to collect inner candidates, but the
        // node itself stays client-side (constructed by the projector).
        if (e instanceof EntityExpression) {
            visit(e.externalId);
            e.bindings?.forEach(b => visit(b.binding));
            e.mixins?.forEach(m => visit(m));
            return false;
        }
        if (e instanceof EmbeddedEntityExpression) {
            visit(e.hasValue);
            e.bindings.forEach(b => visit(b.binding));
            e.mixins?.forEach(m => visit(m));
            return false;
        }
        if (e instanceof MixinEntityExpression) {
            e.bindings.forEach(b => visit(b.binding));
            return false;
        }
        if (e instanceof ObjectExpression) {
            Object.values(e.properties).forEach(v => visit(v));
            return false;
        }
        if (e instanceof NewExpression) {
            e.args.forEach(a => visit(a));
            return false;
        }
        if (e instanceof ProjectionExpression) {
            return false;
        }

        // Parameters / unbound members / calls / lambdas are never server values.
        if (e instanceof ParameterExpression || e instanceof PropertyExpression ||
            e instanceof CallExpression || e instanceof LambdaExpression) {
            return false;
        }

        return false;
    }

    function unary(node: Expression, child: Expression | undefined): boolean {
        const ok = visit(child);
        if (ok) candidates.add(node);
        return ok;
    }

    function nary(node: Expression, children: readonly (Expression | undefined)[]): boolean {
        let all = true;
        for (const c of children)
            all = visit(c) && all; // visit every child (side effects) before short-circuit
        if (all) candidates.add(node);
        return all;
    }

    visit(expr);
    return candidates;
}
