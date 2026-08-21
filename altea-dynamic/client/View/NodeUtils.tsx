import * as React from "react";
import { globalModules } from "./GlobalModules";
import type { BaseEntity } from "@altea/altea/data/entity";
import { Entity } from "@altea/altea/data/entity";
import { Navigator } from "@altea/altea/client/Navigator";
import type { ViewPromise, ViewOverride } from "@altea/altea/client/EntitySettings";
import { classes, Dic } from "@altea/altea/data/globals";
import { ViewReplacer } from "@altea/altea/client/Frames/ReactVisitor";
import { Binding } from "@altea/altea/client/binding";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { resolveType } from "@altea/altea/data/registration";
import { Enum } from "@altea/altea/data/enum";

/** altea keeps `EnumObject` module-private; the shape is what `Enum.values` accepts. */
type EnumObject = Record<string, string | number>;
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { EntityBaseProps } from "@altea/altea/client/Lines/EntityBase";
import type { EntityListBaseProps } from "@altea/altea/client/Lines/EntityListBase";
import { AutoLine as AutoLineForEval } from "@altea/altea/client/Lines/AutoLine";
import { ExpressionOrValueComponent, FieldComponent } from "./Designer";
import { FindOptionsLine, ViewNameComponent } from "./FindOptionsComponent";
import { type FindOptionsExpr, toFindOptions } from "./FindOptionsExpression";
import type {
    BaseNode, LineBaseNode, EntityBaseNode, EntityListBaseNode, EntityLineNode, ContainerNode,
    EntityTableColumnNode, CustomContextNode, TypeIsNode,
} from "./Nodes";
import { toHtmlAttributes, type HtmlAttributesExpression } from "./HtmlAttributesExpression";
import { toStyleOptions, type StyleOptionsExpression, subCtx } from "./StyleOptionsExpression";
import { HtmlAttributesLine } from "./HtmlAttributesComponent";
import { StyleOptionsLine } from "./StyleOptionsComponent";
import { getFieldExpression } from "./FieldExpression";
import { DynamicViewClient } from "../DynamicViewClient";
import { DynamicViewValidationMessage } from "../../data/DynamicView";

// Port of Signum.Dynamic's View/NodeUtils.tsx — the INTERPRETER: what a stored node tree means at runtime.
// Three things live here:
//   1. `Expression<T>` and `evaluate*` — a stored `{ __code__ }` snippet becomes a function and runs against
//      the live TypeContext, with a validator per call site so a snippet returning the wrong SHAPE reports
//      that instead of blowing up somewhere downstream.
//   2. `DesignerNode` — a node plus WHERE it sits: its parent, the designer's shared context, and the
//      PropertyRoute it resolves to (`fixRoute`, which is what makes field validation and the field picker
//      possible).
//   3. `render` / `renderCode` — the two things a node can be turned into: React elements, or source.
//
// altea divergences, documented inline:
//  - `ModifiableEntity` → `BaseEntity`; `isTypeModifiableEntity(t)` → `t.is(Entity)`.
//  - `PropertyRoute.root` takes a CONSTRUCTOR in altea, so a stored type NAME is resolved through
//    `resolveType` first; `pr.typeReference()` is the `pr.type` getter; `tryAddMember(kind, name)` is
//    `add(name)` (which already dispatches Item / Entity / mixin) wrapped in a try — altea's `add` THROWS on
//    an unknown member where Signum's `tryAddMember` returns undefined, and the designer relies on getting
//    undefined while a field is half-typed.
//  - `type.isCollection` → `type.array`; `type.name` → `type.getTypeName()`.
//  - Signum's `EnumType.values()` becomes `Enum.values(SomeEnum)`: an altea enum is a numeric object whose
//    runtime value is the member NAME (see CLAUDE.md), so the members ARE the valid strings.
//  - `TypeHelpComponent.getExpression` is re-homed as `getFieldExpression` (see FieldExpression.ts).
//  - a node's stored `field` is passed to `subCtx` AS A STRING, which altea supports (`subCtx(field, so)`
//    parses a field PATH). It must not be turned into a runtime function: altea resolves a lambda through
//    the `__quoted` expression tree the transformer stamps, and an eval'd function carries none — it fails
//    with "the lambda carries no `__quoted` expression tree". Same for EntityTableColumn's `property`.
//  - `asFunction`'s `thisObject` (Signum passes the frame's entityComponent so a snippet can use `this`) is
//    kept as a parameter but is `unknown`: altea's views are function components, so there is no instance to
//    bind — a snippet that used `this` in Signum has to use `locals` here.

export type ExpressionOrValue<T> = T | Expression<T>;

/** A stored snippet: the source of a `ctx => …` function (Signum's `{ __code__ }`). */
export type Expression<T> = { __code__: string };

export function isExpression(value: unknown): value is Expression<unknown> {
    return value != null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "__code__");
}

export interface NodeOptions<N extends BaseNode> {
    kind: string;
    group: "Container" | "Property" | "Collection" | "Search" | "Simple" | null;
    order: number | null;
    isContainer?: boolean;
    hasEntity?: boolean;
    hasCollection?: boolean;
    render: (node: DesignerNode<N>, parentCtx: TypeContext<BaseEntity>) => React.ReactElement | undefined | null;
    renderCode?: (node: N, cc: CodeContext) => string;
    renderTreeNode: (node: DesignerNode<N>) => React.ReactElement;
    renderDesigner: (node: DesignerNode<N>) => React.ReactElement;
    validate?: (node: DesignerNode<N>, parentCtx: TypeContext<BaseEntity> | undefined) => string | null | undefined;
    validParent?: string;
    validChild?: string;
    avoidHighlight?: boolean;
    initialize?: (node: N, parentNode: DesignerNode<ContainerNode>) => void;
}

