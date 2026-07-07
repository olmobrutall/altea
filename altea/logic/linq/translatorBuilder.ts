import {
    Expression, BinaryExpression, UnaryExpression, ConditionalExpression,
    ConstantExpression, CastExpression, ObjectExpression,
} from "./expressions";
import {
    ProjectionExpression, ColumnExpression, PrimaryKeyExpression, UniqueFunction,
    EntityExpression, EmbeddedEntityExpression, MixinEntityExpression, LiteReferenceExpression, LiteValueExpression,
    ChildProjectionExpression, LookupToken,
    ImplementedByExpression, ImplementedByAllExpression,
    TypeEntityExpression, TypeImplementedByExpression, TypeImplementedByAllExpression,
    ToDayOfWeekExpression, SqlConstantExpression,
} from "./expressions.sql";
import { QueryFormatter } from "./queryFormatter";
import { Connector } from "../connection/connector";
import { ClassType, LiteralType, TemporalType, Type } from "../../entities/types";
import { Retriever } from "./Retriever";
import { DbExpressionVisitor } from "./visitors/DbExpressionVisitor";
import { denormalizeTemporal } from "../normalizeScalar";
import { ProjectionError } from "./ProjectionError";

// A lookup maps a serialised correlation key to the child values for that key (eager
// children, prefilled before projection — Signum's Lookup).
type Lookups = Map<LookupToken, Map<string, unknown[]>>;
// A request registry maps a serialised correlation key to the (single) array a lazy MList
// child will fill after the main query. The projector both registers and returns it, so the
// array placed in the entity is the one mutated on fill (Signum's LookupRequest).
type Requests = Map<LookupToken, Map<string, unknown[]>>;
type CompiledProjector = (row: any, retriever: Retriever, lookups: Lookups, requests: Requests) => unknown;

// A flattened child query: its own SQL plus a projector yielding {k, v} rows that
// are grouped by k into a lookup keyed by `token`.
interface ChildPlan {
    readonly token: LookupToken;
    readonly sql: string;
    readonly parameters: unknown[];
    readonly kvProjector: CompiledProjector;
    readonly projectorSource: string;
}

export class TranslateResult {
    constructor(
        public readonly sql: string,
        public readonly parameters: unknown[],
        private readonly projector: CompiledProjector,
        private readonly projectorSource: string,
        private readonly uniqueFunction: UniqueFunction | undefined,
        // Eager children (explicitly projected collections) are filled before the main
        // query, deepest-first; lazy children (entity MLists) after it, shallowest-first.
        // Signum's TranslateResult.{EagerProjections, LazyChildProjections}.
        // TODO(remove-eager): in TypeScript every collection is a plain array we can fill
        // after the fact, so *all* child projections could be lazy (skip-when-empty) and the
        // eager path deleted. Kept for now only so the generated SQL matches Signum's Eager/
        // Lazy split for the sqlcmp comparison; collapse to lazy-only once that's no longer
        // needed. See LINQ-Plan.md.
        private readonly eagerChildren: readonly ChildPlan[],
        private readonly lazyChildren: readonly ChildPlan[],
    ) { }

    async execute(): Promise<unknown> {
        const retriever = new Retriever();
        const result = await this.executeInto(retriever);
        // Batch-complete any referenced rows left as id-only stubs (IBA/cycle/AvoidExpand),
        // then the projected instances are fully loaded — Signum's Retriever.CompleteAll.
        await retriever.completeAll();
        return result;
    }

