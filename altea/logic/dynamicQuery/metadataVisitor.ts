import { PropertyRoute, PropertyRouteType } from "../../entities/propertyRoute";
import { Implementations } from "../../entities/implementations";
import {
    Expression, ParameterExpression, PropertyExpression, CallExpression, ObjectExpression,
    LambdaExpression, BinaryExpression, ConditionalExpression, UnaryExpression, CastExpression,
} from "../linq/expressions";
import { Meta, CleanMeta, DirtyMeta } from "./meta";

// Port of Signum's `MetadataVisitor` (Engine/Linq/Meta/MetadataVisitor.cs). A meta-interpreter over
// an (already-expanded, pre-bind) altea expression: it tracks which entity PropertyRoutes each
// value derives from, producing a `Meta` (CleanMeta / DirtyMeta) per output value. This is how a
// computed expression (an extension expression body, or a query's projector column) inherits
// IsAllowed / implementations from the columns it reads — reflection gives structure, this gives
// provenance. Faithful to Signum's operator semantics: Count/Any/All/Contains → void (no
// provenance), Sum/Min/Max/Average propagate their selector, Select/Where/GroupBy/SelectMany thread
// the element meta.
//
// Nodes the interpreter produces (Signum's MetaExpression / MetaProjectorExpression / grouping):
//  - MetaValue:  a scalar value carrying a Meta.
//  - MetaColl:   a collection ("projector") carrying its element node.
//  - MetaRecord: an object/anonymous projection (or a GroupBy grouping as {key, elements}).
abstract class MetaNode { }
class MetaValue extends MetaNode { constructor(readonly meta: Meta) { super(); } }
class MetaColl extends MetaNode { constructor(readonly element: MetaNode) { super(); } }
class MetaRecord extends MetaNode { constructor(readonly members: Map<string, MetaNode>) { super(); } }

const voidMeta = (): Meta => new DirtyMeta(undefined, []);
const voidValue = (): MetaValue => new MetaValue(voidMeta());

// All the routes any node ultimately reads (for DirtyMeta provenance).
function collectMetas(node: MetaNode): Meta[] {
    if (node instanceof MetaValue) return [node.meta];
    if (node instanceof MetaColl) return collectMetas(node.element);
    if (node instanceof MetaRecord) return [...node.members.values()].flatMap(collectMetas);
    return [];
}

function aggregateImplementations(impls: Implementations[]): Implementations | undefined {
    if (impls.length === 0) return undefined;
    if (impls.length === 1) return impls[0];
    if (impls.some(i => i.isByAll)) return Implementations.byAll;
    return Implementations.by(...new Set(impls.flatMap(i => i.types)));
}

// Signum's MetadataVisitor.GetImplementations: a member's implementations from the routes it maps to.
function getImplementations(routes: PropertyRoute[]): Implementations | undefined {
    if (routes.length === 1 && routes[0].propertyRouteType === PropertyRouteType.Root)
        return Implementations.by(routes[0].rootType);
    const impls = routes.map(r => r.tryGetImplementations()).filter((x): x is Implementations => x != undefined);
    return aggregateImplementations(impls);
}

function dirtyValue(nodes: MetaNode[]): MetaValue {
    const metas = nodes.flatMap(collectMetas);
    const impls = aggregateImplementations(metas.map(m => m.implementations).filter((x): x is Implementations => x != undefined));
    return new MetaValue(new DirtyMeta(impls, metas));
}

export class MetadataVisitor {
    private readonly env = new Map<ParameterExpression, MetaNode>();

    private constructor() { }

    // Gather the Meta of a value expression evaluated with `param` bound to `sourceMeta` (a
    // CleanMeta root of the source entity). Signum's MetadataVisitor.JustVisit.
    static gatherMeta(body: Expression, param: ParameterExpression, sourceType: Function): Meta {
        const v = new MetadataVisitor();
        v.env.set(param, new MetaValue(new CleanMeta(Implementations.by(sourceType), [PropertyRoute.root(sourceType)])));
        const node = v.visit(body);
        return node instanceof MetaValue ? node.meta : new DirtyMeta(undefined, collectMetas(node));
    }

    private visit(e: Expression): MetaNode {
        if (e instanceof ParameterExpression) return this.env.get(e) ?? voidValue();
        if (e instanceof PropertyExpression) return this.bindMember(this.visit(e.object), e.propertyName);
        if (e instanceof ObjectExpression) {
            const members = new Map<string, MetaNode>();
            for (const [name, ex] of Object.entries(e.properties))
                members.set(name, this.visit(ex));
            return new MetaRecord(members);
        }
        if (e instanceof CallExpression) return this.visitCall(e);
        if (e instanceof BinaryExpression) return dirtyValue([this.visit(e.left), this.visit(e.right)]);
        if (e instanceof ConditionalExpression) return dirtyValue([this.visit(e.condition), this.visit(e.whenTrue), this.visit(e.whenFalse)]);
        if (e instanceof CastExpression) return this.visitCast(e);
        if (e instanceof UnaryExpression) return this.visit(e.expression); // negate/not keep the operand's provenance
        return voidValue(); // Constant, etc.
    }