// ---- CodeContext — the "Show code" side: a node tree printed as the source that would build it ----------

export class CodeContext {
    ctxName: string;
    usedNames: string[];
    assignments: { [name: string]: string };
    imports: string[];

    constructor(ctxName: string, usedNames: string[], assignments: { [name: string]: string }, imports: string[]) {
        this.ctxName = ctxName;
        this.usedNames = usedNames;
        this.assignments = assignments;
        this.imports = imports;
    }

    subCtx(field?: string, options?: StyleOptionsExpression): CodeContext {
        if (!field && !options)
            return this;

        const newName = "ctx" + (this.usedNames.length + 1);

        return this.createNewContext(newName);
    }

    createNewContext(newName: string): CodeContext {
        this.usedNames.push(newName);
        return new CodeContext(newName, this.usedNames, this.assignments, this.imports);
    }

    stringifyObject(expressionOrValue: ExpressionOrValue<unknown>): string {

        if (typeof expressionOrValue === "function")
            return String(expressionOrValue);

        if (isExpression(expressionOrValue))
            return expressionOrValue.__code__;

        // An expression nested inside a plain object is stringified as a MARKED string and then unwrapped,
        // so the printed source shows `{ foo: ctx.value.bar }` rather than `{ foo: {"__code__": "…"} }`.
        let result = JSON.stringify(expressionOrValue, (k, v) => {
            if (v != undefined && isExpression(v))
                return "%<%" + v.__code__ + "%>%";
            return v;
        }, 3);

        result = result.replace(/"([^(")"]+)":/g, "$1:");
        result = result.replace(/"%<%(.*?)%>%"/g, s => {
            const inner = JSON.parse(s) as string;
            return inner.substring(3, inner.length - 3);
        });
        return result;
    }

    elementCode(type: string, props: Record<string, unknown> | null, ...children: (string | undefined)[]): string {

        const propsStr = props && Dic.map(props, (k, v) => v == undefined ? null :
            (k + "=" + (typeof v === "string" ? `"${v}"` : `{${this.stringifyObject(v)}}`)))
            .filter((a): a is string => a != null)
            .join(" ");

        if (children.length > 0) {
            const childrenString = indent(children.filter(c => c != undefined).join("\n"), 4);

            return `<${type}${propsStr ? " " : ""}${propsStr || ""}>\n${childrenString}\n</${type}>`;
        }

        return `<${type}${propsStr ? " " : ""}${propsStr || ""} />`;
    }

    elementCodeWithChildren(type: string, props: Record<string, unknown> | null, node: ContainerNode): string {
        const childrensCode = node.children.map(c => renderCode(c, this));
        return this.elementCode(type, props, ...childrensCode);
    }

    elementCodeWithChildrenSubCtx(type: string, props: Record<string, unknown> | null, node: ContainerNode): string {

        const withField = node as ContainerNode & { field?: string; styleOptions?: StyleOptionsExpression };
        const ctx = this.subCtx(withField.field, withField.styleOptions);
        if (this !== ctx)
            this.assignments[ctx.ctxName] = this.subCtxCode(withField.field, withField.styleOptions).__code__;

        const childrensCode = node.children.map(c => renderCode(c, ctx));

        return this.elementCode(type, props, ...childrensCode);
    }

    subCtxCode(field?: string, options?: StyleOptionsExpression): Expression<unknown> {

        if (!field && !options)
            return { __code__: "ctx" };

        const propStr = field && "e => " + getFieldExpression("e", field);
        const optionsStr = options && this.stringifyObject(options);

        return {
            __code__: this.ctxName + ".subCtx("
                + (propStr ?? "") + (propStr && optionsStr ? ", " : "") + (optionsStr || "") + ")",
        };
    }

    getEntityBasePropsEx(node: EntityBaseNode, options: {
        showAutoComplete?: boolean; findMany?: boolean; showMove?: boolean;
        avoidGetComponent?: boolean; filterRows?: boolean;
    }): Record<string, unknown> {

        const result: Record<string, unknown> = {
            ctx: this.subCtxCode(node.field, node.styleOptions),
            label: node.label,
            labelHtmlAttributes: node.labelHtmlAttributes,
            formGroupHtmlAttributes: node.formGroupHtmlAttributes,
            visible: node.visible,
            readOnly: node.readOnly,
            mandatory: node.mandatory,
            createOnFind: node.createOnFind,
            create: node.create,
            onCreate: node.onCreate,
            remove: node.remove,
            onRemove: node.onRemove,
            find: node.find,
            ...(options.findMany
                ? { onFindMany: (node as EntityListBaseNode).onFindMany }
                : { onFind: node.onFind }),
            view: node.view,
            onView: node.onView,
            viewOnCreate: node.viewOnCreate,
            onChange: node.onChange,
            findOptions: node.findOptions,
            getComponent: options.avoidGetComponent === true ? undefined : this.getGetComponentEx(node as ContainerNode, true),
            getViewPromise: toFunctionCode(node.viewName),
        };

        if (options.showAutoComplete)
            result["autocomplete"] = (node as EntityLineNode).autoComplete == undefined ? undefined :
                bindExpr(ac => ac === false ? null : undefined, (node as EntityLineNode).autoComplete);

        if (options.showMove)
            result["move"] = (node as EntityListBaseNode).move;

        if (options.filterRows)
            result["filterRows"] = (node as EntityListBaseNode).filterRows;

        return result;
    }

    getGetComponentEx(node: ContainerNode, withComment: boolean): Expression<unknown> | undefined {
        if (!node.children || node.children.length === 0)
            return undefined;

        const newName = "ctx" + (this.usedNames.length + 1);
        this.usedNames.push(newName);
        const cc = new CodeContext(newName, this.usedNames, {}, this.imports);

        const div = cc.elementCodeWithChildren("div", null, node);

        const assignments = Dic.map(cc.assignments, (k, v) => `const ${k} = ${v};`).join("\n");
        const block = !assignments
            ? `(${div})`
            : `{\n${indent(assignments, 4)}\n    return (${div});\n}`;

        return {
            __code__: withComment
                ? `(${cc.ctxName} /*: YourEntity*/) => ${block}`
                : `${cc.ctxName} => ${block}`,
        };
    }
}