    // Read and project this query's rows into the given retriever's identity map, without
    // creating a new retriever or running completion (the caller's completeAll drives it).
    // Used both by execute() and by the batch retrieve in Retriever.completeAll.
    async executeInto(retriever: Retriever): Promise<unknown> {
        const connector = Connector.current();
        const lookups: Lookups = new Map();
        const requests: Requests = new Map();

        // Eager child projections first, deepest-first, unconditionally (Signum's
        // EagerProjections): an explicitly projected collection has no entity to defer
        // into, so it is prefilled into a lookup the projector reads.
        for (const child of this.eagerChildren) {
            const childRows = await connector.executeQuery(child.sql, child.parameters);
            const map = new Map<string, unknown[]>();
            childRows.forEach((r, i) => {
                const kv = projectRow(child.kvProjector, r, i, child.sql, child.projectorSource, retriever, lookups, requests) as { k: unknown; v: unknown };
                const keyStr = JSON.stringify(kv.k ?? null);
                const bucket = map.get(keyStr);
                if (bucket != null) bucket.push(kv.v);
                else map.set(keyStr, [kv.v]);
            });
            lookups.set(child.token, map);
        }

        // Main query. For each entity MList it materialises, the projector places an empty
        // array in the entity and registers it in `requests` under the parent key.
        const rows = await connector.executeQuery(this.sql, this.parameters);
        const list = rows.map((r, i) => projectRow(this.projector, r, i, this.sql, this.projectorSource, retriever, lookups, requests));

        // Lazy child projections after the main query, shallowest-first (Signum's
        // LazyChildProjections). Each is SKIPPED when no parent registered a request — so
        // `table(Order).filter(() => false)` never queries order lines, at any level.
        // Filling a level materialises its element entities, which register the next
        // level's requests; shallowest-first guarantees they exist before that level fills.
        let filledAny = false;
        for (const child of this.lazyChildren) {
            const req = requests.get(child.token);
            if (req == null || req.size === 0)
                continue;
            filledAny = true;
            const childRows = await connector.executeQuery(child.sql, child.parameters);
            const grouped = new Map<string, unknown[]>();
            childRows.forEach((r, i) => {
                const kv = projectRow(child.kvProjector, r, i, child.sql, child.projectorSource, retriever, lookups, requests) as { k: unknown; v: unknown };
                const keyStr = JSON.stringify(kv.k ?? null);
                const bucket = grouped.get(keyStr);
                if (bucket != null) bucket.push(kv.v);
                else grouped.set(keyStr, [kv.v]);
            });
            // Fill each registered array in place (identity is what the entity holds).
            for (const [keyStr, arr] of req) {
                const vals = grouped.get(keyStr);
                if (vals != null)
                    for (const v of vals) arr.push(v);
            }
        }

        // Collections were mutated after their owners' snapshots were taken; refresh them so
        // a freshly-retrieved entity isn't reported dirty (Signum's ModifiablePostRetrieving).
        if (filledAny)
            retriever.reclean();

        return this.uniqueFunction != null ? applyUnique(list, this.uniqueFunction) : list;
    }
}

// Project one row, wrapping any failure in a FieldReaderError enriched with the row index,
// SQL command and projector source (Signum's TranslateResult per-row catch).
function projectRow(project: CompiledProjector, row: any, rowIndex: number, sql: string, projectorSource: string,
    retriever: Retriever, lookups: Lookups, requests: Requests): unknown {
    try {
        return project(row, retriever, lookups, requests);
    } catch (error) {
        throw new ProjectionError(error).enrich({ rowIndex, sql, projector: projectorSource });
    }
}

export function buildTranslateResult(projection: ProjectionExpression, isPostgres: boolean): TranslateResult {
    const build = (cp: ChildProjectionExpression): ChildPlan => {
        const { sql, parameters } = QueryFormatter.format(cp.projection.select, isPostgres);
        const { project, source } = compileProjector(cp.projection.projector);
        return { token: cp.token, sql, parameters, kvProjector: project, projectorSource: source };
    };
    const eagerChildren = gatherChildProjections(projection.projector, false).map(build);
    const lazyChildren = gatherChildProjections(projection.projector, true).map(build);
    const { sql, parameters } = QueryFormatter.format(projection.select, isPostgres);
    const { project, source } = compileProjector(projection.projector);
    return new TranslateResult(sql, parameters, project, source,
        projection.uniqueFunction, eagerChildren, lazyChildren);
}

// Collects the ChildProjectionExpressions of one kind. Eager (isLazyMList false) are
// gathered deepest-first (post-order) so a nested child's lookup fills before the child
// that reads it; lazy MLists are gathered shallowest-first (pre-order) so a parent level
// fills (registering the next level's requests) before that level. Mirrors Signum's
// Eager/LazyChildProjectionGatherer.
function gatherChildProjections(projector: Expression, lazy: boolean): ChildProjectionExpression[] {
    const result: ChildProjectionExpression[] = [];
    const gatherer = new (class extends DbExpressionVisitor {
        override visitChildProjection(child: ChildProjectionExpression): Expression {
            if (lazy && child.isLazyMList)
                result.push(child);
            this.visit(child.projection.projector);
            if (!lazy && !child.isLazyMList)
                result.push(child);
            return child;
        }
    })();
    gatherer.visit(projector);
    return result;
}

