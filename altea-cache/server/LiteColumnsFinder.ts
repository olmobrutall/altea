import type { Entity, Type } from "@altea/altea/data/entity";
import { getCustomLiteConstructor, getCustomLiteConstructorFor, type CustomLiteClass } from "@altea/altea/data/lite";
import type { Lite } from "@altea/altea/data/lite";
import type { Quoted } from "quote-transformer/quoted";
import { CallExpression, Expression, ParameterExpression, PropertyExpression } from "@altea/altea/server/linq/expressions";
import { ExpressionVisitor } from "@altea/altea/server/linq/visitors/ExpressionVisitor";
import { ClassType } from "@altea/altea/server/runtimeTypes";
import type { IColumn } from "@altea/altea/server/schema/column";
import {
    FieldEntityArray, FieldEnum, FieldImplementedBy, FieldImplementedByAll, FieldPrimaryKey,
    FieldReference, FieldValue,
} from "@altea/altea/server/schema/field";
import type { Table } from "@altea/altea/server/schema/table";

// Port of Signum's ToStringColumnsFinderVisitor (CachedTableLite.cs) + the role its
// LiteModelExpressionVisitor plays: work out the MINIMUM set of columns needed to build the `Lite<T>` of a
// SEMI-cached type, and how to build it from those columns alone.
//
// Why it matters (this is the whole point of the semi-cached table): a cached `Country` may reference
// `Lite<Person>`, and Person is Transactional — far too volatile and far too large to cache. Caching the
// whole Person row instead would also drag in whatever Person references, and so on transitively, which
// ends with most of the database in memory. So only the columns the LITE needs, for only the rows actually
// referenced, are held.
//
// altea divergence: Signum walks the lite MODEL expression (`Lite.GetModelConstructorExpression`) and
// rewrites it to read the cached tuple. altea's equivalent of a lite model is a CUSTOM LITE — a
// `registerCustomLite(T, LiteClass, e => new LiteClass(e.id, e.toString(), e.firstName, …))` whose
// `fromEntity` is a `Quoted` lambda, i.e. a real JS function that ALSO carries its expression tree. So the
// tree is walked here for the column set, and at read time the function itself is applied to a PARTIAL
// entity carrying exactly those columns — no expression rewriting, and the lite comes out of the same code
// a query would run.

export interface LiteColumnsPlan {
    /** The columns to SELECT (the primary key is added by the caller). */
    readonly columns: IColumn[];
    /** True when the display string comes from the `ToStr` COLUMN (a hand-written, untranslatable
     *  `toString()`), in which case the partial entity's `toString` is overridden with the cached value —
     *  Signum's LiteModelExpressionVisitor substitutes the ToStr column for the `ToString()` call. */
    readonly usesToStrColumn: boolean;
    /** Builds the lite from a partial entity carrying `columns` (+ the id, + the toString override). */
    readonly build: (entity: Entity) => Lite<Entity>;
}

// Signum's `Lite.GetModelConstructorExpression(type, modelType)` — which builder produces this reference's
// lite: the FIELD's own `@customLite` when it declares one (Signum's `column.CustomLiteModelType`), else the
// type's default custom lite, else the plain `toLite()` (id + `toString()`).
export function liteBuilderFor(type: Type<Entity>, fieldCustomLite: CustomLiteClass | undefined): Quoted<(e: any) => Lite<Entity>> | undefined {
    if (fieldCustomLite != null)
        return getCustomLiteConstructorFor(type as Type<Entity>, fieldCustomLite) as Quoted<(e: any) => Lite<Entity>> | undefined;
    return getCustomLiteConstructor(type as Type<Entity>) as Quoted<(e: any) => Lite<Entity>> | undefined;
}

// The plan for one semi-cached reference: which columns, and how to turn them into a lite.
export function planLiteColumns(type: Type<Entity>, table: Table, fieldCustomLite: CustomLiteClass | undefined): LiteColumnsPlan {
    const builder = liteBuilderFor(type, fieldCustomLite);
    const finder = new LiteColumnsFinder(table, type);

    if (builder != null) {
        // A custom lite: walk its `fromEntity` lambda. `fromQuotedLambda` INLINES any `@quoted` method it
        // calls (including a `@quoted toString()`), so what the visitor sees is already expanded down to
        // member accesses on the parameter.
        const lambda = Expression.fromQuotedLambda(builder, [new ClassType(type)]);
        finder.gather(lambda.body, lambda.parameters[0]);
        return { columns: finder.columns(), usesToStrColumn: finder.usesToStr, build: e => builder(e) };
    }

    // No custom lite: the lite is `toLite()` = id + `toString()`, so only what `toString()` reads is needed.
    finder.gatherToString();
    return { columns: finder.columns(), usesToStrColumn: finder.usesToStr, build: e => e.toLite() };
}

// Walks a lite-building expression and collects the columns it reads off the entity. Deliberately STRICT:
// anything it cannot satisfy from this table's own columns throws HERE — at startup, while the cached
// table is being built — rather than silently producing a lite with a missing display string.
class LiteColumnsFinder extends ExpressionVisitor {
    private readonly found = new Set<IColumn>();
    usesToStr = false;
    private param: ParameterExpression | undefined;