/** Signum's `String.prototype.indent`. */
function indent(text: string, spaces: number): string {
    const pad = " ".repeat(spaces);
    return text.split("\n").map(l => pad + l).join("\n");
}

export function toFunction(
    val: string | undefined | ((e: BaseEntity) => string | ViewPromise<BaseEntity>),
): undefined | ((e: BaseEntity) => string | ViewPromise<BaseEntity>) {
    if (!val)
        return undefined;

    if (typeof val === "function")
        return val;

    return () => val;
}

export function toFunctionCode(
    val: ExpressionOrValue<string | ((e: BaseEntity) => string | ViewPromise<BaseEntity>) | undefined>,
): Expression<(e: BaseEntity) => string | ViewPromise<BaseEntity>> | undefined {
    if (!val)
        return undefined;

    if (isExpression(val))
        return val as Expression<(e: BaseEntity) => string | ViewPromise<BaseEntity>>;

    return { __code__: "mod => '" + String(val) + "'" };
}

// ---- DesignerNode — a node plus where it sits ------------------------------------------------------------

export interface DesignerContext {
    refreshView: () => void;
    onClose: () => void;
    getSelectedNode: () => DesignerNode<BaseNode> | undefined;
    setSelectedNode: (newSelectedNode: DesignerNode<BaseNode>) => void;
    props: Record<string, unknown>;
    locals: Record<string, unknown>;
    localsCode: string | null;
    propTypes: { [name: string]: string /*type*/ };
}

export class DesignerNode<N extends BaseNode> {
    parent?: DesignerNode<BaseNode>;
    context: DesignerContext;
    node: N;
    route?: PropertyRoute;

    constructor(parent: DesignerNode<BaseNode> | undefined, context: DesignerContext, node: N, route: PropertyRoute | undefined) {
        this.parent = parent;
        this.context = context;
        this.node = node;
        this.route = route;
    }

    static zero<N extends BaseNode>(context: DesignerContext, typeName: string): DesignerNode<N> {
        return new DesignerNode(undefined, context, null as unknown as N, tryRoot(typeName));
    }

    createChild<T extends BaseNode>(node: T): DesignerNode<T> {
        let route = this.fixRoute();
        const lbn = node as unknown as { field?: string };
        if (lbn.field && route)
            route = tryAdd(route, lbn.field);

        return new DesignerNode<T>(this as DesignerNode<BaseNode>, this.context, node, route);
    }

    reCreateNode(): DesignerNode<N> {
        if (this.parent == undefined)
            return this;

        return this.parent.createChild<N>(this.node);
    }

    fixRoute(): PropertyRoute | undefined {
        let res = this.route;

        if (!res)
            return undefined;

        if (this.node == undefined)
            return res;

        const options = registeredNodes[this.node.kind];
        if (options == undefined)
            return res;

        if (options.kind === "CustomContext") {
            const cc = DynamicViewClient.registeredCustomContexts[(this.node as BaseNode as CustomContextNode).typeContext];
            return cc?.getPropertyRoute(this as DesignerNode<BaseNode> as DesignerNode<CustomContextNode>);
        }

        if (options.kind === "TypeIs") {
            const typeName = (this.node as BaseNode as TypeIsNode).typeName;
            if (typeName)
                return tryRoot(typeName);
        }

        if (options.hasCollection)
            res = tryAdd(res, "Item");

        if (!res)
            return undefined;

        if (options.hasEntity && res.type.lite)
            res = tryAdd(res, "Entity");

        return res;
    }
}

/** altea's `PropertyRoute.root` takes a CONSTRUCTOR; a stored type name has to be resolved first. */
export function tryRoot(typeName: string): PropertyRoute | undefined {
    const ctor = resolveType(typeName);
    return ctor == undefined ? undefined : PropertyRoute.root(ctor);
}

/** Signum's `tryAddMember` — altea's `add` THROWS on an unknown member, and a half-typed field is normal. */
export function tryAdd(route: PropertyRoute, member: string): PropertyRoute | undefined {
    try {
        return route.add(member);
    } catch {
        return undefined;
    }
}

export const registeredNodes: { [nodeType: string]: NodeOptions<BaseNode> } = {};

export function register<T extends BaseNode>(options: NodeOptions<T>): void {
    registeredNodes[options.kind] = options as unknown as NodeOptions<BaseNode>;
}

// ---- tree-node labels ------------------------------------------------------------------------------------

export function treeNodeKind(dn: DesignerNode<BaseNode>): React.JSX.Element {
    return <small>{dn.node.kind}</small>;
}

export function treeNodeKindField(dn: DesignerNode<LineBaseNode>): React.JSX.Element {
    return <span><small>{dn.node.kind}:</small> <strong>{dn.node.field}</strong></span>;
}

export function treeNodeTableColumnProperty(dn: DesignerNode<EntityTableColumnNode>): React.JSX.Element {
    return <span><small>ETColumn:</small> <strong>{dn.node.property}</strong></span>;
}

// ---- rendering -------------------------------------------------------------------------------------------