function ctorOf(type: Type): new () => any {
    if (type instanceof ClassType)
        return type.constructorFunction as new () => any;
    throw new Error("Cannot materialise a value of non-class type: " + type.constructor.name);
}

// Generates a `(row, consts, retriever, lookups) => value` body and closes it over
// the captured constants/ctors. Entity/embedded/lite nodes emit Retriever calls;
// a ChildProjection reads its grouped slice out of `lookups`.
function compileProjector(projector: Expression): { project: CompiledProjector; source: string } {
    const builder = new ProjectionBuilder();
    const body = "return " + builder.build(projector) + ";";
    const fn = new Function("row", "consts", "retriever", "lookups", "requests", body) as
        (row: any, consts: unknown[], retriever: Retriever, lookups: Lookups, requests: Requests) => unknown;
    const project = (row: any, retriever: Retriever, lookups: Lookups, requests: Requests) => fn(row, builder.consts, retriever, lookups, requests);
    return { project, source: body };
}

// Normalises a raw SQL Server DATEPART(weekday) value to the ISO day-of-week (Mon=1..Sun=7)
// using the session's DATEFIRST, read from the current connector at projection time — the
// client half of ToDayOfWeekExpression (Signum's ToDayOfWeekSql). Postgres never hits this
// (its EXTRACT(isodow) is already ISO).
function toDayOfWeekIsoFromSqlServer(raw: number | null): number | null {
    if (raw == null) return null;
    const dateFirst = Connector.current().dateFirst ?? 7;
    return ((raw + dateFirst + 5) % 7) + 1;
}

// Registers (or reuses) the array a lazy MList child fills after the main query. One array
// per parent key — the same reference is placed in the entity and mutated on fill. Signum's
// IProjectionRow.LookupRequest.
function lazyRequestArray(requests: Requests, token: LookupToken, keyStr: string): unknown[] {
    let byKey = requests.get(token);
    if (byKey == null) { byKey = new Map(); requests.set(token, byKey); }
    let arr = byKey.get(keyStr);
    if (arr == null) { arr = []; byKey.set(keyStr, arr); }
    return arr;
}

class ProjectionBuilder extends DbExpressionVisitor {
    readonly consts: unknown[] = [];
    private readonly stack: string[] = [];

    build(expression: Expression): string {
        this.visit(expression);
        const result = this.pop();
        if (this.stack.length)
            throw new Error("ProjectionBuilder left extra expressions on the stack");
        return result;
    }

    private pushConst(value: unknown): number {
        this.consts.push(value);
        return this.consts.length - 1;
    }

    private pop(): string {
        const result = this.stack.pop();
        if (result == null)
            throw new Error("ProjectionBuilder stack underflow");
        return result;
    }

    override visitColumn(e: ColumnExpression): Expression {
        const read = `row[${JSON.stringify(e.name)}]`;
        // A temporal column is materialised into its declared Temporal type (the driver
        // hands back a string/Date) — mirrors Signum reading DateTime/DateOnly/TimeSpan.
        // A malformed driver value the Temporal parser rejects surfaces as a FieldReaderError
        // via the row loop (see projectRow).
        if (e.type instanceof TemporalType) {
            const fnIndex = this.pushConst(denormalizeTemporal);
            this.stack.push(`consts[${fnIndex}](${read}, ${JSON.stringify(e.type.kind)})`);
        } else if (e.type === LiteralType.boolean) {
            // A boolean aggregate/scalar comes back as an int on SQL Server (the CASE …
            // THEN 1 ELSE 0 an Any/All/`==` lowers to), so coerce a non-null read to a JS
            // boolean — mirrors Signum reading a bit column into a CLR bool. Postgres
            // already yields true/false, for which `!!` is a no-op; a nullable column's
            // null is preserved.
            this.stack.push(`(${read} == null ? null : !!${read})`);
        } else {
            this.stack.push(read);
        }
        return e;
    }

    override visitPrimaryKey(e: PrimaryKeyExpression): Expression {
        this.visit(e.value);
        return e;
    }

