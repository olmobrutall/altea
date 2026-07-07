
import { isOptionalChain } from "typescript";
import { ExLambda, OpBinary, OpUnary, Quoted, QuotedEx, ExParam } from 'quote-transformer/quoted';
import { ArrayType, FunctionType as FunctionType, LiteralType, ClassType, LiteType, ObjectType, TemporalType, Type } from "../../entities/types";
import { Temporal } from "../../entities/basics";
import { resolveType } from "../../entities/registration";
import { tryGetTypeInfo, type FieldInfo } from "../../entities/reflection";
import { Lite } from "../../entities/lite";
import { Entity, View } from "../../entities/entity";
import { getLambdaTypeResolvers, getResultTypeResolver, LambdaTypeResolver, OrderedQuery, Query, ResultTypeResolver, StaticFunction } from "../query";
import type { ExpressionVisitor } from "./visitors/ExpressionVisitor";

// ---- constant folding (used by fromQuoted) --------------------------------------------------
// fromQuoted folds parameter-free subtrees to constants BOTTOM-UP, in the same single pass that
// builds the Expression tree (a port of the constant part of Signum's PartialEval). A node
// folds when its already-built children are ConstantExpressions — so there's no separate
// param-free scan. Short-circuit operators build the controlling operand first and skip the
// dead branch, so an unreachable, un-typeable branch (Throw<T>(), a null-guarded `.name`) is
// never built.

// A value that must NOT be frozen to a constant: a query source (table/view), a set-returning /
// scalar / array-index SQL marker (PostgresFunctions), or a Query — all must stay translatable
// to SQL rather than run at query-build time.
function isQueryMarker(v: unknown): boolean {
    if (v instanceof Query)
        return true;
    if (typeof v !== "function")
        return false;
    const f = v as { __isQuerySource?: unknown; __srfName?: unknown; __scalarSqlName?: unknown; __arrayIndex?: unknown };
    return f.__isQuerySource === true || f.__srfName != null || f.__scalarSqlName != null || f.__arrayIndex === true;
}

function evalUnaryOp(op: OpUnary, a: any): unknown {
    switch (op) {
        case "!": return !a;
        case "~": return ~a;
        case "+u": return +a;
        case "-u": return -a;
    }
}

function evalBinaryOp(op: OpBinary, a: any, b: any): unknown {
    switch (op) {
        case "==": return a == b;
        case "===": return a === b;
        case "!=": return a != b;
        case "!==": return a !== b;
        case "<": return a < b;
        case "<=": return a <= b;
        case ">": return a > b;
        case ">=": return a >= b;
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "%": return a % b;
        case "**": return a ** b;
        case "<<": return a << b;
        case ">>": return a >> b;
        case ">>>": return a >>> b;
        case "&": return a & b;
        case "|": return a | b;
        case "^": return a ^ b;
        case "instanceof": return a instanceof (b as Function);
        default: throw new Error("evalBinaryOp: unsupported operator " + op);
    }
}

// Fold `obj.name` when `obj` is a constant and the value is plain — a function (method group
// like `ids.contains`) or a Query is left as a PropertyExpression so the binder can dispatch /
// translate it. `?.` on a null constant folds to undefined.
function foldOrProperty(obj: Expression, name: string, optional: boolean): Expression {
    if (obj instanceof ConstantExpression) {
        if (obj.value == null) {
            if (optional)
                return new ConstantExpression(undefined);
        } else {
            const v = (obj.value as Record<string, unknown>)[name];
            if (typeof v !== "function" && !(v instanceof Query))
                return new ConstantExpression(v);
        }
    }
    return new PropertyExpression(obj, name, optional);
}

// The compile-time value of a constant expression or a constant *path* (`Ns.Member.…`, e.g.
// `Temporal.PlainDate`). A method group like `ids.contains` is NOT folded to a constant (see
// foldOrProperty), so its receiver arrives as a PropertyExpression; this recovers the receiver's
// value so a fully-constant call on it can still fold. Bounded by the path depth. Returns null
// for anything that isn't a constant path (e.g. rooted at a query parameter).
function constValueOf(exp: Expression): { value: unknown } | null {
    if (exp instanceof ConstantExpression)
        return { value: exp.value };
    if (exp instanceof PropertyExpression && !exp.isOptionalChaining) {
        const o = constValueOf(exp.object);
        if (o != null && o.value != null)
            return { value: (o.value as Record<string, unknown>)[exp.propertyName] };
    }
    return null;
}

// Fold a call with all-constant receiver/callee + args to a constant value. Returns null when
// it must stay structural: a non-constant/absent receiver, a query source/marker, or a result
// that is a Query (e.g. `x.inDB()` must reach its @methodExpander). Only called when there are
// no lambda args (a lambda is never constant).
function tryFoldCall(fun: Expression, argVals: unknown[], optional: boolean): Expression | null {
    if (fun instanceof PropertyExpression) {
        const recvC = constValueOf(fun.object);
        if (recvC == null)
            return null;
        const recv = recvC.value as Record<string, unknown> | null;
        if (recv == null)
            return optional ? new ConstantExpression(undefined) : null;
        const fn = recv[fun.propertyName];
        if (typeof fn !== "function" || isQueryMarker(fn))
            return null;
        const result = (fn as (...a: unknown[]) => unknown).apply(recv, argVals);
        return result instanceof Query ? null : new ConstantExpression(result);
    }
    if (fun instanceof ConstantExpression && typeof fun.value === "function" && !isQueryMarker(fun.value)) {
        const result = (fun.value as (...a: unknown[]) => unknown)(...argVals);
        return result instanceof Query ? null : new ConstantExpression(result);
    }
    return null;
}

