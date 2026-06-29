import {
    Expression, BinaryExpression, UnaryExpression, ConditionalExpression,
    ConstantExpression, CastExpression, ObjectExpression,
} from "./expressions";
import {
    ProjectionExpression, ColumnExpression, PrimaryKeyExpression, UniqueFunction,
    EntityExpression, EmbeddedEntityExpression, LiteReferenceExpression,
} from "./expressions.sql";
import { QueryFormatter } from "./queryFormatter";
import { Connector } from "../connection/connector";
import { ClassType, Type } from "../../entities/types";
import { Retriever } from "./Retriever";
import { DbExpressionVisitor } from "./visitors/DbExpressionVisitor";

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
// captured constants/ctors. Entity and embedded nodes emit Retriever calls with
// an inline populate function; scalars/objects read straight off the row.
function compileProjector(projector: Expression): (row: any, retriever: Retriever) => unknown {
    const builder = new ProjectionBuilder();
    const body = "return " + builder.build(projector) + ";";
    const fn = new Function("row", "consts", "retriever", body) as
        (row: any, consts: unknown[], retriever: Retriever) => unknown;
    return (row: any, retriever: Retriever) => fn(row, builder.consts, retriever);
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
        this.stack.push(`row[${JSON.stringify(e.name)}]`);
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

    override visitLiteReference(e: LiteReferenceExpression): Expression {
        const ctorIndex = this.pushConst(ctorOf(e.reference.type));
        this.visit(e.reference.externalId.value);
        const idCode = this.pop();

        let toStrCode = "null";
        if (e.toStr != null) {
            this.visit(e.toStr);
            toStrCode = this.pop();
        }

        this.stack.push(`retriever.lite(consts[${ctorIndex}], ${idCode}, ${toStrCode})`);
        return e;
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
        this.stack.push(`({ ${props.join(", ")} })`);
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