    constructor(private readonly table: Table, private readonly type: Type<Entity>) {
        super();
    }

    columns(): IColumn[] {
        return [...this.found];
    }

    gather(body: Expression, param: ParameterExpression): void {
        this.param = param;
        this.visit(body);
    }

    // The columns `toString()` reads: the ToStr COLUMN when the method is hand-written (which is exactly
    // when the schema builder materialises that column), else the members its `@quoted` body reads.
    gatherToString(): void {
        if (this.table.toStrColumn != null) {
            this.found.add(this.table.toStrColumn);
            this.usesToStr = true;
            return;
        }
        const toString = (this.type.prototype as { toString: Quoted<() => string> }).toString;
        if (toString.__quoted == null)
            throw new Error(this.unsupported(`${this.type.name}.toString() is neither '@quoted' nor backed by a ToStr column`));
        // A method's quoted lambda takes the receiver as its first parameter.
        const lambda = Expression.fromQuotedLambda(toString, [new ClassType(this.type)]);
        const previous = this.param;
        this.param = lambda.parameters[0];
        this.visit(lambda.body);
        this.param = previous;
    }

    override visitProperty(node: PropertyExpression): Expression {
        if (node.object === this.param) {
            this.addField(node.propertyName);
            return node;
        }

        // A member reached THROUGH a member of the entity. Checked at any depth (`e.city.name` and
        // `e.city.country.name` are equally impossible), because what matters is the member the chain
        // starts at: if that one is a plain VALUE the rest is in-memory JS on the loaded value
        // (`e.name.length`, `e.date.year`), but if it is a REFERENCE or a collection the chain needs a row
        // this table must not hold — the whole reason semi-caching exists.
        const root = this.rootMemberOfParam(node.object);
        if (root != null) {
            const field = this.fieldNamed(root);
            if (field instanceof FieldReference || field instanceof FieldImplementedBy
                || field instanceof FieldImplementedByAll || field instanceof FieldEntityArray)
                throw new Error(this.unsupported(`it reads through the reference '${root}' ('${root}…${node.propertyName}')`));
            this.addField(root);            // a value: gather it; the rest is in-memory JS on the value
            return node;                    // and do NOT descend — it is already accounted for
        }

        return super.visitProperty(node);
    }

    // The member name a chain of property accesses starts at, when it roots at the lambda's parameter
    // (`e.a.b.c` → "a"); undefined for anything else (a constant, a captured variable, a call result).
    private rootMemberOfParam(node: Expression): string | undefined {
        let current = node;
        let name: string | undefined;
        while (current instanceof PropertyExpression) {
            name = current.propertyName;
            current = current.object;
        }
        return current === this.param ? name : undefined;
    }

    override visitCall(node: CallExpression): Expression {
        // `e.toString()` that survived inlining is a hand-written method → the ToStr column stands in for it
        // (Signum's VisitMethodCall does exactly this).
        if (node.func instanceof PropertyExpression && node.func.object === this.param && node.func.propertyName === "toString") {
            this.gatherToString();
            return node;
        }
        // Any other unexpanded method ON THE ENTITY cannot be evaluated from columns: an expression member
        // would have been inlined by fromQuotedLambda, so this is a real (untranslated) method.
        if (node.func instanceof PropertyExpression && node.func.object === this.param)
            throw new Error(this.unsupported(`it calls '${node.func.propertyName}()', which is neither '@quoted' nor a column`));

        return super.visitCall(node);
    }

    // The mapped field of a member name (own or mixin) — mixin fields are addressed by their bare name,
    // as everywhere else in altea.
    private fieldNamed(name: string): unknown {
        return (this.table.fields[name] ?? this.findMixinField(name))?.field;
    }

    private addField(name: string): void {
        const field = this.fieldNamed(name);
        if (field == null)
            throw new Error(this.unsupported(`'${name}' is not a mapped field`));
        // Signum's GetColumn: only a primary key / value / ticks / reference field IS a column. A reference
        // is accepted as the raw FK column — reading the id is fine, navigating INTO it is not (above).
        if (field instanceof FieldPrimaryKey) { this.found.add(field.column); return; }
        // FieldEnum extends FieldReference, FieldTicks extends FieldValue — both are single columns.
        if (field instanceof FieldEnum) { this.found.add(field.column); return; }
        if (field instanceof FieldValue) { this.found.add(field.column); return; }
        // A reference read as a whole (`e.city` passed to the lite, never navigated) is its FK column — the
        // id is all a lite could carry anyway. Navigating INTO it was already refused above.
        if (field instanceof FieldReference) { this.found.add(field.column); return; }
        throw new Error(this.unsupported(`'${name}' maps to a ${field.constructor.name}, not to a single column`));
    }

    private findMixinField(name: string): { field: unknown } | undefined {
        for (const mixin of Object.values(this.table.mixins))
            if (mixin.fields[name] != null)
                return mixin.fields[name] as unknown as { field: unknown };
        return undefined;
    }

    private unsupported(reason: string): string {
        return `Cannot cache the Lite of '${this.type.name}' (referenced by a cached type, so only its display ` +
            `columns are held): ${reason}. Keep its toString() / custom lite over its OWN columns, or make the ` +
            `referencing type not cached.`;
    }
}