// Resolves the static type of `owner.propertyName` from the entity metadata, so
// PropertyExpression carries a real type (collection field → ArrayType, reference
// → ClassType, value → LiteralType). This feeds both the flatMap array-guard and
// the method-call dispatch in fromQuoted (which keys off ArrayType/ClassType).
// Unknown owners/fields (temporal types, enums, unreflected types) stay null.
// A View subclass constructor — the target of an in-query `Ctor.create({ … })` projection.
function isViewCtorValue(value: unknown): value is Function {
    return typeof value === "function" && (value === View || (value as Function).prototype instanceof View);
}

function resolveMemberType(ownerType: Type, propertyName: string): Type {
    // Navigating through a Lite<T>: `.entity`/`.entityOrNull` yield the wrapped
    // entity (so `lite.entity.field` types correctly); other members stay null.
    if (ownerType instanceof LiteType)
        return propertyName === "entity" || propertyName === "entityOrNull" ? ownerType.entityType : LiteralType.null;

    // `promise.$v` is the Promise<T>→T compile-time cast (SQL has no async). It carries no
    // SQL meaning, so at the expression level it is a pure identity: the type of `x.$v` is
    // the type of `x`. (The AST never carries a PromiseType — query terminals are typed as
    // their unwrapped value.)
    if (propertyName === "$v")
        return ownerType;

    // An anonymous result (e.g. a grouping `{ key, elements }`): the member type is
    // the declared property type, so `g.elements` types as the element array and
    // `g.elements.sum()` dispatches via the Array (OrderedQuery) prototype.
    if (ownerType instanceof ObjectType)
        return ownerType.bindings[propertyName] ?? LiteralType.null;

    // Date/time part properties (`.year`, `.dayOfWeek`, `.hour`, …) → number; `.date`
    // → a date. (Methods like `.quarter()` are typed via wellKnownResultTypes.)
    if (ownerType instanceof TemporalType) {
        switch (propertyName) {
            case "year": case "month": case "day": case "hour": case "minute":
            case "second": case "millisecond": case "dayOfYear": case "dayOfWeek":
            case "dayNumber":
                return LiteralType.number;
            case "date":
                return new TemporalType("date");
            default:
                return LiteralType.null;
        }
    }

    if (!(ownerType instanceof ClassType))
        return LiteralType.null;
    const fi = tryGetTypeInfo(ownerType.constructorFunction)?.fields[propertyName];
    if (fi == null)
        return LiteralType.null;

    // Container flags compose as `Lite<T>[]` (lite inside the array).
    let t = baseTypeOfFieldInfo(fi);
    if (fi.lite)
        t = new LiteType(t);
    if (fi.array)
        t = new ArrayType(t);
    return t;
}

function baseTypeOfFieldInfo(fi: FieldInfo): Type {
    if (fi.isEnum)
        return LiteralType.null; // enums are not modelled as a Type yet
    switch (fi.typeName) {
        case "Number": return LiteralType.number;
        case "String": return LiteralType.string;
        case "Boolean": return LiteralType.boolean;
        case "PlainDateTime": return new TemporalType("dateTime");
        case "PlainDate": return new TemporalType("date");
        case "Duration": return new TemporalType("duration");
    }
    const ctor = resolveType(fi.typeName);
    if (ctor != null)
        return new ClassType(ctor);
    // A polymorphic reference declared with an interface type (e.g. `author:
    // IAuthorEntity`) has no runtime constructor, but it is still an entity reference:
    // type it as Entity so member/method dispatch works (the binder resolves the
    // concrete implementations). Non-reference unresolved types stay null.
    if (fi.implementations != null)
        return new ClassType(Entity);
    return LiteralType.null;
}