    override visitEntity(e: EntityExpression): Expression {
        const ctorIndex = this.pushConst(ctorOf(e.type));
        this.visit(e.externalId.value);
        const idCode = this.pop();

        if (e.bindings == null) {
            this.stack.push(`retriever.stub(consts[${ctorIndex}], ${idCode})`);
            return e;
        }

        const assigns: string[] = [];
        for (const b of e.bindings) {
            this.visit(b.binding);
            assigns.push(`e[${JSON.stringify(b.fieldInfo.name)}] = ${this.pop()};`);
        }
        for (const m of e.mixins ?? [])
            for (const b of m.bindings) {
                this.visit(b.binding);
                assigns.push(`e[${JSON.stringify(b.fieldInfo.name)}] = ${this.pop()};`);
            }

        this.stack.push(`retriever.entity(consts[${ctorIndex}], ${idCode}, function(e){ ${assigns.join(" ")} })`);
        return e;
    }

    override visitChildProjection(e: ChildProjectionExpression): Expression {
        const tokenIndex = this.pushConst(e.token);
        this.visit(e.outerKey);
        const keyCode = this.pop();
        const keyStr = `JSON.stringify(${keyCode} ?? null)`;

        // A lazy MList: register (and return) the array this parent's collection will get,
        // to be filled after the main query. Same array reference the entity keeps.
        if (e.isLazyMList) {
            const fnIndex = this.pushConst(lazyRequestArray);
            this.stack.push(`consts[${fnIndex}](requests, consts[${tokenIndex}], ${keyStr})`);
            return e;
        }

        // Eager: the child rows for this parent's key (already grouped during fill).
        const listCode = `((lookups.get(consts[${tokenIndex}]) || new Map()).get(${keyStr}) || [])`;
        // A single-result child (first/single) yields the element; a list child
        // (toArray) yields the whole slice.
        this.stack.push(e.projection.uniqueFunction != null ? `(${listCode}[0] ?? null)` : listCode);
        return e;
    }

    override visitLiteReference(e: LiteReferenceExpression): Expression {
        let toStrCode = "null";
        if (e.toStr != null) {
            this.visit(e.toStr);
            toStrCode = this.pop();
        }

        const ref = e.reference;

        // Lite over @implementedByAll: resolve the type discriminator → ctor by id.
        if (ref instanceof ImplementedByAllExpression) {
            const idCode = this.ibaIdCode(ref);
            this.visit(ref.typeId.typeColumn);
            const typeCode = this.pop();
            this.stack.push(`retriever.liteImplementedByAll(${idCode}, ${typeCode}, ${toStrCode})`);
            return e;
        }

        // Lite over @implementedBy: whichever implementation id column is non-null.
        if (ref instanceof ImplementedByExpression) {
            this.stack.push(this.implementedByChain(ref, (ctorIndex, idCode) =>
                `retriever.lite(consts[${ctorIndex}], ${idCode}, ${toStrCode})`));
            return e;
        }

        // Lite over a typed reference.
        const ctorIndex = this.pushConst(ctorOf(ref.type));
        this.visit(ref.externalId.value);
        const idCode = this.pop();
        this.stack.push(`retriever.lite(consts[${ctorIndex}], ${idCode}, ${toStrCode})`);
        return e;
    }

    // The reduced lite (Signum's LiteValueExpression) — read straight from its identity
    // (typeId + id) and display string, no entity reference. Mirrors visitLiteReference's
    // three cases, but keyed on the type-discriminator expression rather than the wrapped
    // reference, and using the single coalesced id column.
    override visitLiteValue(e: LiteValueExpression): Expression {
        let toStrCode = "null";
        if (e.toStr != null) {
            this.visit(e.toStr);
            toStrCode = this.pop();
        }

        this.visit(e.id);
        const idCode = this.pop();

        const typeId = e.typeId;

        // Lite over @implementedByAll: resolve the type discriminator → ctor by id.
        if (typeId instanceof TypeImplementedByAllExpression) {
            this.visit(typeId.typeColumn);
            const typeCode = this.pop();
            this.stack.push(`retriever.liteImplementedByAll(${idCode}, ${typeCode}, ${toStrCode})`);
            return e;
        }

        // Lite over @implementedBy: whichever implementation id column is non-null picks
        // the ctor; the lite is built with the coalesced id (equal to that column) and that
        // implementation's own display model (Signum's per-type Models) — dispatched here
        // client-side rather than as a SQL CASE.
        if (typeId instanceof TypeImplementedByExpression) {
            let code = "null";
            const entries = [...typeId.typeImplementations];
            for (let i = entries.length - 1; i >= 0; i--) {
                const [ctor, implId] = entries[i];
                const ctorIndex = this.pushConst(ctor);
                this.visit(implId.value);
                const implIdCode = this.pop();
                let modelCode = toStrCode;
                const model = e.models?.get(ctor);
                if (model != null) {
                    this.visit(model);
                    modelCode = this.pop();
                }
                code = `(${implIdCode} != null ? retriever.lite(consts[${ctorIndex}], ${idCode}, ${modelCode}) : ${code})`;
            }
            this.stack.push(code);
            return e;
        }

        // Lite over a typed reference.
        const te = typeId as TypeEntityExpression;
        const ctorIndex = this.pushConst(ctorOf(te.typeValue));
        this.stack.push(`retriever.lite(consts[${ctorIndex}], ${idCode}, ${toStrCode})`);
        return e;
    }