export function RenderWithViewOverrides(
    { dn, parentCtx, vos }: { dn: DesignerNode<BaseNode>; parentCtx: TypeContext<BaseEntity>; vos: ViewOverride<BaseEntity>[] },
): React.ReactNode {

    let resultWithErrors: React.JSX.Element | null | undefined;

    if (dn.context.localsCode) {
        try {
            dn.context.locals = asFunction(undefined, { __code__: dn.context.localsCode },
                () => "Locals", dn.context.props, {})(parentCtx) as Record<string, unknown>;
        } catch (e) {
            resultWithErrors = (
                <div>
                    <div className="alert alert-danger">
                        <strong>Invalid Locals:</strong>
                        <br />
                        {(e as Error).message}
                    </div>
                    {resultWithErrors}
                </div>
            );
        }
    }

    if (dn.context.props) {

        const allKeys = [...new Set([...Dic.getKeys(dn.context.props), ...Dic.getKeys(dn.context.propTypes)])];

        const errors = allKeys
            .map(key => validatePropType(key, dn.context.props[key], dn.context.propTypes[key]))
            .filter((e): e is string => e != null);

        if (errors.length > 0)
            resultWithErrors = (
                <div>
                    <div className="alert alert-danger">
                        <strong>Invalid Props:</strong>
                        <ul>
                            {errors.map((e, i) => <li key={i}>{e}</li>)}
                        </ul>
                    </div>
                    {resultWithErrors}
                </div>
            );
    }

    let result = render(dn, parentCtx);
    if (result == null)
        return null;

    if (resultWithErrors)
        result = (
            <div>
                {resultWithErrors}
                {result}
            </div>
        );

    if (vos.length > 0) {
        const replacer = new ViewReplacer(result, parentCtx, undefined as never);
        vos.forEach(vo => vo.override(replacer as never));
        return replacer.result;
    }

    return result;
}

function validatePropType(propName: string, value: unknown, typeScriptType: string | undefined): string | null {

    if (propName === "ref" || propName === "innerRef")
        return null;

    if (typeScriptType == null)
        return `Unexpected prop '${propName}' with value: ${String(value)}`;

    typeScriptType = typeScriptType.trim();

    if (typeScriptType.includes("|") || typeScriptType.includes("&"))
        return null;

    if (value == null) {
        if (!typeScriptType.endsWith("?"))
            return `Mandatory prop '${propName}' has value: ${String(value)}`;
        return null;
    }

    const cleanType = typeScriptType.endsWith("?") ? typeScriptType.slice(0, -1) : typeScriptType;

    const isOk = cleanType === "string" ? typeof value === "string" :
        cleanType === "number" ? typeof value === "number" :
            cleanType === "boolean" ? typeof value === "boolean" :
                cleanType.startsWith("(") ? typeof value === "function" :
                    cleanType.startsWith("{") ? typeof value === "object" :
                        cleanType.endsWith("[]") ? Array.isArray(value) :
                            true;

    if (!isOk)
        return `Property '${propName}' should be a ${cleanType} but is a ${typeof value}, value: ${String(value)}`;

    return null;
}

export function renderCode(node: BaseNode, cc: CodeContext): string {

    try {
        const no = registeredNodes[node.kind]!;

        const result = no.renderCode!(node, cc);

        if (node.visible)
            return `{ ${cc.stringifyObject(node.visible)} && ${result}}`;

        return result;

    } catch (e) {
        return `/*ERROR ${(e as Error).message}*/`;
    }
}

export function render(dn: DesignerNode<BaseNode>, parentCtx: TypeContext<BaseEntity>): React.ReactElement | undefined | null {
    try {
        if (evaluateAndValidate(dn, parentCtx, dn.node, n => n.visible, isBooleanOrNull) === false)
            return null;

        const error = validate(dn, parentCtx);
        if (error)
            return <div className="alert alert-danger">{getErrorTitle(dn)} {error}</div>;

        const sn = dn.context.getSelectedNode();

        if (sn?.node === dn.node && registeredNodes[sn.node.kind]?.avoidHighlight !== true)
            return (
                <div style={{ border: "1px solid #337ab7", borderRadius: "2px" }}>
                    {registeredNodes[dn.node.kind]!.render(dn, parentCtx)}
                </div>);

        return registeredNodes[dn.node.kind]!.render(dn, parentCtx);

    } catch (e) {
        return <div className="alert alert-danger">{getErrorTitle(dn)}&nbsp;{(e as Error).message}</div>;
    }
}

export function getErrorTitle(dn: DesignerNode<BaseNode>): React.JSX.Element {
    const lbn = dn.node as LineBaseNode;
    if (lbn.field)
        return <strong>{dn.node.kind} ({lbn.field})</strong>;

    return <strong>{dn.node.kind}</strong>;
}

export function renderDesigner(dn: DesignerNode<BaseNode>): React.JSX.Element {
    return (
        <div>
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, a => a.visible)} type="boolean" defaultValue={true} />
            {registeredNodes[dn.node.kind]!.renderDesigner(dn)}
        </div>
    );
}

// ---- evaluation ------------------------------------------------------------------------------------------

export function asFunction(
    thisObject: unknown,
    expression: Expression<unknown>,
    getFieldName: () => string,
    props: Record<string, unknown>,
    locals: Record<string, unknown>,
): (e: TypeContext<BaseEntity>) => unknown {

    const code = "ctx => " + expression.__code__;

    try {
        return evalWithScope.call(thisObject, code, globalModules, props, locals);
    } catch (e) {
        throw new Error("Syntax in '" + getFieldName() + "':\n" + code + "\n" + (e as Error).message);
    }
}

/**
 * The one `eval` the module rests on. The locals declared just below are DELIBERATE: a direct `eval` sees
 * the enclosing lexical scope, which is how a stored snippet can say `AutoLine` or `modules.Finder` without
 * importing anything. Same trick, and same locals, as Signum.
 */