// ---- well-known built-in functions ------------------------------------------
// Result types of built-in functions the binder lowers to SQL but which carry no
// @resultType decorator: native String/Math methods plus the String/Array helpers
// from globals.ts. Keyed "<namespace>.<method>", where the namespace names the
// receiver — mirroring Signum's DbExpressionNominator, which switches on
// `DeclaringType.TypeName() + "." + MethodName` ("string.IndexOf", "Math.Sin").
// To type a new built-in inside quoted lambdas, add an entry here; the binder
// (bindMethodCall) still owns its actual SQL translation.
const wellKnownResultTypes: Readonly<Record<string, Type>> = {
    "string.contains": LiteralType.boolean,
    "string.startsWith": LiteralType.boolean,
    "string.endsWith": LiteralType.boolean,
    "string.like": LiteralType.boolean,
    "string.indexOf": LiteralType.number,
    "string.toLowerCase": LiteralType.string,
    "string.toUpperCase": LiteralType.string,
    "string.trimStart": LiteralType.string,
    "string.trimEnd": LiteralType.string,
    "string.trim": LiteralType.string,
    "string.substring": LiteralType.string,
    "string.start": LiteralType.string,
    "string.end": LiteralType.string,
    "string.reverse": LiteralType.string,
    "string.replicate": LiteralType.string,
    "string.etc": LiteralType.string,

    "Array.contains": LiteralType.boolean,

    // Date/time methods (the rest are properties, typed by resolveMemberType). The
    // nominator lowers these to SQL (date_trunc / DATEADD-DATEDIFF / CAST / age).
    "dateTime.quarter": LiteralType.number,
    "date.quarter": LiteralType.number,
    // Truncation / "start of" → keeps the receiver's temporal kind.
    "dateTime.yearStart": new TemporalType("dateTime"),
    "dateTime.quarterStart": new TemporalType("dateTime"),
    "dateTime.monthStart": new TemporalType("dateTime"),
    "dateTime.weekStart": new TemporalType("dateTime"),
    "dateTime.truncHours": new TemporalType("dateTime"),
    "dateTime.truncMinutes": new TemporalType("dateTime"),
    "dateTime.truncSeconds": new TemporalType("dateTime"),
    "date.yearStart": new TemporalType("date"),
    "date.quarterStart": new TemporalType("date"),
    "date.monthStart": new TemporalType("date"),
    "date.weekStart": new TemporalType("date"),
    // Convert.
    "dateTime.toPlainDate": new TemporalType("date"),
    "date.toPlainDateTime": new TemporalType("dateTime"),
    // Whole-unit difference → number.
    "dateTime.daysTo": LiteralType.number,
    "dateTime.monthsTo": LiteralType.number,
    "dateTime.yearsTo": LiteralType.number,
    "date.daysTo": LiteralType.number,
    "date.monthsTo": LiteralType.number,
    "date.yearsTo": LiteralType.number,
    // Temporal arithmetic: `add(duration)` keeps the kind; `since(other)` is a Duration;
    // `duration.total(unit)` is a number. The nominator lowers these to DATEADD / DATEDIFF.
    "dateTime.add": new TemporalType("dateTime"),
    "date.add": new TemporalType("date"),
    "dateTime.since": new TemporalType("duration"),
    "date.since": new TemporalType("duration"),
    "duration.total": LiteralType.number,

    // Math.* — all number → number (the SQL Math-function tier).
    "Math.sign": LiteralType.number,
    "Math.abs": LiteralType.number,
    "Math.sin": LiteralType.number,
    "Math.asin": LiteralType.number,
    "Math.cos": LiteralType.number,
    "Math.acos": LiteralType.number,
    "Math.tan": LiteralType.number,
    "Math.atan": LiteralType.number,
    "Math.atan2": LiteralType.number,
    "Math.pow": LiteralType.number,
    "Math.sqrt": LiteralType.number,
    "Math.exp": LiteralType.number,
    "Math.log": LiteralType.number,
    "Math.log10": LiteralType.number,
    "Math.floor": LiteralType.number,
    "Math.ceil": LiteralType.number,
    "Math.round": LiteralType.number,
    "Math.trunc": LiteralType.number,

    // Temporal constructors (`Temporal.PlainDateTime.from(…)` etc.) → their kind.
    "PlainDateTime.from": new TemporalType("dateTime"),
    "PlainDate.from": new TemporalType("date"),
    "PlainTime.from": new TemporalType("duration"),
    "Duration.from": new TemporalType("duration"),
};

// Captured constant receivers whose methods live under a static namespace above
// (e.g. `Math.sin` → namespace "Math"). Extend this to add Date, Number, … later.
const staticNamespaceReceivers: ReadonlyMap<unknown, string> = new Map<unknown, string>([
    [Math, "Math"],
    // The Temporal constructors as static receivers, so `Temporal.PlainDateTime.from(…)`
    // dispatches and types (`.from` → the corresponding temporal kind). Constant
    // constructions are folded away by ExpressionSimplifier.
    [Temporal.PlainDateTime, "PlainDateTime"],
    [Temporal.PlainDate, "PlainDate"],
    [Temporal.PlainTime, "PlainTime"],
    [Temporal.Duration, "Duration"],
]);

// The constant value a static receiver denotes: a captured constant directly
// (`Math`), or a property off a captured namespace constant (`Temporal.PlainDateTime`
// — a two-level access that never folds, since the class is a function value).
function staticReceiverValue(obj: Expression | undefined): unknown {
    if (obj instanceof ConstantExpression)
        return obj.value;
    if (obj instanceof PropertyExpression && obj.object instanceof ConstantExpression)
        return (obj.object.value as Record<string, unknown> | null | undefined)?.[obj.propertyName];
    return undefined;
}

// The namespace prefix for a method call's receiver, or undefined if it isn't one
// we type built-ins for. A null (unresolved) receiver is treated as a string, so
// known string methods on un-typed value columns still resolve.
function wellKnownNamespace(obj: Expression | undefined): string | undefined {
    if (obj == null)
        return undefined;
    // A captured static receiver (Math, Temporal.PlainDateTime, …) takes precedence:
    // its expression type is often null, which would otherwise fall to "string".
    const staticNs = staticNamespaceReceivers.get(staticReceiverValue(obj));
    if (staticNs != null)
        return staticNs;
    if (obj.type === LiteralType.string || obj.type === LiteralType.null)
        return "string";
    if (obj.type instanceof ArrayType || (obj.type instanceof ClassType && obj.type.constructorFunction === Array))
        return "Array";
    if (obj.type instanceof TemporalType)
        return obj.type.kind;
    return undefined;
}