    override visitImplementedBy(e: ImplementedByExpression): Expression {
        this.stack.push(this.implementedByChain(e, (ctorIndex, idCode) =>
            `retriever.stub(consts[${ctorIndex}], ${idCode})`));
        return e;
    }

    // The @implementedByAll id, coalesced client-side over the per-PK-type columns (only
    // one is non-null) — Signum coalesces in the projector too, preserving the native type.
    private ibaIdCode(e: ImplementedByAllExpression): string {
        const parts = [...e.ids.values()].map(id => { this.visit(id); return this.pop(); });
        return parts.length === 1 ? parts[0] : `(${parts.join(" ?? ")})`;
    }

    override visitImplementedByAll(e: ImplementedByAllExpression): Expression {
        const idCode = this.ibaIdCode(e);
        this.visit(e.typeId.typeColumn);
        const typeCode = this.pop();
        this.stack.push(`retriever.implementedByAll(${idCode}, ${typeCode})`);
        return e;
    }

    // ---- Type expressions: materialise the constructor (altea's `Type`) -----

    override visitTypeEntity(e: TypeEntityExpression): Expression {
        const ctorIndex = this.pushConst(ctorOf(e.typeValue));
        this.visit(e.externalId.value);
        const idCode = this.pop();
        this.stack.push(`(${idCode} != null ? consts[${ctorIndex}] : null)`);
        return e;
    }

    override visitTypeImplementedBy(e: TypeImplementedByExpression): Expression {
        let code = "null";
        const entries = [...e.typeImplementations];
        for (let i = entries.length - 1; i >= 0; i--) {
            const [ctor, id] = entries[i];
            const ctorIndex = this.pushConst(ctor);
            this.visit(id.value);
            const idCode = this.pop();
            code = `(${idCode} != null ? consts[${ctorIndex}] : ${code})`;
        }
        this.stack.push(code);
        return e;
    }

    override visitTypeImplementedByAll(e: TypeImplementedByAllExpression): Expression {
        this.visit(e.typeColumn);
        const typeCode = this.pop();
        this.stack.push(`retriever.type(${typeCode})`);
        return e;
    }

    // A right-folded chain of `(id != null ? build(ctor, id) : <next>)` over the
    // implementations: the first populated id column wins (at most one ever is).
    // `idCode` is a pure `row[...]` read, so repeating it is safe.
    private implementedByChain(e: ImplementedByExpression, build: (ctorIndex: number, idCode: string) => string): string {
        let code = "null";
        const impls = [...e.implementations.values()];
        for (let i = impls.length - 1; i >= 0; i--) {
            const impl = impls[i];
            const ctorIndex = this.pushConst(ctorOf(impl.type));
            this.visit(impl.externalId.value);
            const idCode = this.pop();
            code = `(${idCode} != null ? ${build(ctorIndex, idCode)} : ${code})`;
        }
        return code;
    }

    // A mixin projected on its own (`map(a => a.mixin(X))`) can't be materialised — a mixin
    // has no identity of its own. (Its fields inside an entity are read directly by
    // visitEntity, never through here.) Signum throws the same way.
    override visitMixinEntity(e: MixinEntityExpression): MixinEntityExpression {
        throw new Error(`Mixins (${e.type}) can't be projected without their main entity.`);
    }

