import {
    Expression, BinaryExpression, UnaryExpression, ConditionalExpression,
    ConstantExpression, CastExpression, ObjectExpression,
} from "../expressions";
import {
    ProjectionExpression, ColumnExpression, PrimaryKeyExpression, UniqueFunction,
    EntityExpression, EmbeddedEntityExpression,
} from "../expressions.sql";
import { QueryFormatter } from "./queryFormatter";
import { Connector } from "../connection/connector";
import { Entity, BaseEntity, PrimaryKey } from "../../entities/entity";
import { cleanModified } from "../../entities/changes";
import { ClassType, Type } from "../../entities/types";

// Port of Signum's TranslatorBuilder + TranslateResult + ProjectionReader.
// Formats the SQL and compiles the projector into a `(row, retriever) => T`
// function via codegen (`new Function`). Rows are objects keyed by SELECT column
// alias; a ColumnExpression reads `row["<name>"]`. Entity/embedded nodes generate
// calls into the Retriever, which constructs instances, caches by (type,id), and
// takes the clean change-tracking snapshot on load (the Phase-C "retrieve" half).

// The IRetriever surface the generated code targets.
class Retriever {
    private readonly cache = new Map<string, Entity>();

    // Build-or-reuse a fully-populated entity. `populate` sets the row's columns
    // (and nested references) before the clean snapshot is taken.
    entity(ctor: new () => Entity, id: PrimaryKey | null, populate: (e: any) => void): Entity | null {
        if (id == null) return null;
        const key = ctor.name + ":" + id;
        let e = this.cache.get(key);
        if (e == null) {
            e = new ctor();
            (e as any).id = id;
            e.isNew = false;
            this.cache.set(key, e);
            populate(e);
            cleanModified(e);
        }
        return e;
    }

    // A referenced entity known only by id (no columns loaded). Deferred batch
    // completion is a later step; for now it's an id-only instance.
    stub(ctor: new () => Entity, id: PrimaryKey | null): Entity | null {
        if (id == null) return null;
        const key = ctor.name + ":" + id;
        let e = this.cache.get(key);
        if (e == null) {
            e = new ctor();
            (e as any).id = id;
            e.isNew = false;
            cleanModified(e);
            this.cache.set(key, e);
        }
        return e;
    }

    // An embedded value (no identity / no cache). The parent's snapshot inlines it.
    embedded(ctor: new () => BaseEntity, populate: (e: any) => void): BaseEntity {
        const e = new ctor();
        populate(e);
        cleanModified(e);
        return e;
    }
}

export class TranslateResult {
    constructor(
        public readonly sql: string,
        public readonly parameters: unknown[],
        private readonly projector: (row: any, retriever: Retriever) => unknown,
        private readonly uniqueFunction: UniqueFunction | undefined,
    ) { }

    async execute(): Promise<unknown> {
        const rows = await Connector.current().executeQuery(this.sql, this.parameters);
        const retriever = new Retriever();
        const list = rows.map(r => this.projector(r, retriever));
        return this.uniqueFunction != null ? applyUnique(list, this.uniqueFunction) : list;
    }
}

export function buildTranslateResult(projection: ProjectionExpression, isPostgres: boolean): TranslateResult {
    const { sql, parameters } = QueryFormatter.format(projection.select, isPostgres);
    const projector = compileProjector(projection.projector);
    return new TranslateResult(sql, parameters, projector, projection.uniqueFunction);
}

function ctorOf(type: Type): new () => any {
    if (type instanceof ClassType)
        return type.constructorFunction as new () => any;
    throw new Error("Cannot materialise a value of non-class type: " + type.constructor.name);
}

// Generates a `(row, consts, retriever) => value` body and closes it over the
// captured constants/ctors. Entity & embedded nodes emit Retriever calls with an
// inline populate function; scalars/objects read straight off the row.
function compileProjector(projector: Expression): (row: any, retriever: Retriever) => unknown {
    const consts: unknown[] = [];
    const pushConst = (v: unknown): number => (consts.push(v), consts.length - 1);

    function emit(e: Expression): string {
        if (e instanceof ColumnExpression)
            return `row[${JSON.stringify(e.name)}]`;

        if (e instanceof PrimaryKeyExpression)
            return emit(e.value);

        if (e instanceof EntityExpression) {
            const ci = pushConst(ctorOf(e.type));
            const idCode = emit(e.externalId.value);
            if (e.bindings == null)
                return `retriever.stub(consts[${ci}], ${idCode})`;
            const assigns: string[] = [];
            for (const b of e.bindings)
                assigns.push(`e[${JSON.stringify(b.fieldInfo.name)}] = ${emit(b.binding)};`);
            for (const m of e.mixins ?? [])
                for (const b of m.bindings)
                    assigns.push(`e[${JSON.stringify(b.fieldInfo.name)}] = ${emit(b.binding)};`);
            return `retriever.entity(consts[${ci}], ${idCode}, function(e){ ${assigns.join(" ")} })`;
        }

        if (e instanceof EmbeddedEntityExpression) {
            const ci = pushConst(ctorOf(e.type));
            const assigns = e.bindings
                .map(b => `e[${JSON.stringify(b.fieldInfo.name)}] = ${emit(b.binding)};`)
                .join(" ");
            return `(${emit(e.hasValue)} ? retriever.embedded(consts[${ci}], function(e){ ${assigns} }) : null)`;
        }

        if (e instanceof ObjectExpression) {
            const props = Object.entries(e.properties)
                .map(([k, v]) => `${JSON.stringify(k)}: ${emit(v)}`)
                .join(", ");
            return `({ ${props} })`;
        }

        if (e instanceof ConstantExpression)
            return `consts[${pushConst(e.value)}]`;

        if (e instanceof ConditionalExpression)
            return `(${emit(e.condition)} ? ${emit(e.whenTrue)} : ${emit(e.whenFalse)})`;

        if (e instanceof CastExpression)
            return emit(e.expression);

        if (e instanceof UnaryExpression) {
            const op = e.kind === "-u" ? "-" : e.kind === "+u" ? "+" : e.kind === "!" ? "!" : "~";
            return `(${op}${emit(e.expression)})`;
        }

        if (e instanceof BinaryExpression)
            return `(${emit(e.left)} ${jsOperator(e.kind)} ${emit(e.right)})`;

        throw new Error("Unsupported projector node: " + e.kind + " — " + e.toString());
    }

    const body = "return " + emit(projector) + ";";
    const fn = new Function("row", "consts", "retriever", body) as
        (row: any, consts: unknown[], retriever: Retriever) => unknown;
    return (row: any, retriever: Retriever) => fn(row, consts, retriever);
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