// The Temporal prototype to look date/time method metadata up on, by kind.
function temporalPrototype(t: TemporalType): object {
    return t.kind === "date" ? Temporal.PlainDate.prototype
        : t.kind === "duration" ? Temporal.Duration.prototype
            : Temporal.PlainDateTime.prototype;
}

// Result type of a built-in `obj.<propertyName>(…)` call, from the registry above.
function wellKnownResultType(obj: Expression | undefined, propertyName: string): ResultTypeResolver | undefined {
    // `toString()` returns a string for any receiver (entity/lite/value). Whether it
    // can be translated to SQL is decided later in the binder (ToStr column for an
    // entity/lite; the value/enum cases stay residual).
    if (propertyName === "toString")
        return () => LiteralType.string;
    // `entity.mixin(MixinClass)` → the mixin's ClassType (from the ctor argument), so a
    // following `.field` / `.collection` resolves against the mixin's reflected fields.
    if (propertyName === "mixin")
        return (_thisType: Type, argType?: Type) =>
            argType instanceof FunctionType && argType.func != null ? new ClassType(argType.func) : LiteralType.null;
    const ns = wellKnownNamespace(obj);
    if (ns == null)
        return undefined;
    const t = wellKnownResultTypes[`${ns}.${propertyName}`];
    return t == null ? undefined : () => t;
}

// A native string method we can lower to SQL — used to pick String.prototype as
// the method-dispatch target when the receiver's type is unknown (null).
function isKnownStringMethod(propertyName: string): boolean {
    return wellKnownResultTypes[`string.${propertyName}`] != null;
}

// An Entity instance method that carries query metadata — used to dispatch on
// Entity.prototype when the receiver's static type is unknown (a member reached
// through a polymorphic combine, which has no interface type to type it).
function isEntityInstanceMethod(propertyName: string): boolean {
    return propertyName === "toLite" || propertyName === "is"
        || propertyName === "combineUnion" || propertyName === "combineCase";
}

// The runtime object to look method metadata up on for a captured static receiver
// (e.g. Math), so `Math.sin` dispatches with Math as the (this-less) target.
function staticReceiverObject(obj: Expression | undefined): object | undefined {
    const v = staticReceiverValue(obj);
    if (staticNamespaceReceivers.has(v))
        return v as object;
    // A captured helper object (e.g. `EntityContext`): dispatch its methods on the object
    // itself, so one carrying query metadata (__resultType/__quoted) resolves. A method
    // without metadata still errors below ("Missing @resultType").
    if (obj instanceof ConstantExpression && typeof v === "object" && v !== null)
        return v as object;
    return undefined;
}

export abstract class Expression {
    constructor(
        public readonly kind: string,
        public readonly type: Type) {
    }

    abstract toString(): string;
    // Double-dispatch into the visitor (.NET's Expression.Accept).
    abstract accept(visitor: ExpressionVisitor): Expression;