export function evalWithScope(
    code: string,
    modules: Record<string, unknown>,
    props: Record<string, unknown>,
    locals: Record<string, unknown>,
): (e: TypeContext<BaseEntity>) => unknown {

    // Lines
    const AutoLine = AutoLineForEval;

    // Referenced so the bundler cannot drop them: they exist to be visible to `eval`.
    void AutoLine; void modules; void props; void locals;

    // eslint-disable-next-line no-eval
    return eval(code) as (e: TypeContext<BaseEntity>) => unknown;
}

export function asFieldFunction(field: string): (e: BaseEntity) => unknown {
    const fixedRoute = getFieldExpression("e", field);

    const code = "(function(e){ return " + fixedRoute + ";})";

    try {
        // eslint-disable-next-line no-eval
        return eval(code) as (e: BaseEntity) => unknown;
    } catch (e) {
        throw new Error("Syntax in '" + fixedRoute + "':\n" + code + "\n" + (e as Error).message);
    }
}

export function evaluate<F, T>(
    dn: unknown,
    parentCtx: TypeContext<BaseEntity>,
    object: F,
    fieldAccessor: (from: F) => ExpressionOrValue<T> | undefined,
): T | undefined {
    return evaluateUntyped(dn, parentCtx, fieldAccessor(object), () => Binding.getSingleMember(fieldAccessor as never)) as T | undefined;
}

export function evaluateUntyped(
    dn: unknown,
    parentCtx: TypeContext<BaseEntity>,
    expressionOrValue: ExpressionOrValue<unknown> | undefined,
    getFieldName: () => string,
): unknown {
    if (expressionOrValue == null)
        return undefined;

    if (!isExpression(expressionOrValue))
        return expressionOrValue;

    if (!expressionOrValue.__code__)
        return undefined;

    const context = (dn as DesignerNode<BaseNode>).context;
    const f = asFunction(undefined, expressionOrValue, getFieldName, context.props, context.locals);

    try {
        return f(parentCtx);
    } catch (e) {
        throw new Error("Eval '" + getFieldName() + "':\n" + (e as Error).message);
    }
}

export function evaluateAndValidate<F, T>(
    dn: unknown,
    parentCtx: TypeContext<BaseEntity>,
    object: F,
    fieldAccessor: (from: F) => ExpressionOrValue<T> | undefined,
    validateFn: (val: unknown) => string | null,
): T | undefined {
    const result = evaluate(dn, parentCtx, object, fieldAccessor);

    const error = validateFn(result);
    if (error)
        throw new Error("Result '" + Binding.getSingleMember(fieldAccessor as never) + "':\n" + error);

    if (result == null)
        return undefined;

    return result;
}

export function validate(dn: DesignerNode<BaseNode>, parentCtx: TypeContext<BaseEntity> | undefined): string | null | undefined {
    const options = registeredNodes[dn.node.kind]!;

    if (options.isContainer && options.validChild
        && (dn.node as ContainerNode).children
        && (dn.node as ContainerNode).children.some(c => c.kind !== options.validChild))
        return DynamicViewValidationMessage.OnlyChildNodesOfType0Allowed.niceToString(options.validChild);

    if (options.validate)
        return options.validate(dn, parentCtx);

    return undefined;
}

// ---- shape validators (Signum's is* family, verbatim) ----------------------------------------------------

export function isString(val: unknown): string | null {
    return typeof val === "string" ? null : `The returned value (${JSON.stringify(val)}) should be a string`;
}

export function isNumber(val: unknown): string | null {
    return typeof val === "number" ? null : `The returned value (${JSON.stringify(val)}) should be a number`;
}

export function isBoolean(val: unknown): string | null {
    return typeof val === "boolean" ? null : `The returned value (${JSON.stringify(val)}) should be a boolean`;
}

export function isBooleanOrFunction(val: unknown): string | null {
    return (typeof val === "boolean" || typeof val === "function") ? null
        : `The returned value (${JSON.stringify(val)}) should be a boolean or function`;
}

export function isFindOptions(val: unknown): string | null {
    return typeof val === "object" ? null : `The returned value (${JSON.stringify(val)}) should be a valid findOptions`;
}

export function isStringOrNull(val: unknown): string | null {
    return val == null || typeof val === "string" ? null : `The returned value (${JSON.stringify(val)}) should be a string or null`;
}

export function isEnum(val: unknown, enumObject: EnumObject): string | null {
    const values = Enum.values(enumObject) as string[];
    return val != null && typeof val === "string" && values.includes(val) ? null
        : `The returned value (${JSON.stringify(val)}) should be a valid enum member (like ${values.join(" or ")})`;
}

export function isEnumOrNull(val: unknown, enumObject: EnumObject): string | null {
    const values = Enum.values(enumObject) as string[];
    return val == null || (typeof val === "string" && values.includes(val)) ? null
        : `The returned value (${JSON.stringify(val)}) should be a valid enum member (like ${values.join(" or ")}) or null`;
}

export function isObject(val: unknown): string | null {
    return val != null && typeof val === "object" ? null : `The returned value (${JSON.stringify(val)}) should be an object`;
}

export function isObjectOrNull(val: unknown): string | null {
    return val == null || typeof val === "object" ? null : `The returned value (${JSON.stringify(val)}) should be an object or null`;
}

export function isObjectOrFunctionOrNull(val: unknown): string | null {
    return val == null || typeof val === "object" || typeof val === "function" ? null
        : `The returned value (${JSON.stringify(val)}) should be an object or function or null`;
}

export function isInList(val: unknown, values: string[]): string | null {
    return val != null && typeof val === "string" && values.includes(val) ? null
        : `The returned value (${JSON.stringify(val)}) should be a value like ${values.join(" or ")}`;
}