    override visitEmbeddedEntity(e: EmbeddedEntityExpression): Expression {
        const ctorIndex = this.pushConst(ctorOf(e.type));
        this.visit(e.hasValue);
        const hasValue = this.pop();

        const assigns: string[] = [];
        for (const b of e.bindings) {
            this.visit(b.binding);
            assigns.push(`e[${JSON.stringify(b.fieldInfo.name)}] = ${this.pop()};`);
        }

        this.stack.push(`(${hasValue} ? retriever.embedded(consts[${ctorIndex}], function(e){ ${assigns.join(" ")} }) : null)`);
        return e;
    }

    override visitObject(e: ObjectExpression): Expression {
        const props: string[] = [];
        for (const [key, value] of Object.entries(e.properties)) {
            this.visit(value);
            props.push(`${JSON.stringify(key)}: ${this.pop()}`);
        }
        const literal = `{ ${props.join(", ")} }`;
        // `Ctor.create({ … })` (a View subclass) materialises a typed instance per row; a
        // plain object literal otherwise.
        if (e.ctor != null)
            this.stack.push(`consts[${this.pushConst(e.ctor)}].create(${literal})`);
        else
            this.stack.push(`(${literal})`);
        return e;
    }

    override visitConstant(e: ConstantExpression): Expression {
        this.stack.push(`consts[${this.pushConst(e.value)}]`);
        return e;
    }

    override visitConditional(e: ConditionalExpression): Expression {
        this.visit(e.condition);
        const condition = this.pop();
        this.visit(e.whenTrue);
        const whenTrue = this.pop();
        this.visit(e.whenFalse);
        const whenFalse = this.pop();
        this.stack.push(`(${condition} ? ${whenTrue} : ${whenFalse})`);
        return e;
    }

    override visitCast(e: CastExpression): Expression {
        this.visit(e.expression);
        return e;
    }

    // A ToDayOfWeek that reached the projector (SQL Server only — Postgres uses the
    // already-ISO EXTRACT(isodow)): the raw DATEPART(weekday) is a column, so normalise it
    // to the ISO day-of-week here, keeping the DATEFIRST arithmetic out of the SQL. Signum's
    // TranslatorBuilder.VisitToDayOfWeek.
    override visitToDayOfWeek(e: ToDayOfWeekExpression): Expression {
        this.visit(e.expression);
        const rawCode = this.pop();
        const fnIndex = this.pushConst(toDayOfWeekIsoFromSqlServer);
        this.stack.push(`consts[${fnIndex}](${rawCode})`);
        return e;
    }

    override visitUnary(e: UnaryExpression): Expression {
        this.visit(e.expression);
        const op = e.kind === "-u" ? "-" : e.kind === "+u" ? "+" : e.kind === "!" ? "!" : "~";
        this.stack.push(`(${op}${this.pop()})`);
        return e;
    }

    override visitBinary(e: BinaryExpression): Expression {
        this.visit(e.left);
        const left = this.pop();
        this.visit(e.right);
        const right = this.pop();
        this.stack.push(`(${left} ${jsOperator(e.kind)} ${right})`);
        return e;
    }

    // A SQL constant that reached the projector as an operand of a client-side expression
    // (e.g. the literal chunks of a projected string concatenation) — inline its value.
    // Matches Signum's TranslatorBuilder.VisitSqlConstant. CASE / IS NULL never reach the
    // projector: the nominator keeps them (and any concat inside them) as one SQL column.
    override visitSqlConstant(e: SqlConstantExpression): Expression {
        this.stack.push(`consts[${this.pushConst(e.value)}]`);
        return e;
    }
}

function jsOperator(op: string): string {
    if (op === "==" || op === "!=" || op === "===" || op === "!==" ||
        op === "<" || op === "<=" || op === ">" || op === ">=" ||
        op === "+" || op === "-" || op === "*" || op === "/" || op === "%" ||
        op === "&&" || op === "||" || op === "??")
        return op;
    throw new Error("Unsupported projector binary operator: " + op);
}

function applyUnique(list: unknown[], fn: UniqueFunction): unknown {
    switch (fn) {
        case "First":
            if (list.length === 0) throw new Error("Sequence contains no elements");
            return list[0];
        case "FirstOrDefault":
            return list.length === 0 ? null : list[0];
        case "Single":
            if (list.length === 0) throw new Error("Sequence contains no elements");
            if (list.length > 1) throw new Error("Sequence contains more than one element");
            return list[0];
        case "SingleOrDefault":
            if (list.length > 1) throw new Error("Sequence contains more than one element");
            return list.length === 0 ? null : list[0];
    }
}