    static fromQuotedLambda<T extends Function>(lambda: Quoted<T>, types: Type[]): LambdaExpression {
        const quoted = lambda.__quoted;
        if (quoted == undefined)
            throw new Error("The following lambda has not been quoted. Are you using ts-path and quote-transformer?");

        var bindings = new Map<ExParam, Expression>();

        return fromQuoted(quoted(), types) as LambdaExpression;

        function fromQuoted(q: QuotedEx, lambdaArgTypes?: Type[]): Expression {

            switch (q[0]) {
                case "c":
                    return new ConstantExpression(q[1]);
                case "p": {
                    const exp = bindings.get(q);
                    if (exp == null)
                        throw new Error("Unbound parameter found:" + q[1]);

                    return exp
                }
                case "+u":
                case "-u":
                case "~":
                case "!": {
                    const e = fromQuoted(q[1]);
                    // Fold a constant operand (PartialEval).
                    if (e instanceof ConstantExpression)
                        return new ConstantExpression(evalUnaryOp(q[0], e.value));
                    return new UnaryExpression(q[0], e);
                }
                // Short-circuit operators: build the controlling operand first; if it's a
                // constant, only the reachable branch is built — so a proven-dead branch
                // (Throw<T>(), a null-guarded member) is never converted or typed.
                case "&&": {
                    const l = fromQuoted(q[1]);
                    if (l instanceof ConstantExpression)
                        return l.value ? fromQuoted(q[2]) : l;
                    return new BinaryExpression("&&", l, fromQuoted(q[2]));
                }
                case "||": {
                    const l = fromQuoted(q[1]);
                    if (l instanceof ConstantExpression)
                        return l.value ? l : fromQuoted(q[2]);
                    return new BinaryExpression("||", l, fromQuoted(q[2]));
                }
                case "??": {
                    const l = fromQuoted(q[1]);
                    if (l instanceof ConstantExpression)
                        return l.value != null ? l : fromQuoted(q[2]);
                    return new BinaryExpression("??", l, fromQuoted(q[2]));
                }
                case "**":
                case "*":
                case "/":
                case "%":
                case "+":
                case "-":
                case "<<":
                case ">>":
                case ">>>":
                case "<":
                case "<=":
                case ">":
                case ">=":
                case "instanceof":
                case "==":
                case "!=":
                case "===":
                case "!==":
                case "&":
                case "|":
                case "^": {
                    const l = fromQuoted(q[1]);
                    const r = fromQuoted(q[2]);
                    // Fold when both operands are constants (PartialEval).
                    if (l instanceof ConstantExpression && r instanceof ConstantExpression)
                        return new ConstantExpression(evalBinaryOp(q[0], l.value, r.value));
                    return new BinaryExpression(q[0], l, r);
                }
                case "?:": {
                    const cond = fromQuoted(q[1]);
                    // Build only the reachable branch when the condition is a constant.
                    if (cond instanceof ConstantExpression)
                        return cond.value ? fromQuoted(q[2]) : fromQuoted(q[3]);
                    return new ConditionalExpression(cond, fromQuoted(q[2]), fromQuoted(q[3]));
                }
                case ".":
                case "?.":
                    return foldOrProperty(fromQuoted(q[1]), q[2], q[0] === "?.");
                case "()":
                case "?.()":
                    {
                        const fun = fromQuoted(q[1]);
                        const args = q[2];
                        const optional = q[0] === "?.()";

                        // `Ctor.create({ … })` where Ctor is a View subclass: build a typed
                        // instance per row. Typed as the instance (ClassType) so downstream
                        // navigation works; the QueryBinder tags the object with the ctor.
                        if (fun instanceof PropertyExpression && fun.propertyName === "create"
                            && fun.object instanceof ConstantExpression && isViewCtorValue(fun.object.value)) {
                            const createArgs = (args as QuotedEx[]).map(a => fromQuoted(a));
                            return new CallExpression(fun, createArgs, new ClassType(fun.object.value as Function));
                        }

                        // Constant fold (PartialEval): a call with no lambda args whose
                        // receiver/callee and args are all constant folds to a value — e.g.
                        // `Temporal.Now.plainDateISO()` — without needing __resultType, honouring
                        // the surrounding short-circuit (a dead branch was never built). Non-lambda
                        // args are built ONCE here and reused by the dispatch loop below.
                        let prebuiltArgs: Expression[] | undefined;
                        if (!(args as QuotedEx[]).some(a => a[0] === "=>")) {
                            prebuiltArgs = (args as QuotedEx[]).map(a => fromQuoted(a));
                            if (prebuiltArgs.every(a => a instanceof ConstantExpression)) {
                                const folded = tryFoldCall(fun, prebuiltArgs.map(a => (a as ConstantExpression).value), optional);
                                if (folded != null)
                                    return folded;
                            }
                        }

                        let sf: StaticFunction<Function>;
                        let obj: Expression | undefined;
                        if (fun instanceof PropertyExpression) {
                            obj = fun.object;
                            // The object to look method metadata up on. A captured static
                            // receiver (e.g. Math) dispatches on the object itself, so
                            // `Math["sin"] === Math.sin`.
                            const type = obj.type instanceof ArrayType ? OrderedQuery.prototype :
                                (obj.type === LiteralType.string || obj.type === LiteralType.null && isKnownStringMethod(fun.propertyName)) ? String.prototype :
                                    obj.type instanceof LiteType ? Lite.prototype :
                                        obj.type instanceof TemporalType ? temporalPrototype(obj.type) :
                                            obj.type instanceof ClassType ? obj.type.constructorFunction.prototype :
                                                obj.type === LiteralType.number ? Number.prototype :
                                                    obj.type === LiteralType.boolean ? Boolean.prototype :
                                                        staticReceiverObject(obj) ??
                                                            // `toString()` is universal (Object.prototype has it),
                                                            // so it dispatches on any receiver — e.g. an enum or
                                                            // other null-typed column. The result is typed string
                                                            // by wellKnownResultType and lowered in the nominator.
                                                            (fun.propertyName === "toString" ? Object.prototype :
                                                                // An entity instance method (`toLite`/`is`/combine*) on a
                                                                // receiver whose static type was lost — e.g. a member reached
                                                                // through a polymorphic `combineCase()`/`combineUnion()` result,
                                                                // which has no interface type in altea — dispatches on
                                                                // Entity.prototype; the binder resolves it against the reference.
                                                                (obj.type === LiteralType.null && isEntityInstanceMethod(fun.propertyName)) ? Entity.prototype : undefined);

                            if (type == undefined)
                                throw new Error(`Unexpected object type when calling ${fun.propertyName}`);

                            const propertyFunction = (type as Record<string, unknown>)[fun.propertyName] as StaticFunction<Function> | undefined;
                            // The inherited default `Entity.toString()` is `@quoted`, but its body
                            // (`niceName(this.constructor) + this.id`) is not directly bindable —
                            // especially over a polymorphic receiver. Leave it as a call so the
                            // QueryBinder expands it (per-implementation ToStr column / niceName+id).
                            // A subclass's own `@quoted` toString (a real translatable body) still inlines.
                            const isDefaultToString = fun.propertyName === "toString" && propertyFunction === Entity.prototype.toString;
                            sf = {
                                __lambdaType: getLambdaTypeResolvers(type, fun.propertyName),
                                __quoted: isDefaultToString ? undefined : propertyFunction?.__quoted,
                                __resultType: getResultTypeResolver(type, fun.propertyName) ?? wellKnownResultType(obj, fun.propertyName),
                                __methodExpander: propertyFunction?.__methodExpander,
                            };
                        } else if (fun instanceof ConstantExpression) {
                            sf = fun.value as StaticFunction<Function>;
                        }
                        else
                            throw new Error("Unable to call function on node " + fun.toString());

                        const argsExp: Expression[] = [];
                        for (let i = 0; i < args.length; i++) {
                            const a = args[i];
                            if (a[0] == "=>") {
                                const resolver = sf.__lambdaType?.[i];

                                if (resolver == null)
                                    throw new Error(
                                        fun instanceof PropertyExpression ? `Missing @lambdaTypeForParam decorator '${fun.propertyName}' for argument '${i}'` :
                                            fun instanceof ConstantExpression ? `Missing __lambdaType property for '${(fun.value as Function).name}' for argument '${i}'` :
                                                "Unexpected");

                                const paramTypes = resolver(obj?.type ?? LiteralType.null, ...argsExp.map(a => a.type));

                                argsExp[i] = fromQuoted(a, paramTypes);
                            }
                            else {
                                // Reuse the args already built for the constant-fold check.
                                argsExp[i] = prebuiltArgs ? prebuiltArgs[i] : fromQuoted(a);
                            }
                        }

                        if (sf.__quoted) {

                            const lambda = sf.__quoted();

                            if (lambda[0] != "=>")
                                throw new Error("Unexpected non-lambda");

                            // A method's quoted body takes the receiver as its first parameter
                            // (`this`), followed by the declared arguments; a free function's
                            // (`withQuoted((x) => …)`) parameters map straight to the call args.
                            if (obj != null)
                                lambda[1].forEach((p, i) => bindings.set(p, i == 0 ? obj! : argsExp[i - 1]));
                            else
                                lambda[1].forEach((p, i) => bindings.set(p, argsExp[i]));
                            var body = fromQuoted(lambda[2]);
                            lambda[1].forEach((p) => bindings.delete(p));
                            return body;
                        }

                        const getResultType = sf.__resultType;
                        if (getResultType == null) {
                            // A method on an entity receiver that can't be resolved on its
                            // (base) type — a polymorphic `@quoted` expression member reached
                            // through combineUnion()/combineCase(), whose declaring implementation
                            // isn't visible here. Emit a residual call; the QueryBinder dispatches
                            // it per-implementation and expands the @quoted body (a genuine typo
                            // then errors in the binder). Mirrors Signum, which resolves
                            // AutoExpressionField members in the QueryBinder, not before.
                            if (fun instanceof PropertyExpression && obj?.type instanceof ClassType) {
                                const call = new CallExpression(fun, argsExp, LiteralType.null);
                                call.methodExpander = sf.__methodExpander;
                                return call;
                            }
                            throw new Error(
                                fun instanceof PropertyExpression ? `Missing @resultType or @quoted in function '${fun.propertyName}'` :
                                    fun instanceof ConstantExpression ? `Missing __resultType property in function ''${(fun.value as Function).name}'` :
                                        "Unexpected"
                            );
                        }

                        // @resultType returns the unwrapped value type (identical to the type
                        // the eager Query method builds its CallExpression with) — the AST
                        // never carries a Promise, so no unwrap is needed here.
                        const resultType = getResultType(obj?.type ?? LiteralType.null, ...argsExp.map(a => a.type));
                        const call = new CallExpression(fun, argsExp, resultType);
                        call.methodExpander = sf.__methodExpander;
                        return call;
                    }
                case "=>":
                    var params = q[1].map((p, i) => new ParameterExpression(p[1], lambdaArgTypes![i]));

                    q[1].forEach((p, i) => bindings.set(p, params[i]));
                    var body = fromQuoted(q[2]);
                    q[1].forEach((p, i) => bindings.delete(p));

                    return new LambdaExpression(params, body);

                case "{}": {
                    const objectProperties: Record<string, Expression> = {};
                    for (const [name, value] of Object.entries(q[1]))
                        objectProperties[name] = fromQuoted(value);
                    // Fold an all-constant object literal to a constant value.
                    if (Object.values(objectProperties).every(v => v instanceof ConstantExpression))
                        return new ConstantExpression(Object.fromEntries(Object.entries(objectProperties).map(([k, v]) => [k, (v as ConstantExpression).value])));
                    return new ObjectExpression(objectProperties);
                }
                case "new": {
                    const newArgs = q[2].map(arg => fromQuoted(arg));
                    // Fold `new Ctor(...const)` to the constructed value.
                    if (newArgs.every(a => a instanceof ConstantExpression))
                        return new ConstantExpression(new (q[1] as new (...a: unknown[]) => unknown)(...newArgs.map(a => (a as ConstantExpression).value)));
                    return new NewExpression(q[1], newArgs);
                }
                case "as": {
                    const inner = fromQuoted(q[1]);
                    // A cast is a runtime no-op; a constant passes straight through.
                    if (inner instanceof ConstantExpression)
                        return inner;
                    return new CastExpression(inner, resolveCastType(q[2]));
                }
                default:
                    throw new Error(`Unsupported quoted expression: ${JSON.stringify(q)}`);
        }
    }
}

}