export function isInListOrNull(val: unknown, values: string[]): string | null {
    return val == null || (typeof val === "string" && values.includes(val)) ? null
        : `The returned value (${JSON.stringify(val)}) should be a value like ${values.join(" or ")} or null`;
}

export function isNumberOrNull(val: unknown): string | null {
    return val == null || typeof val === "number" ? null : `The returned value (${JSON.stringify(val)}) should be a number or null`;
}

export function isNumberOrStringOrNull(val: unknown): string | null {
    return val == null || typeof val === "number" || typeof val === "string" ? null
        : `The returned value (${JSON.stringify(val)}) should be a number or string or null`;
}

export function isBooleanOrNull(val: unknown): string | null {
    return val == null || typeof val === "boolean" ? null : `The returned value (${JSON.stringify(val)}) should be a boolean or null`;
}

export function isBooleanOrStringOrNull(val: unknown): string | null {
    return val == null || typeof val === "boolean" || typeof val === "string" ? null
        : `The returned value (${JSON.stringify(val)}) should be a boolean or string or null`;
}

export function isBooleanOrFunctionOrNull(val: unknown): string | null {
    return val == null || typeof val === "boolean" || typeof val === "function" ? null
        : `The returned value (${JSON.stringify(val)}) should be a boolean or function or null`;
}

export function isFunctionOrNull(val: unknown): string | null {
    return val == null || typeof val === "function" ? null : `The returned value (${JSON.stringify(val)}) should be a function or null`;
}

export function isFunctionOrStringOrNull(val: unknown): string | null {
    return val == null || typeof val === "function" || typeof val === "string" ? null
        : `The returned value (${JSON.stringify(val)}) should be a function or string or null`;
}

export function isArrayOrNull(val: unknown): string | null {
    return val == null || Array.isArray(val) ? null : `The returned value (${JSON.stringify(val)}) should be an array or null`;
}

export function isFindOptionsOrNull(val: unknown): string | null {
    return val == null || isFindOptions(val) == null ? null
        : `The returned value (${JSON.stringify(val)}) should be a findOptions or null`;
}

// ---- children --------------------------------------------------------------------------------------------

export function withChildrensSubCtx(
    dn: DesignerNode<ContainerNode>,
    parentCtx: TypeContext<BaseEntity>,
    element: React.ReactElement,
): React.JSX.Element {
    const withField = dn.node as ContainerNode & { field?: string; styleOptions?: StyleOptionsExpression };
    const ctx = subCtx(dn, parentCtx, withField.field, withField.styleOptions);
    return withChildrens(dn, ctx as TypeContext<BaseEntity>, element);
}

export function withChildrens(
    dn: DesignerNode<ContainerNode>,
    ctx: TypeContext<BaseEntity>,
    element: React.ReactElement,
): React.JSX.Element {
    const nodes = dn.node.children
        ? dn.node.children.map(n => render(dn.createChild(n), ctx)).filter((a): a is React.ReactElement => a != null)
        : [];
    return React.cloneElement(element, undefined, ...nodes);
}

// ---- node validation helpers -----------------------------------------------------------------------------

export function mandatory<T extends BaseNode>(dn: DesignerNode<T>, fieldAccessor: (from: T) => unknown): string | undefined {
    if (!fieldAccessor(dn.node))
        return DynamicViewValidationMessage.Member0IsMandatoryFor1.niceToString(
            Binding.getSingleMember(fieldAccessor as never), dn.node.kind);

    return undefined;
}

export function validateFieldMandatory(dn: DesignerNode<LineBaseNode>): string | undefined {
    return mandatory(dn, n => n.field) ?? validateField(dn);
}

export function validateEntityBase(dn: DesignerNode<EntityBaseNode>, parentCtx: TypeContext<BaseEntity> | undefined): string | undefined {
    return validateFieldMandatory(dn)
        ?? (dn.node.findOptions && validateFindOptions(dn.node.findOptions, parentCtx))
        ?? viewNameOrChildrens(dn);
}

export function viewNameOrChildrens(dn: DesignerNode<EntityBaseNode>): string | undefined {
    if (dn.node.children && dn.node.children.length > 0 && dn.node.viewName != null)
        return DynamicViewValidationMessage.ViewNameIsNotAllowedWhileHavingChildren.niceToString();

    return undefined;
}

export function validateField(dn: DesignerNode<LineBaseNode>): string | undefined {

    const parentRoute = dn.parent!.fixRoute();

    if (parentRoute == undefined)
        return undefined;

    const m = parentRoute.subMembers()[dn.node.field!];

    if (!m)
        return DynamicViewValidationMessage.Type0DoesNotContainsField1.niceToString(
            parentRoute.type.getTypeName() ?? "", dn.node.field ?? "");

    const options = registeredNodes[dn.node.kind]!;

    // altea's FieldInfo EXTENDS TypeReference (CLAUDE.md): the member IS the type descriptor.
    const isEntity = m.is(Entity) || m.lite === true;

    const DVVM = DynamicViewValidationMessage;

    if ((isEntity || false) !== (options.hasEntity || false)
        || (m.array || false) !== (options.hasCollection || false))
        return DVVM._0RequiresA1.niceToString(dn.node.kind,
            (options.hasEntity
                ? (options.hasCollection ? DVVM.CollectionOfEntities : DVVM.Entity)
                : (options.hasCollection ? DVVM.CollectionOfEnums : DVVM.Value)).niceToString());

    return undefined;
}

export function validateFindOptions(foe: FindOptionsExpr, parentCtx: TypeContext<BaseEntity> | undefined): string | undefined {
    if (!foe.queryName)
        return DynamicViewValidationMessage._0RequiresA1.niceToString("findOptions", "queryKey");

    return undefined;
}