    private visitCall(c: CallExpression): MetaNode {
        if (!(c.func instanceof PropertyExpression))
            return dirtyValue(c.args.map(a => this.visit(a)));

        const source = c.func.object;
        const method = c.func.propertyName;
        const args = c.args;

        switch (method) {
            case "map": {
                const coll = this.asColl(this.visit(source));
                return new MetaColl(this.mapAndVisit(args[0] as LambdaExpression, coll.element));
            }
            case "filter": case "orderBy": case "orderByDescending": case "distinct":
            case "top": case "take": case "skip":
                return this.asColl(this.visit(source));
            case "flatMap": {
                const coll = this.asColl(this.visit(source));
                const inner = this.asColl(this.mapAndVisit(args[0] as LambdaExpression, coll.element));
                return new MetaColl(inner.element);
            }
            case "groupBy": {
                const coll = this.asColl(this.visit(source));
                const key = this.mapAndVisit(args[0] as LambdaExpression, coll.element);
                return new MetaColl(new MetaRecord(new Map<string, MetaNode>([
                    ["key", key],
                    ["elements", new MetaColl(coll.element)],
                ])));
            }
            // Aggregates that carry NO provenance (Signum's BindCount / BindAny / BindAll / BindContains).
            case "some": case "every": case "count": case "contains": case "includes":
                return voidValue();
            // Aggregates that propagate their selector's meta (Signum's BindAggregate).
            case "sum": case "min": case "max": case "average": {
                const coll = this.asColl(this.visit(source));
                if (args[0] instanceof LambdaExpression)
                    return this.mapAndVisit(args[0], coll.element);
                return coll.element;
            }
            case "first": case "single": case "firstOrNull": case "singleOrNull":
                return this.asColl(this.visit(source)).element;
            case "toLite":
                return this.visit(source); // Signum's MakeCleanMeta passthrough
            case "toString":
                return dirtyValue([this.visit(source)]); // display string, keeps source provenance, drops impls
            default:
                return dirtyValue([this.visit(source), ...args.map(a => this.visit(a))]);
        }
    }

    private visitCast(e: CastExpression): MetaNode {
        const inner = this.visit(e.expression);
        if (!(inner instanceof MetaValue))
            return inner;
        const m = inner.meta;
        const target = entityCtorOfType(e.type);
        const imps = m.implementations != undefined && target != undefined ? Implementations.by(target) : m.implementations;
        const meta = m instanceof CleanMeta ? new CleanMeta(imps, m.propertyRoutes) : new DirtyMeta(imps, (m as DirtyMeta).cleanMetas);
        return new MetaValue(meta);
    }

    // Signum's BindMember: read a member off a record (anonymous/grouping) or navigate an entity route.
    private bindMember(source: MetaNode, member: string): MetaNode {
        if (source instanceof MetaRecord)
            return source.members.get(member) ?? voidValue();
        if (source instanceof MetaColl)
            return voidValue(); // a property on a collection (e.g. `.length`) has no clean route
        return new MetaValue(this.navigate((source as MetaValue).meta, member));
    }

    private navigate(meta: Meta, member: string): Meta {
        if (meta instanceof CleanMeta) {
            try {
                const routes = meta.propertyRoutes.map(r => r.add(member));
                return new CleanMeta(getImplementations(routes), routes);
            } catch {
                // Polymorphic reference (add throws): expand over each implementation type.
                if (meta.implementations != undefined && !meta.implementations.isByAll) {
                    try {
                        const routes = meta.implementations.types.map(t => PropertyRoute.root(t).add(member));
                        return new CleanMeta(getImplementations(routes), routes);
                    } catch { /* fall through to void */ }
                }
                return voidMeta(); // computed / not a real field
            }
        }
        return new DirtyMeta(undefined, [meta]); // member of a computed value stays computed
    }

    // Signum's AsProjection: coerce a node to a collection projector. A collection-typed CleanMeta
    // becomes a projector whose element is that route's "Item".
    private asColl(node: MetaNode): MetaColl {
        if (node instanceof MetaColl) return node;
        if (node instanceof MetaValue && node.meta instanceof CleanMeta) {
            try {
                const routes = node.meta.propertyRoutes.map(r => r.add("Item"));
                return new MetaColl(new MetaValue(new CleanMeta(getImplementations(routes), routes)));
            } catch { /* not a collection route */ }
        }
        return new MetaColl(voidValue());
    }

    private mapAndVisit(lambda: LambdaExpression, ...projs: MetaNode[]): MetaNode {
        lambda.parameters.forEach((p, i) => this.env.set(p, projs[i] ?? voidValue()));
        const result = this.visit(lambda.body);
        lambda.parameters.forEach(p => this.env.delete(p));
        return result;
    }
}

// The concrete entity ctor behind a cast target type (ClassType / LiteType), if any.
function entityCtorOfType(type: unknown): Function | undefined {
    const t = type as { entityType?: unknown; constructorFunction?: Function };
    const inner = (t.entityType as { constructorFunction?: Function } | undefined)?.constructorFunction ?? t.constructorFunction;
    return typeof inner === "function" ? inner : undefined;
}