export class ConstantExpression extends Expression {
    constructor(
        public readonly value: unknown,
        type?: Type
    ) {
        super("c", type ?? ConstantExpression.calculateType(value));
    }

    private static calculateType(value: unknown): Type {
        if (value == null)
            return LiteralType.null;
        if (typeof value === "number")
            return LiteralType.number;
        if (typeof value === "string")
            return LiteralType.string;
        if (typeof value === "boolean")
            return LiteralType.boolean;
        if (typeof value === "object") {
            // A captured array → ArrayType (element type inferred from the first
            // element), so `list.some(…)` / `.every(…)` / `.contains(…)` dispatch via
            // the OrderedQuery prototype (which carries the quote decorators) rather
            // than the bare Array.prototype.
            if (Array.isArray(value))
                return new ArrayType(value.length ? ConstantExpression.calculateType(value[0]) : LiteralType.null);
            // A captured Lite must type as LiteType(entity), not ClassType(LiteImp) — else
            // `entityTypeOf`/`.entity` can't unwrap it (e.g. `female.toLite().inDB(a2 => a2.friends)`
            // constant-folds `toLite()` to a Lite value; without this its members won't resolve).
            if (value instanceof Lite)
                return new LiteType(new ClassType(value.entityType as unknown as Function));
            if (value.constructor == Object)
                return new ObjectType({});

            return new ClassType((value as {}).constructor);
        }
        if (typeof value === "function") {
            return new FunctionType(value, LiteralType.null/* unknown */);
        }

        throw new Error("Unexpected");
    }