export function addBreakLines(breakLines: boolean, message: string): React.ReactNode[] {
    if (!breakLines)
        return [message];

    return message.split("\n").flatMap((e, i) => i === 0 ? [e] : [<br key={"br" + i} />, e]);
}

// ---- EntityBase props ------------------------------------------------------------------------------------

export function getEntityListBaseProps(
    dn: DesignerNode<EntityBaseNode>,
    parentCtx: TypeContext<BaseEntity>,
    options: {
        showAutoComplete?: boolean; findMany?: boolean; showMove?: boolean;
        avoidGetComponent?: boolean; isEntityLine?: boolean; filterRows?: boolean;
    },
): EntityListBaseProps<never> {
    return getEntityBaseProps(dn, parentCtx, options) as unknown as EntityListBaseProps<never>;
}

export function getEntityBaseProps(
    dn: DesignerNode<EntityBaseNode>,
    parentCtx: TypeContext<BaseEntity>,
    options: {
        showAutoComplete?: boolean; findMany?: boolean; showMove?: boolean;
        avoidGetComponent?: boolean; isEntityLine?: boolean; filterRows?: boolean;
    },
): EntityBaseProps<never> {

    const result: Record<string, unknown> = {
        ctx: parentCtx.subCtx(dn.node.field, toStyleOptions(dn, parentCtx, dn.node.styleOptions)),
        label: evaluateAndValidate(dn, parentCtx, dn.node, n => n.label, isStringOrNull),
        labelHtmlAttributes: toHtmlAttributes(dn, parentCtx, dn.node.labelHtmlAttributes),
        formGroupHtmlAttributes: toHtmlAttributes(dn, parentCtx, dn.node.formGroupHtmlAttributes),
        ...(options.isEntityLine
            ? { itemHtmlAttributes: toHtmlAttributes(dn, parentCtx, (dn.node as EntityLineNode).itemHtmlAttributes) }
            : undefined),
        visible: evaluateAndValidate(dn, parentCtx, dn.node, n => n.visible, isBooleanOrNull),
        readOnly: evaluateAndValidate(dn, parentCtx, dn.node, n => n.readOnly, isBooleanOrNull),
        mandatory: evaluateAndValidate(dn, parentCtx, dn.node, n => n.mandatory, isBooleanOrNull),
        createOnFind: evaluateAndValidate(dn, parentCtx, dn.node, n => n.createOnFind, isBooleanOrNull),
        create: evaluateAndValidate(dn, parentCtx, dn.node, n => n.create, isBooleanOrNull),
        onCreate: evaluateAndValidate(dn, parentCtx, dn.node, n => n.onCreate, isFunctionOrNull),
        remove: evaluateAndValidate(dn, parentCtx, dn.node, n => n.remove, isBooleanOrFunctionOrNull),
        onRemove: evaluateAndValidate(dn, parentCtx, dn.node, n => n.onRemove, isFunctionOrNull),
        find: evaluateAndValidate(dn, parentCtx, dn.node, n => n.find, isBooleanOrNull),
        ...(options.findMany
            ? { onFindMany: evaluateAndValidate(dn, parentCtx, dn.node, (n: EntityBaseNode) => (n as EntityListBaseNode).onFindMany, isFunctionOrNull) }
            : { onFind: evaluateAndValidate(dn, parentCtx, dn.node, n => n.onFind, isFunctionOrNull) }),
        view: evaluateAndValidate(dn, parentCtx, dn.node, n => n.view, isBooleanOrFunctionOrNull),
        onView: evaluateAndValidate(dn, parentCtx, dn.node, n => n.onView, isFunctionOrNull),
        viewOnCreate: evaluateAndValidate(dn, parentCtx, dn.node, n => n.viewOnCreate, isBooleanOrNull),
        onChange: evaluateAndValidate(dn, parentCtx, dn.node, n => n.onChange, isFunctionOrNull),
        findOptions: dn.node.findOptions && toFindOptions(dn, parentCtx, dn.node.findOptions),
        getComponent: options.avoidGetComponent === true ? undefined : getGetComponent(dn as unknown as DesignerNode<ContainerNode>),
        getViewPromise: toFunction(evaluateAndValidate(dn, parentCtx, dn.node, n => n.viewName, isFunctionOrStringOrNull) as never),
    };

    if (options.showAutoComplete)
        result["autocomplete"] = evaluateAndValidate(dn, parentCtx, dn.node,
            n => (n as EntityLineNode).autoComplete, isObjectOrNull);

    if (options.showMove)
        result["move"] = evaluateAndValidate(dn, parentCtx, dn.node,
            (n: EntityBaseNode) => (n as EntityListBaseNode).move, isBooleanOrFunctionOrNull);

    if (options.filterRows)
        result["filterRows"] = evaluateAndValidate(dn, parentCtx, dn.node,
            (n: EntityBaseNode) => (n as EntityListBaseNode).filterRows, isFunctionOrNull);

    result["ref"] = evaluateAndValidate(dn, parentCtx, dn.node, (n: BaseNode) => n.ref, isObjectOrFunctionOrNull);

    return result as unknown as EntityBaseProps<never>;
}

export function getGetComponent(
    dn: DesignerNode<ContainerNode>,
): undefined | ((ctxe: TypeContext<BaseEntity>) => React.JSX.Element) {
    if (!dn.node.children || dn.node.children.length === 0)
        return undefined;

    return (ctxe: TypeContext<BaseEntity>) => withChildrens(dn, ctxe, <div />);
}

// ---- the shared EntityBase designer ----------------------------------------------------------------------