    toString(): string {

        if (typeof this.value == "function")
            return this.value.name ?? "<<function>>";

        return `${this.value}`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return visitor.visitConstant(this);
    }
}

export class UnaryExpression extends Expression {
    constructor(
        public readonly kind: OpUnary,
        public readonly expression: Expression) {

        var type = kind == "!" ? LiteralType.boolean :
            kind == "~" ? LiteralType.number :
                kind == "-u" ? LiteralType.number :
                    kind == "+u" ? LiteralType.number : undefined;

        if (type == undefined)
            throw new Error("Unexpected kind " + kind);

        super(kind, type);
    }

    toString(): string {
        return `(${(this.kind == "-u" ? "-" : this.kind == "+u" ? "+" : this.kind)}${this.expression.toString()}`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return visitor.visitUnary(this);
    }

    updateUnary(expression: Expression): UnaryExpression {
        if (this.expression == expression)
            return this;

        return new UnaryExpression(this.kind, expression);
    }
}

export class BinaryExpression extends Expression {
    constructor(
        public readonly kind: OpBinary,
        public readonly left: Expression,
        public readonly right: Expression
    ) {
        super(kind, BinaryExpression.calculateType(kind, left, right));
    }

    private static calculateType(operator: OpBinary, left: Expression, right: Expression): Type {
        switch (operator) {
            // `+` is string concatenation when either side is a string (JS/C# `+`
            // semantics), and the result stays string so it propagates up a chain like
            // `name + " (" + year + ")"` — otherwise a composite concat node reads as
            // numeric and the formatter would emit arithmetic `+` instead of `||`/CAST.
            case "+":
                return (left.type === LiteralType.string || right.type === LiteralType.string)
                    ? LiteralType.string
                    : LiteralType.number;
            case "**":
            case "*":
            case "/":
            case "%":
            case "-":
                return LiteralType.number;
            case "<":
            case "<=":
            case ">":
            case ">=":
            case "==":
            case "!=":
            case "===":
            case "!==":
            case "instanceof":
                return LiteralType.boolean;
            case "&&":
            case "||":
            case "??":
                return left.type ?? right.type;
            // Add more cases as needed
            default:
                throw new Error("Unexpected operator " + operator);
        }
    }

    toString(): string {
        return `(${this.left.toString()} ${this.kind} ${this.right.toString()})`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return visitor.visitBinary(this);
    }

    updateBinary(left: Expression, right: Expression): BinaryExpression {
        if (this.left === left && this.right === right) {
            return this;
        }

        return new BinaryExpression(this.kind, left, right);
    }
}

export class ConditionalExpression extends Expression {
    constructor(
        public readonly condition: Expression,
        public readonly whenTrue: Expression,
        public readonly whenFalse: Expression
    ) {
        super("?:", ConditionalExpression.calculateType(whenTrue, whenFalse));
    }

    private static calculateType(trueExpression: Expression, falseExpression: Expression): Type {
        return trueExpression.type || falseExpression.type;
    }

    toString(): string {
        return `(${this.condition.toString()} ? ${this.whenTrue.toString()} : ${this.whenFalse.toString()})`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return visitor.visitConditional(this);
    }

    updateConditional(condition: Expression, whenTrue: Expression, whenFalse: Expression): ConditionalExpression {
        if (this.condition === condition && this.whenTrue === whenTrue && this.whenFalse === whenFalse) {
            return this;
        }

        return new ConditionalExpression(condition, whenTrue, whenFalse);
    }
}

export class PropertyExpression extends Expression {
    constructor(
        public readonly object: Expression,
        public readonly propertyName: string,
        public readonly isOptionalChaining: boolean = false
    ) {
        super(".", PropertyExpression.calculateType(object, propertyName));
    }

    private static calculateType(object: Expression, propertyName: string): Type {
        if (object instanceof ObjectExpression)
            return object.properties[propertyName]?.type ?? LiteralType.null;

        return resolveMemberType(object.type, propertyName);
    }

    toString(): string {
        const operatorString = this.isOptionalChaining ? "?. " : ".";

        let baseStr = this.object.toString();
        if (!(
            this.object instanceof ParameterExpression ||
            this.object instanceof ConstantExpression ||
            this.object instanceof PropertyExpression ||
            this.object instanceof CallExpression))
            baseStr = "(" + baseStr + ")";

        return `${baseStr}${operatorString}${this.propertyName}`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return visitor.visitProperty(this);
    }

    updateProperty(object: Expression): PropertyExpression {
        if (this.object === object) {
            return this;
        }

        return new PropertyExpression(object, this.propertyName, this.isOptionalChaining);
    }
}

// A method-call expander (Signum's IMethodExpander.Expand): rewrites a marked method
// call into another source expression during ExpressionSimplifier, before binding.
// `instance` is the receiver (undefined for a static call); `args` are the visited
// arguments (a selector arrives as a LambdaExpression).
export type MethodExpander = (instance: Expression | undefined, args: readonly Expression[]) => Expression;

export class CallExpression extends Expression {
    // Set by fromQuoted when the called method carries a `@methodExpander` — the
    // simplifier invokes it to expand the call before it reaches the binder.
    methodExpander?: MethodExpander;

    constructor(
        public readonly func: Expression,
        public readonly args: readonly Expression[],
        public readonly type: Type,
        public readonly isOptionalChaining: boolean = false
    ) {
        super("()", type);
    }

    toString(): string {
        const operatorString = !this.isOptionalChaining ? "" : "?.";
        const argumentsString = this.args.map(arg => arg.toString()).join(', ');

        var baseStr = this.func.toString();
        if (!(
            this.func instanceof ParameterExpression ||
            this.func instanceof ConstantExpression ||
            this.func instanceof PropertyExpression ||
            this.func instanceof CallExpression))
            baseStr = "(" + baseStr + ")";

        return `${baseStr}${operatorString}(${argumentsString})`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return visitor.visitCall(this);
    }

    updateCall(func: Expression, args: readonly Expression[]): CallExpression {
        if (this.func === func && this.args === args) {
            return this;
        }

        return new CallExpression(func, args, this.type, this.isOptionalChaining);
    }
}

export class ParameterExpression extends Expression {
    constructor(
        public readonly name: string,
        type: Type
    ) {
        super("p", type);
    }

    toString(): string {
        return this.name;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return visitor.visitParameter(this);
    }
}

export class LambdaExpression extends Expression {
    constructor(
        public readonly parameters: ParameterExpression[],
        public readonly body: Expression
    ) {
        super("=>", new FunctionType(undefined, body.type));
    }

    toString(): string {
        const parametersString = this.parameters.map(param => param.toString()).join(', ');
        return `${parametersString} => ${this.body.toString()}`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return visitor.visitLambda(this);
    }

    updateLambda(parameters: ParameterExpression[], body: Expression): LambdaExpression {
        if ((this.parameters === parameters || this.parameters.length == parameters.length && this.parameters.every((param, index) => param === parameters[index]))
            && this.body === body) {
            return this;
        }

        return new LambdaExpression(parameters, body);
    }
}

export class ObjectExpression extends Expression {
    constructor(
        public readonly properties: Readonly<Record<string, Expression>>,
        // When set (via a `Ctor.create({ … })` projection over a `View` subclass) the
        // projector materialises `Ctor.create({ … })` per row instead of a plain object
        // literal — so a query can build typed instances (e.g. DiffTable / DiffColumn).
        public readonly ctor?: Function,
    ) {
        var type = new ObjectType(Object.fromEntries(Object.entries(properties).map(([name, exp]) => [name, exp.type])));

        super("{}", type);
    }

    toString(): string {
        const propertiesString = Object.entries(this.properties)
            .map(([name, value]) => `${name}: ${value.toString()}`)
            .join(',\n');

        return `${this.ctor?.name ?? ""}{\n${propertiesString}\n}`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return visitor.visitObject(this);
    }

    updateObject(properties: Record<string, Expression>): ObjectExpression {
        if (this.properties === properties) {
            return this;
        }

        return new ObjectExpression(properties, this.ctor);
    }
}

export class NewExpression extends Expression {
    constructor(
        public readonly constructorFunction: Function,
        public readonly args: ReadonlyArray<Expression>
    ) {
        super("new", new ClassType(constructorFunction));
    }

    toString(): string {
        const argumentsString = this.args.map(arg => arg.toString()).join(', ');
        return `new ${this.constructorFunction.toString()}(${argumentsString})`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return visitor.visitNew(this);
    }

    updateNew(args: ReadonlyArray<Expression>): NewExpression {
        if (this.args === args) {
            return this;
        }

        return new NewExpression(this.constructorFunction, args);
    }
}

// `x as T` cast. The target type comes from the quoted name string: primitive
// keywords map to LiteralType; an entity/embedded name resolves to a ClassType
// via the registry. The binder uses this to re-type a value and to narrow a
// polymorphic reference (ImplementedBy/ImplementedByAll).
export class CastExpression extends Expression {
    constructor(
        public readonly expression: Expression,
        type: Type,
    ) {
        super("as", type);
    }

    toString(): string {
        return `(${this.expression.toString()} as ${this.type.constructor.name})`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return visitor.visitCast(this);
    }

    updateCast(expression: Expression): CastExpression {
        if (this.expression === expression)
            return this;
        return new CastExpression(expression, this.type);
    }
}

function resolveCastType(name: string): Type {
    switch (name) {
        case "number": return LiteralType.number;
        case "string": return LiteralType.string;
        case "boolean": return LiteralType.boolean;
    }
    const ctor = resolveType(name);
    return ctor != null ? new ClassType(ctor) : LiteralType.null;
}

function getType(object: Expression, propertyName: string): Type {
    throw new Error("Function not implemented.");
}