export function designEntityBase(
    dn: DesignerNode<EntityBaseNode>,
    options: { showAutoComplete?: boolean; findMany?: boolean; showMove?: boolean; isEntityLine?: boolean; filterRows?: boolean },
): React.JSX.Element {

    const route = dn.route;
    const typeName = route ? (route.type.getTypeName() ?? "YourEntity") : "YourEntity";
    // `member` throws on a Root route, so guard with a try (altea's PropertyRouteType is a string union,
    // and the designer asks for a label before a field has been picked).
    const niceName = safeMember(route);

    return (
        <div>
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.ref)} type={null} defaultValue={true} />
            <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.field)} />
            <StyleOptionsLine dn={dn} binding={Binding.create(dn.node, n => n.styleOptions)} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.label)} type="string" defaultValue={niceName ?? ""} />
            <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.labelHtmlAttributes)} />
            <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.formGroupHtmlAttributes)} />
            {options.isEntityLine &&
                <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => (n as EntityLineNode).itemHtmlAttributes)} />}
            <ViewNameComponent dn={dn} binding={Binding.create(dn.node, n => n.viewName)} typeName={route ? typeName : undefined} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.readOnly)} type="boolean" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.mandatory)} type="boolean" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.createOnFind)} type="boolean" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.create)} type="boolean" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onCreate)} type={null} defaultValue={null}
                exampleExpression={`() => Promise.resolve(modules.Constructor.construct('${typeName}'))`} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.remove)} type="boolean" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onRemove)} type={null} defaultValue={null}
                exampleExpression="() => Promise.resolve(true)" />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.find)} type="boolean" defaultValue={null} />
            {!options.findMany &&
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onFind)} type={null} defaultValue={null}
                    exampleExpression={`e => modules.Finder.find('${typeName}')`} />}
            {options.findMany &&
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, (n: EntityBaseNode) => (n as EntityListBaseNode).onFindMany)} type={null} defaultValue={null}
                    exampleExpression={`e => modules.Finder.findMany('${typeName}')`} />}
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.view)} type="boolean" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onView)} type={null} defaultValue={null}
                exampleExpression="e => modules.Navigator.view(e)" />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.viewOnCreate)} type="boolean" defaultValue={null} />
            {options.showMove &&
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, (n: EntityBaseNode) => (n as EntityListBaseNode).move)} type="boolean" defaultValue={null} />}
            {options.showAutoComplete &&
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => (n as EntityLineNode).autoComplete)} type="boolean" defaultValue={null}
                    exampleExpression="new modules.AutoCompleteConfig.LiteAutocompleteConfig((signal, subStr) => [/* your API call here */], /*requiresInitialLoad:*/ false, /*showType:*/ false)" />}
            <FindOptionsLine dn={dn} binding={Binding.create(dn.node, n => n.findOptions)} avoidSuggestion={true} />
            {options.filterRows &&
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => (n as EntityListBaseNode).filterRows)} type={null} defaultValue={null}
                    exampleExpression="ctxs => ctxs.filter(ctx => ctx.value.code != null)" />}
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onChange)} type={null} defaultValue={null}
                exampleExpression={"/* you must declare 'forceUpdate' in locals */ \n() => locals.forceUpdate()"} />
        </div>
    );
}

// ---- expression combinators ------------------------------------------------------------------------------

export function withClassNameEx(
    attrs: HtmlAttributesExpression | undefined,
    className: ExpressionOrValue<string>,
): HtmlAttributesExpression {
    if (attrs == undefined)
        return { className: className };

    attrs["className"] = bindExpr((c, a) => classes(c as string, a as string), className, attrs["className"]);

    return attrs;
}

export function toCodeEx(expr: ExpressionOrValue<string>): string {
    return isExpression(expr) ? "(" + expr.__code__ + ")"
        : expr == null ? "null"
            : `"${expr}"`;
}

// Signum matches the ES5 `function (a, b) { return X; }` shape that a transpiled arrow used to produce.
// altea targets modern ES, so a lambda stringifies as an ARROW — hence the second alternative.
const lambdaBody = /^(?:function\s*\(\s*([^)]*)\s*\)\s*\{\s*(?:"use strict";)?\s*return\s*([^;]*?)\s*;?\s*\}|\(?\s*([^)=]*?)\s*\)?\s*=>\s*(?:\{\s*return\s*([^;]*?)\s*;?\s*\}|([^;]*?))\s*)$/;

/**
 * Signum's `bindExpr` — inline a lambda's BODY, substituting each parameter with the code of the expression
 * passed for it, so a derived value stays an expression instead of being evaluated eagerly. Used for the
 * className combination and the autocomplete flag.
 */
export function bindExpr(
    lambda: (...params: unknown[]) => unknown,
    ...parameters: ExpressionOrValue<unknown>[]
): ExpressionOrValue<unknown> {
    if (parameters.every(a => a == null || !isExpression(a)))
        return lambda(...parameters);

    const parts = lambdaBody.exec(String(lambda));
    if (parts == null)
        throw new Error("bindExpr: could not parse the lambda " + String(lambda));

    const paramList = parts[1] ?? parts[3] ?? "";
    const body = parts[2] ?? parts[4] ?? parts[5] ?? "";

    const params = paramList.split(",").map(a => a.trim()).filter(a => a !== "");

    const newBody = body.replace(/\b[$a-zA-Z_][0-9a-zA-Z_$]*\b/g, str =>
        params.includes(str) ? toCodeEx(parameters[params.indexOf(str)] as ExpressionOrValue<string>) : str);

    return { __code__: newBody };
}

/** The last step's name, or "" for a root route (which has none). */
function safeMember(route: PropertyRoute | undefined): string {
    if (route == undefined)
        return "";
    try {
        return route.member;
    } catch {
        return "";
    }
}
