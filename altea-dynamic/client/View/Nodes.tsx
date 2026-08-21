import * as React from "react";
import { Tab, Tabs, Button } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import { EntityRepeater } from "@altea/altea/client/Lines/EntityRepeater";
import { EntityTabRepeater } from "@altea/altea/client/Lines/EntityTabRepeater";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { EntityStrip } from "@altea/altea/client/Lines/EntityStrip";
import { EntityCheckboxList } from "@altea/altea/client/Lines/EntityCheckboxList";
import { EnumCheckboxList } from "@altea/altea/client/Lines/EnumCheckboxList";
import { RenderEntity } from "@altea/altea/client/Lines/RenderEntity";
import { MultiValueLine } from "@altea/altea/client/Lines/MultiValueLine";
import type { AutoLineProps } from "@altea/altea/client/Lines/AutoLine";
import type { AutocompleteConfig } from "@altea/altea/client/Lines/AutoCompleteConfig";
import type { LineBaseController, LineBaseProps } from "@altea/altea/client/Lines/LineBase";
import type { EntityTableColumn } from "@altea/altea/client/Lines/EntityTable";
import { FileLine } from "@altea/altea-files/client/Components/FileLine";
import { MultiFileLine } from "@altea/altea-files/client/Components/MultiFileLine";
import { FileImageLine } from "@altea/altea-files/client/Components/FileImageLine";
import type { DownloadBehaviour } from "@altea/altea-files/client/Components/FileDownloader";
import { FileEmbedded, FilePathEmbedded, type FileTypeSymbol } from "@altea/altea-files/data/Files";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import SearchValueLine from "@altea/altea/client/SearchControl/SearchValueLine";
import type { FindOptionsParsed } from "@altea/altea/client/FindOptions";
import type { ResultTable } from "@altea/altea/data/dynamicQuery/queryRequest";
import type SearchControlLoaded from "@altea/altea/client/SearchControl/SearchControlLoaded";
import { Entity, EmbeddedEntity, type BaseEntity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { EntityPack } from "@altea/altea/data/entityPack";
import { classes, Dic } from "@altea/altea/data/globals";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import type { TypeInfo, FieldInfo } from "@altea/altea/data/reflection";
import { getRegisteredTypes, cleanTypeName } from "@altea/altea/data/registration";
import { tryGetTypeInfo, getOperationInfos } from "@altea/altea/client/Reflection";
import { Binding } from "@altea/altea/client/binding";
import { parseIcon } from "@altea/altea/client/Components/IconHelpers";
import * as AppContext from "@altea/altea/client/AppContext";
import { Navigator } from "@altea/altea/client/Navigator";
import type { ViewPromise } from "@altea/altea/client/EntitySettings";
import { TypeContext, type ButtonBarElement } from "@altea/altea/client/TypeContext";
import { EntityOperationContext } from "@altea/altea/client/Operations";
import { OperationButton } from "@altea/altea/client/Operations/EntityOperations";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import { useAPI } from "@altea/altea/client/Hooks";
import type { BsColor, BsSize } from "@altea/altea/client/Components";
import { ExpressionOrValueComponent, FieldComponent } from "./Designer";
import {
    type ExpressionOrValue, type Expression, bindExpr, toCodeEx, withClassNameEx, type DesignerNode,
} from "./NodeUtils";
import * as NodeUtils from "./NodeUtils";
import { FindOptionsLine, QueryTokenLine, ViewNameComponent, FetchQueryRootType } from "./FindOptionsComponent";
import { HtmlAttributesLine } from "./HtmlAttributesComponent";
import { StyleOptionsLine } from "./StyleOptionsComponent";
import { DynamicViewClient } from "../DynamicViewClient";
import { toFindOptions, type FindOptionsExpr } from "./FindOptionsExpression";
import { toHtmlAttributes, type HtmlAttributesExpression, withClassName } from "./HtmlAttributesExpression";
import { toStyleOptions, type StyleOptionsExpression } from "./StyleOptionsExpression";
import { DynamicViewValidationMessage } from "../../data/DynamicView";

// Port of Signum.Dynamic's View/Nodes.tsx — the NODE LIBRARY: every kind of node a stored view may contain,
// each declaring four things (Signum's NodeOptions): how it RENDERS, what SOURCE it would print, what it
// looks like in the designer TREE, and which little editors its DESIGNER pane shows.
//
// This is the file a view author's vocabulary comes from, so the `kind` strings, the property names on each
// node interface, and the group/order that decide the "add node" menu are all kept EXACTLY as Signum has
// them: that is what lets a `viewContent` JSON written against Signum load here.
//
// altea divergences, documented inline:
//  - `EntityList` and `ColorLine` are NOT registered: altea has no such Line. EntityRepeater / EntityStrip /
//    EntityTable cover the same ground, and a color is an AutoLine over a string.
//  - `FetchQueryDescription` becomes `FetchQueryRootType`: altea has no QueryDescription DTO at all (see
//    CLAUDE.md), so the SearchControl designer resolves the query's Entity type from the token TREE
//    (`Finder.getQueryRoot`) instead of from a shipped column list.
//  - `EntityTable.typedColumns<T>(…)` has no altea counterpart; the generated source prints a plain array,
//    which is what altea's `columns` prop takes.
//  - `ti.operations` is gone from TypeInfo in altea (it is per-ROLE, so it lives in the metadata blob —
//    CLAUDE.md); the Button designer reads `getOperationInfos(ctor)`.
//  - `getAllTypes()` → `getRegisteredTypes()` (constructors, so names come from `cleanTypeName`).
//  - `tr.isCollection` → `type.array`; `tr.isEmbedded` → `type.is(EmbeddedEntity)`; `tr.name` →
//    `type.getTypeName()`; `ti.isLowPopulation` → `ti.lowPopulation`; `mi.notVisible` has no counterpart, so
//    `appropiateComponent` skips only `id`.
//  - `mi.defaultFileTypeInfo.onlyImages` (Signum ships per-field file metadata to the client) has no
//    counterpart either, so a FilePath field always gets a `FileLine`; switch it to `FileImageLine` in the
//    designer when the field holds images.
//  - `registerSymbol("FileType", key)` → `FileTypeSymbol` resolved from the registry by key.
//  - `String.prototype.etc` / `.tryAfter` / `.sum()` / `.max()` / `.contains` are Signum globals; spelled out.

// ---- the node hierarchy ----------------------------------------------------------------------------------

export interface BaseNode {
    ref?: Expression<unknown>;
    kind: string;
    visible?: ExpressionOrValue<boolean>;
}

export interface ContainerNode extends BaseNode {
    children: BaseNode[];
}

/** Signum's `String.prototype.etc` — truncate with an ellipsis. */
function etc(text: string, max: number): string {
    return text.length <= max ? text : text.substring(0, max) + "…";
}

/** The label a node with a free-text/expression member shows in the tree. */
function shortOf(value: ExpressionOrValue<string> | undefined): string {
    if (value == undefined)
        return "";
    return etc(typeof value === "string" ? value : (value.__code__ ?? ""), 20);
}

// ---- Div ------------------------------------------------------------------------------------------------

export interface DivNode extends ContainerNode {
    kind: "Div";
    field?: string;
    styleOptions?: StyleOptionsExpression;
    htmlAttributes?: HtmlAttributesExpression;
}

NodeUtils.register<DivNode>({
    kind: "Div",
    group: "Container",
    order: 0,
    isContainer: true,
    renderTreeNode: NodeUtils.treeNodeKind,
    renderCode: (node, cc) => cc.elementCodeWithChildrenSubCtx("div", node.htmlAttributes ?? null, node),
    render: (dn, parentCtx) => NodeUtils.withChildrensSubCtx(dn, parentCtx,
        <div {...toHtmlAttributes(dn, parentCtx, dn.node.htmlAttributes)} />),
    renderDesigner: dn => (<div>
        <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.field)} />
        <StyleOptionsLine dn={dn} binding={Binding.create(dn.node, n => n.styleOptions)} />
        <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.htmlAttributes)} />
    </div>),
});

// ---- Row / Column ---------------------------------------------------------------------------------------

export interface RowNode extends ContainerNode {
    kind: "Row";
    field?: string;
    styleOptions?: StyleOptionsExpression;
    htmlAttributes?: HtmlAttributesExpression;
}

NodeUtils.register<RowNode>({
    kind: "Row",
    group: "Container",
    order: 1,
    isContainer: true,
    validChild: "Column",
    renderTreeNode: NodeUtils.treeNodeKind,
    validate: (dn, parentCtx) => parentCtx && dn.node.children.filter(c => c.kind === "Column")
        .map(col =>
            (NodeUtils.evaluate(dn, parentCtx, col, f => (f as ColumnNode).width) ?? 0) +
            (NodeUtils.evaluate(dn, parentCtx, col, f => (f as ColumnNode).offset) ?? 0))
        .reduce((a, b) => a + b, 0) > 12
        ? "Sum of Column.width/offset should <= 12"
        : null,
    renderCode: (node, cc) => cc.elementCodeWithChildrenSubCtx("div", withClassNameEx(node.htmlAttributes, "row"), node),
    render: (dn, parentCtx) => NodeUtils.withChildrensSubCtx(dn, parentCtx,
        <div {...withClassName(toHtmlAttributes(dn, parentCtx, dn.node.htmlAttributes), "row")} />),
    renderDesigner: dn => (<div>
        <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.field)} />
        <StyleOptionsLine dn={dn} binding={Binding.create(dn.node, n => n.styleOptions)} />
        <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.htmlAttributes)} />
    </div>),
});

export interface ColumnNode extends ContainerNode {
    kind: "Column";
    field?: string;
    styleOptions?: StyleOptionsExpression;
    htmlAttributes?: HtmlAttributesExpression;
    width: ExpressionOrValue<number>;
    offset: ExpressionOrValue<number>;
}

NodeUtils.register<ColumnNode>({
    kind: "Column",
    group: null,
    order: null,
    isContainer: true,
    avoidHighlight: true,
    validParent: "Row",
    validate: dn => NodeUtils.mandatory(dn, n => n.width),
    initialize: dn => dn.width = 6,
    renderTreeNode: NodeUtils.treeNodeKind,
    renderCode: (node, cc) => {
        const className = node.offset == null
            ? bindExpr(column => "col-sm-" + String(column), node.width)
            : bindExpr((column, offset) =>
                classes("col-sm-" + String(column), offset != undefined && "col-sm-offset-" + String(offset)),
                node.width, node.offset);

        return cc.elementCodeWithChildrenSubCtx("div", withClassNameEx(node.htmlAttributes, className as ExpressionOrValue<string>), node);
    },
    render: (dn, parentCtx) => {
        const column = NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.width, NodeUtils.isNumber);
        const offset = NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.offset, NodeUtils.isNumberOrNull);
        const className = classes("col-sm-" + String(column), offset != undefined && "col-sm-offset-" + String(offset));

        return NodeUtils.withChildrensSubCtx(dn, parentCtx,
            <div {...withClassName(toHtmlAttributes(dn, parentCtx, dn.node.htmlAttributes), className)} />);
    },
    renderDesigner: dn => (<div>
        <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.field)} />
        <StyleOptionsLine dn={dn} binding={Binding.create(dn.node, n => n.styleOptions)} />
        <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.htmlAttributes)} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.width)} type="number" options={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]} defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.offset)} type="number" options={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]} defaultValue={null} />
    </div>),
});

// ---- Tabs / Tab -----------------------------------------------------------------------------------------

export interface TabsNode extends ContainerNode {
    kind: "Tabs";
    field?: string;
    styleOptions?: StyleOptionsExpression;
    id: ExpressionOrValue<string>;
    defaultActiveKey?: ExpressionOrValue<string>;
    unmountOnExit?: ExpressionOrValue<boolean>;
}

NodeUtils.register<TabsNode>({
    kind: "Tabs",
    group: "Container",
    order: 2,
    isContainer: true,
    validChild: "Tab",
    initialize: dn => dn.id = "tabs",
    renderTreeNode: NodeUtils.treeNodeKind,
    renderCode: (node, cc) => cc.elementCodeWithChildrenSubCtx("Tabs", {
        // Signum writes `ctx.compose(id)`; altea's equivalent is `getUniqueId`.
        id: { __code__: cc.ctxName + ".getUniqueId(" + toCodeEx(node.id) + ")" } as Expression<string>,
        defaultActiveKey: node.defaultActiveKey,
        unmountOnExit: node.unmountOnExit,
    }, node),
    render: (dn, parentCtx) => NodeUtils.withChildrensSubCtx(dn, parentCtx, <Tabs
        id={parentCtx.getUniqueId(NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.id, NodeUtils.isString)!)}
        defaultActiveKey={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.defaultActiveKey, NodeUtils.isStringOrNull)}
        unmountOnExit={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.unmountOnExit, NodeUtils.isBooleanOrNull)}
    />),
    renderDesigner: dn => (<div>
        <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.field)} />
        <StyleOptionsLine dn={dn} binding={Binding.create(dn.node, n => n.styleOptions)} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.id)} type="string" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.defaultActiveKey)} type="string" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.unmountOnExit)} type="boolean" defaultValue={false} />
    </div>),
});

export interface TabNode extends ContainerNode {
    kind: "Tab";
    field?: string;
    styleOptions?: StyleOptionsExpression;
    title: ExpressionOrValue<string>;
    eventKey: string;
}

NodeUtils.register<TabNode>({
    kind: "Tab",
    group: null,
    order: null,
    isContainer: true,
    avoidHighlight: true,
    validParent: "Tabs",
    initialize: (n, parentNode) => {
        const existing = parentNode.node.children
            .map(a => Number.parseInt((a as TabNode).eventKey?.replace(/^tab/, "") ?? ""))
            .filter(s => Number.isFinite(s));
        const byName = (existing.length > 0 ? Math.max(...existing) : 0) + 1;
        const byPosition = parentNode.node.children.length + 1;
        const index = Math.max(byName, byPosition);
        n.title = "My Tab " + index;
        n.eventKey = "tab" + index;
    },
    renderTreeNode: dn => <span><small>{dn.node.kind}:</small> <strong>{typeof dn.node.title === "string" ? dn.node.title : dn.node.eventKey}</strong></span>,
    validate: dn => NodeUtils.mandatory(dn, n => n.eventKey),
    renderCode: (node, cc) => cc.elementCodeWithChildrenSubCtx("Tab", {
        title: node.title,
        eventKey: node.eventKey,
    }, node),
    render: (dn, parentCtx) => NodeUtils.withChildrensSubCtx(dn, parentCtx, <Tab
        title={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.title, NodeUtils.isString)}
        eventKey={dn.node.eventKey} />),
    renderDesigner: dn => (<div>
        <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.field)} />
        <StyleOptionsLine dn={dn} binding={Binding.create(dn.node, n => n.styleOptions)} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.eventKey)} type="string" defaultValue={null} allowsExpression={false} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.title)} type="string" defaultValue={null} />
    </div>),
});

// ---- Fieldset -------------------------------------------------------------------------------------------

export interface FieldsetNode extends ContainerNode {
    kind: "Fieldset";
    field?: string;
    styleOptions?: StyleOptionsExpression;
    htmlAttributes?: HtmlAttributesExpression;
    legendHtmlAttributes?: HtmlAttributesExpression;
    legend?: ExpressionOrValue<string>;
}

NodeUtils.register<FieldsetNode>({
    kind: "Fieldset",
    group: "Container",
    order: 3,
    isContainer: true,
    initialize: dn => dn.legend = "My Fieldset",
    renderTreeNode: NodeUtils.treeNodeKind,
    renderCode: (node, cc) => cc.elementCode("fieldset", node.htmlAttributes ?? null,
        node.legend ? cc.elementCode("legend", node.legendHtmlAttributes ?? null, toCodeEx(node.legend)) : undefined,
        cc.elementCodeWithChildrenSubCtx("div", null, node)),
    render: (dn, parentCtx) => (
        <fieldset {...toHtmlAttributes(dn, parentCtx, dn.node.htmlAttributes)}>
            {dn.node.legend &&
                <legend {...toHtmlAttributes(dn, parentCtx, dn.node.legendHtmlAttributes)}>
                    {NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.legend, NodeUtils.isStringOrNull)}
                </legend>}
            {NodeUtils.withChildrensSubCtx(dn, parentCtx, <div />)}
        </fieldset>
    ),
    renderDesigner: dn => (<div>
        <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.field)} />
        <StyleOptionsLine dn={dn} binding={Binding.create(dn.node, n => n.styleOptions)} />
        <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.htmlAttributes)} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.legend)} type="string" defaultValue={null} />
        <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.legendHtmlAttributes)} />
    </div>),
});

// ---- Text / Image ---------------------------------------------------------------------------------------

export interface TextNode extends BaseNode {
    kind: "Text";
    htmlAttributes?: HtmlAttributesExpression;
    breakLines?: ExpressionOrValue<boolean>;
    tagName?: ExpressionOrValue<string>;
    message: ExpressionOrValue<string>;
}

NodeUtils.register<TextNode>({
    kind: "Text",
    group: "Container",
    order: 4,
    initialize: dn => { dn.message = "My message"; },
    renderTreeNode: dn => <span><small>{dn.node.kind}:</small> <strong>{shortOf(dn.node.message)}</strong></span>,
    renderCode: (node, cc) => cc.elementCode(
        String(bindExpr(tagName => tagName ?? "p", node.tagName)),
        node.htmlAttributes ?? null,
        toCodeEx(node.message)),
    render: (dn, ctx) => React.createElement(
        NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.tagName, NodeUtils.isStringOrNull) ?? "p",
        toHtmlAttributes(dn, ctx, dn.node.htmlAttributes),
        ...NodeUtils.addBreakLines(
            NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.breakLines, NodeUtils.isBooleanOrNull) || false,
            NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.message, NodeUtils.isString)!)),
    renderDesigner: dn => (<div>
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.tagName)} type="string" defaultValue={"p"}
            options={["p", "span", "div", "pre", "code", "strong", "em", "del", "sub", "sup", "ins", "h1", "h2", "h3", "h4", "h5"]} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.message)} type="textArea" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.breakLines)} type="boolean" defaultValue={false} />
        <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.htmlAttributes)} />
    </div>),
});

export interface ImageNode extends BaseNode {
    kind: "Image";
    htmlAttributes?: HtmlAttributesExpression;
    src?: ExpressionOrValue<string>;
    alt?: ExpressionOrValue<string>;
}

NodeUtils.register<ImageNode>({
    kind: "Image",
    group: "Container",
    order: 5,
    initialize: dn => { dn.src = "/images/logo.png"; },
    renderTreeNode: dn => <span><small>{dn.node.kind}:</small> <strong>{shortOf(dn.node.src)}</strong></span>,
    renderCode: (node, cc) => cc.elementCode("img", node.htmlAttributes ? { src: node.src } : null),
    render: (dn, ctx) => <img {...toHtmlAttributes(dn, ctx, dn.node.htmlAttributes)}
        src={AppContext.toAbsoluteUrl(NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.src, NodeUtils.isString)!)}
        alt={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.alt, NodeUtils.isStringOrNull)} />,
    renderDesigner: dn => (<div>
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.src)} type="string" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.alt)} type="string" defaultValue={null} />
        <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.htmlAttributes)} />
    </div>),
});

// ---- RenderEntity ---------------------------------------------------------------------------------------

export interface RenderEntityNode extends ContainerNode {
    kind: "RenderEntity";
    field?: string;
    viewName?: ExpressionOrValue<string | ((mod: BaseEntity) => string | ViewPromise<BaseEntity>)>;
    styleOptions?: StyleOptionsExpression;
    onEntityLoaded?: Expression<() => void>;
    extraProps?: Expression<object>;
}

NodeUtils.register<RenderEntityNode>({
    kind: "RenderEntity",
    group: "Container",
    order: 5,
    isContainer: true,
    hasEntity: true,
    validate: dn => dn.node.field ? NodeUtils.validateField(dn as unknown as DesignerNode<LineBaseNode>) : undefined,
    renderTreeNode: dn => <span><small>{dn.node.kind}:</small> <strong>{dn.node.field || (typeof dn.node.viewName === "string" ? dn.node.viewName : "")}</strong></span>,
    renderCode: (node, cc) => cc.elementCode("RenderEntity", {
        ctx: cc.subCtxCode(node.field, node.styleOptions),
        getComponent: cc.getGetComponentEx(node, true),
        getViewPromise: NodeUtils.toFunctionCode(node.viewName),
        onEntityLoaded: node.onEntityLoaded,
    }),
    render: (dn, ctx) => {
        const styleOptions = toStyleOptions(dn, ctx, dn.node.styleOptions);
        const sctx = dn.node.field
            ? ctx.subCtx(dn.node.field, styleOptions)
            : styleOptions ? ctx.subCtx(styleOptions) : ctx;

        return (
            <RenderEntity
                ctx={sctx as TypeContext<BaseEntity>}
                getComponent={NodeUtils.getGetComponent(dn)}
                getViewPromise={NodeUtils.toFunction(NodeUtils.evaluateAndValidate(dn, sctx as TypeContext<BaseEntity>, dn.node, n => n.viewName, NodeUtils.isFunctionOrStringOrNull) as never)}
                onEntityLoaded={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.onEntityLoaded, NodeUtils.isFunctionOrNull)}
                extraProps={NodeUtils.evaluateAndValidate(dn, sctx as TypeContext<BaseEntity>, dn.node, n => n.extraProps, NodeUtils.isObjectOrNull)}
            />
        );
    },
    renderDesigner: dn => <div>
        <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.field)} />
        <StyleOptionsLine dn={dn} binding={Binding.create(dn.node, n => n.styleOptions)} />
        <ViewNameComponent dn={dn} binding={Binding.create(dn.node, n => n.viewName)} typeName={dn.route?.type.getTypeName()} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onEntityLoaded)} type={null} defaultValue={null} exampleExpression="() => { /* do something here... */ }" />
        <ExtraPropsComponent dn={dn} />
    </div>,
});

/** Signum's ExtraPropsComponent: when the chosen view is a DYNAMIC one, seed the props object from its declared props. */
function ExtraPropsComponent({ dn }: { dn: DesignerNode<RenderEntityNode> }): React.JSX.Element {

    const typeName = dn.route?.type.getTypeName();
    const fixedViewName = dn.route && typeof dn.node.viewName === "string" ? dn.node.viewName : undefined;

    const isDynamicView = typeName != undefined && fixedViewName != undefined && (() => {
        const es = Navigator.getSettings(typeName);
        const staticViews = ["STATIC", ...(es?.namedViews ? Dic.getKeys(es.namedViews) : [])];
        return !staticViews.includes(fixedViewName);
    })();

    // The hook must run unconditionally (React rules), so the condition goes in the fetch, not around it.
    const viewProps = useAPI(
        () => isDynamicView
            ? DynamicViewClient.API.getDynamicViewProps(typeName!, fixedViewName!)
            : Promise.resolve(undefined),
        [typeName, fixedViewName, isDynamicView]);

    const example = viewProps && viewProps.length > 0
        ? "({\n" + viewProps.map(pr => `  ${pr.name}: null`).join(", \n") + "\n})"
        : undefined;

    return <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.extraProps)}
        type={null} defaultValue={null} exampleExpression={example} />;
}

// ---- CustomContext / TypeIs -----------------------------------------------------------------------------

export interface CustomContextNode extends ContainerNode {
    kind: "CustomContext";
    typeContext: string;
}

NodeUtils.register<CustomContextNode>({
    kind: "CustomContext",
    group: "Container",
    order: 6,
    isContainer: true,
    validate: dn => NodeUtils.mandatory(dn, n => n.typeContext)
        ?? (!DynamicViewClient.registeredCustomContexts[dn.node.typeContext] ? `${dn.node.typeContext} not found` : undefined),
    renderTreeNode: dn => <span><small>{dn.node.kind}:</small> <strong>{dn.node.typeContext}</strong></span>,
    renderCode: (node, cc) => {
        const ncc = DynamicViewClient.registeredCustomContexts[node.typeContext]!.getCodeContext(cc);
        const childrensCode = node.children.map(c => NodeUtils.renderCode(c, ncc));
        return ncc.elementCode("div", null, ...childrensCode);
    },
    render: (dn, parentCtx) => {
        const nctx = DynamicViewClient.registeredCustomContexts[dn.node.typeContext]?.getTypeContext(parentCtx);
        if (!nctx)
            return undefined;

        return NodeUtils.withChildrensSubCtx(dn, nctx as TypeContext<BaseEntity>, <div />);
    },
    renderDesigner: dn => (<div>
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.typeContext)} allowsExpression={false}
            type="string" options={Dic.getKeys(DynamicViewClient.registeredCustomContexts)} defaultValue={null} />
    </div>),
});

export interface TypeIsNode extends ContainerNode {
    kind: "TypeIs";
    typeName: string;
}

NodeUtils.register<TypeIsNode>({
    kind: "TypeIs",
    group: "Container",
    order: 7,
    isContainer: true,
    validate: dn => NodeUtils.mandatory(dn, n => n.typeName)
        ?? (NodeUtils.tryRoot(dn.node.typeName) == undefined ? `Type '${dn.node.typeName}' not found` : undefined),
    renderTreeNode: dn => <span><small>{dn.node.kind}:</small> <strong>{dn.node.typeName}</strong></span>,
    renderCode: (node, cc) => {
        const ncc = cc.createNewContext("ctx" + (cc.usedNames.length + 1));
        cc.assignments[ncc.ctxName] =
            `${cc.ctxName}.value instanceof ${node.typeName}Entity ? ${cc.ctxName}.cast(${node.typeName}Entity) : null`;
        const childrensCode = node.children.map(c => NodeUtils.renderCode(c, ncc));
        return "{" + ncc.ctxName + " && " + ncc.elementCode("div", null, ...childrensCode) + "}";
    },
    render: (dn, parentCtx) => {
        const value = parentCtx.value;
        // Signum compares `parentCtx.value.Type != typeName`; altea has no `.Type` — the runtime check is
        // the constructor's own clean name (see the "no compat accessors" divergence in CLAUDE.md).
        if (!(value instanceof Entity) || cleanTypeName(value.constructor) !== dn.node.typeName)
            return undefined;

        const nctx = TypeContext.root(value, undefined, parentCtx);

        return NodeUtils.withChildrensSubCtx(dn, nctx as TypeContext<BaseEntity>, <div />);
    },
    renderDesigner: dn => (<div>
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.typeName)} allowsExpression={false}
            type="string" options={getTypes(dn.route)} defaultValue={null} />
    </div>),
});

function getTypes(route: PropertyRoute | undefined): string[] | ((query: string) => string[]) {

    if (route == undefined)
        return [];

    const tr = route.type;
    if (tr.isByAll())
        return autoCompleteType;

    const types = tr.typeInfos();
    if (types.length === 0)
        return [];

    return types.map(a => a.ctor == undefined ? "" : cleanTypeName(a.ctor)).filter(n => n !== "");
}

function autoCompleteType(query: string): string[] {
    return getRegisteredTypes()
        .map(ctor => ({ ctor, ti: tryGetTypeInfo(ctor) }))
        .filter(a => a.ti?.kind === "Entity")
        .map(a => cleanTypeName(a.ctor))
        .filter(name => name.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => a.length - b.length)
        .slice(0, 5);
}

// ---- LineBase / AutoLine --------------------------------------------------------------------------------

export interface LineBaseNode extends BaseNode {
    label?: ExpressionOrValue<string>;
    field: string;
    styleOptions?: StyleOptionsExpression;
    readOnly?: ExpressionOrValue<boolean>;
    onChange?: Expression<() => void>;
    labelHtmlAttributes?: HtmlAttributesExpression;
    formGroupHtmlAttributes?: HtmlAttributesExpression;
    mandatory?: ExpressionOrValue<boolean>;
}

export interface AutoLineNode extends LineBaseNode {
    kind: "AutoLine";
    unit?: ExpressionOrValue<string>;
    format?: ExpressionOrValue<string>;
    extraButtons?: Expression<(vl: LineBaseController<LineBaseProps, unknown>) => React.ReactNode>;
}

NodeUtils.register<AutoLineNode>({
    kind: "AutoLine",
    group: "Property",
    order: -1,
    validate: dn => NodeUtils.validateFieldMandatory(dn),
    renderTreeNode: NodeUtils.treeNodeKindField,
    renderCode: (node, cc) => cc.elementCode("AutoLine", {
        ref: node.ref,
        ctx: cc.subCtxCode(node.field, node.styleOptions),
        label: node.label,
        labelHtmlAttributes: node.labelHtmlAttributes,
        formGroupHtmlAttributes: node.formGroupHtmlAttributes,
        unit: node.unit,
        format: node.format,
        readOnly: node.readOnly,
        mandatory: node.mandatory,
        onChange: node.onChange,
        extraButtons: node.extraButtons,
    }),
    render: (dn, ctx) => (<AutoLine
        ctx={ctx.subCtx(dn.node.field, toStyleOptions(dn, ctx, dn.node.styleOptions))}
        label={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.label, NodeUtils.isStringOrNull)}
        labelHtmlAttributes={toHtmlAttributes(dn, ctx, dn.node.labelHtmlAttributes)}
        formGroupHtmlAttributes={toHtmlAttributes(dn, ctx, dn.node.formGroupHtmlAttributes)}
        unit={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.unit, NodeUtils.isStringOrNull)}
        format={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.format, NodeUtils.isStringOrNull)}
        readOnly={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.readOnly, NodeUtils.isBooleanOrNull)}
        mandatory={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.mandatory, NodeUtils.isBooleanOrNull)}
        onChange={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.onChange, NodeUtils.isFunctionOrNull)}
        extraButtons={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.extraButtons, NodeUtils.isFunctionOrNull)}
    />),
    renderDesigner: dn => {
        const m = memberOf(dn.route);
        return (
            <div>
                <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.field)} />
                <StyleOptionsLine dn={dn} binding={Binding.create(dn.node, n => n.styleOptions)} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.label)} type="string" defaultValue={m?.niceToString() ?? ""} />
                <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.labelHtmlAttributes)} />
                <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.formGroupHtmlAttributes)} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.unit)} type="string" defaultValue={m?.unit ?? ""} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.format)} type="string" defaultValue={m?.format ?? ""} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.readOnly)} type="boolean" defaultValue={null} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.mandatory)} type="boolean" defaultValue={null} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onChange)} type={null} defaultValue={false} exampleExpression={"/* you must declare 'forceUpdate' in locals */ \n() => locals.forceUpdate()"} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.extraButtons)} type={null} defaultValue={null} />
            </div>
        );
    },
});

/** Signum's `dn.route.member` is a MemberInfo; altea's route exposes the FieldInfo of the last step. */
function memberOf(route: PropertyRoute | undefined): FieldInfo | undefined {
    if (route == undefined)
        return undefined;
    try {
        return route.fieldInfo;
    } catch {
        return undefined;
    }
}

// ---- MultiValueLine -------------------------------------------------------------------------------------

export interface MultiValueLineNode extends LineBaseNode {
    kind: "MultiValueLine";
    onRenderItem?: ExpressionOrValue<(p: AutoLineProps) => React.ReactElement>;
    onCreate?: ExpressionOrValue<() => Promise<unknown[] | unknown | undefined>>;
    addValueText?: ExpressionOrValue<string>;
}

NodeUtils.register<MultiValueLineNode>({
    kind: "MultiValueLine",
    group: "Property",
    hasCollection: true,
    hasEntity: false,
    order: 0,
    validate: dn => NodeUtils.validateFieldMandatory(dn),
    renderTreeNode: NodeUtils.treeNodeKindField,
    renderCode: (node, cc) => cc.elementCode("MultiValueLine", {
        ref: node.ref,
        ctx: cc.subCtxCode(node.field, node.styleOptions),
        onRenderItem: node.onRenderItem,
        onCreate: node.onCreate,
        addValueText: node.addValueText,
        label: node.label,
        labelHtmlAttributes: node.labelHtmlAttributes,
        formGroupHtmlAttributes: node.formGroupHtmlAttributes,
        readOnly: node.readOnly,
        onChange: node.onChange,
    }),
    render: (dn, ctx) => (
        <MultiValueLine
            ctx={ctx.subCtx(dn.node.field, toStyleOptions(dn, ctx, dn.node.styleOptions)) as never}
            onRenderItem={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.onRenderItem, NodeUtils.isFunctionOrNull)}
            onCreate={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.onCreate, NodeUtils.isFunctionOrNull)}
            addValueText={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.addValueText, NodeUtils.isStringOrNull)}
            label={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.label, NodeUtils.isStringOrNull)}
            labelHtmlAttributes={toHtmlAttributes(dn, ctx, dn.node.labelHtmlAttributes)}
            formGroupHtmlAttributes={toHtmlAttributes(dn, ctx, dn.node.formGroupHtmlAttributes)}
            readOnly={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.readOnly, NodeUtils.isBooleanOrNull)}
            onChange={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.onChange, NodeUtils.isFunctionOrNull)}
        />
    ),
    renderDesigner: dn => {
        const m = memberOf(dn.route);
        return (<div>
            <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.field)} />
            <StyleOptionsLine dn={dn} binding={Binding.create(dn.node, n => n.styleOptions)} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onRenderItem)} type={null} defaultValue={null} exampleExpression="mctx => modules.React.createElement(AutoLine, { ctx: mctx })" />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onCreate)} type={null} defaultValue={null} exampleExpression="() => Promise.resolve(null)" />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.addValueText)} type="string" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.label)} type="string" defaultValue={m?.niceToString() ?? ""} />
            <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.labelHtmlAttributes)} />
            <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.formGroupHtmlAttributes)} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.readOnly)} type="boolean" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onChange)} type={null} defaultValue={false} exampleExpression={"/* you must declare 'forceUpdate' in locals */ \n() => locals.forceUpdate()"} />
        </div>);
    },
});

// ---- EntityBase family ----------------------------------------------------------------------------------

export interface EntityBaseNode extends LineBaseNode, ContainerNode {
    createOnFind?: ExpressionOrValue<boolean>;
    create?: ExpressionOrValue<boolean>;
    onCreate?: Expression<() => Promise<BaseEntity | Lite<Entity> | undefined> | undefined>;
    find?: ExpressionOrValue<boolean>;
    onFind?: Expression<() => Promise<BaseEntity | Lite<Entity> | undefined> | undefined>;
    remove?: ExpressionOrValue<boolean>;
    onRemove?: Expression<(remove: BaseEntity | Lite<Entity>) => Promise<boolean>>;
    view?: ExpressionOrValue<boolean>;
    onView?: Expression<(entity: BaseEntity | Lite<Entity>, pr: PropertyRoute) => Promise<BaseEntity | undefined> | undefined>;
    viewOnCreate?: ExpressionOrValue<boolean>;
    findOptions?: FindOptionsExpr;
    viewName?: ExpressionOrValue<string | ((mod: BaseEntity) => string | ViewPromise<BaseEntity>)>;
}

export interface EntityLineNode extends EntityBaseNode {
    kind: "EntityLine";
    autoComplete?: ExpressionOrValue<AutocompleteConfig<unknown> | null>;
    itemHtmlAttributes?: HtmlAttributesExpression;
}

NodeUtils.register<EntityLineNode>({
    kind: "EntityLine",
    group: "Property",
    order: 1,
    isContainer: true,
    hasEntity: true,
    validate: (dn, ctx) => NodeUtils.validateEntityBase(dn, ctx),
    renderTreeNode: NodeUtils.treeNodeKindField,
    renderCode: (node, cc) => cc.elementCode("EntityLine", cc.getEntityBasePropsEx(node, { showAutoComplete: true })),
    render: (dn, ctx) => (<EntityLine {...NodeUtils.getEntityBaseProps(dn, ctx, { showAutoComplete: true, isEntityLine: true })} />),
    renderDesigner: dn => NodeUtils.designEntityBase(dn, { showAutoComplete: true, isEntityLine: true }),
});

export interface EntityComboNode extends EntityBaseNode {
    kind: "EntityCombo";
}

NodeUtils.register<EntityComboNode>({
    kind: "EntityCombo",
    group: "Property",
    order: 2,
    isContainer: true,
    hasEntity: true,
    validate: (dn, ctx) => NodeUtils.validateEntityBase(dn, ctx),
    renderTreeNode: NodeUtils.treeNodeKindField,
    renderCode: (node, cc) => cc.elementCode("EntityCombo", cc.getEntityBasePropsEx(node, {})),
    render: (dn, ctx) => (<EntityCombo {...NodeUtils.getEntityBaseProps(dn, ctx, {})} />),
    renderDesigner: dn => NodeUtils.designEntityBase(dn, {}),
});

export interface EntityDetailNode extends EntityBaseNode {
    kind: "EntityDetail";
    avoidFieldSet?: ExpressionOrValue<boolean>;
    onEntityLoaded?: Expression<() => void>;
}

NodeUtils.register<EntityDetailNode>({
    kind: "EntityDetail",
    group: "Property",
    order: 3,
    isContainer: true,
    hasEntity: true,
    validate: (dn, ctx) => NodeUtils.validateEntityBase(dn, ctx),
    renderTreeNode: NodeUtils.treeNodeKindField,
    renderCode: (node, cc) => cc.elementCode("EntityDetail", {
        ...cc.getEntityBasePropsEx(node, {}),
        avoidFieldSet: node.avoidFieldSet,
        onEntityLoaded: node.onEntityLoaded,
    }),
    render: (dn, ctx) => (<EntityDetail
        avoidFieldSet={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.avoidFieldSet, NodeUtils.isBooleanOrNull)}
        onEntityLoaded={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.onEntityLoaded, NodeUtils.isFunctionOrNull)}
        {...NodeUtils.getEntityBaseProps(dn, ctx, {})} />),
    renderDesigner: dn =>
        <div>
            {NodeUtils.designEntityBase(dn, {})}
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.avoidFieldSet)} type="boolean" defaultValue={false} allowsExpression={false} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onEntityLoaded)} type={null} defaultValue={null} exampleExpression="() => { /* do something here... */ }" />
        </div>,
});

// ---- file lines -----------------------------------------------------------------------------------------

export interface FileLineNode extends EntityBaseNode {
    kind: "FileLine";
    download?: ExpressionOrValue<DownloadBehaviour>;
    dragAndDrop?: ExpressionOrValue<boolean>;
    dragAndDropMessage?: ExpressionOrValue<string>;
    fileType?: ExpressionOrValue<string>;
    accept?: ExpressionOrValue<string>;
    maxSizeInBytes?: ExpressionOrValue<number>;
}

// altea adds "ViewOrSave" to Signum's three.
const downloadBehaviours: DownloadBehaviour[] = ["SaveAs", "View", "ViewOrSave", "None"];

NodeUtils.register<FileLineNode>({
    kind: "FileLine",
    group: "Property",
    order: 4,
    isContainer: false,
    hasEntity: true,
    validate: dn => NodeUtils.validateFieldMandatory(dn),
    renderTreeNode: NodeUtils.treeNodeKindField,
    renderCode: (node, cc) => cc.elementCode("FileLine", {
        ref: node.ref,
        ctx: cc.subCtxCode(node.field, node.styleOptions),
        label: node.label,
        labelHtmlAttributes: node.labelHtmlAttributes,
        formGroupHtmlAttributes: node.formGroupHtmlAttributes,
        visible: node.visible,
        readOnly: node.readOnly,
        remove: node.remove,
        download: node.download,
        dragAndDrop: node.dragAndDrop,
        dragAndDropMessage: node.dragAndDropMessage,
        fileType: node.fileType,
        accept: node.accept,
        maxSizeInBytes: node.maxSizeInBytes,
        onChange: node.onChange,
    }),
    render: (dn, parentCtx) => (<FileLine
        ctx={parentCtx.subCtx(dn.node.field, toStyleOptions(dn, parentCtx, dn.node.styleOptions)) as never}
        label={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.label, NodeUtils.isStringOrNull)}
        labelHtmlAttributes={toHtmlAttributes(dn, parentCtx, dn.node.labelHtmlAttributes)}
        formGroupHtmlAttributes={toHtmlAttributes(dn, parentCtx, dn.node.formGroupHtmlAttributes)}
        visible={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.visible, NodeUtils.isBooleanOrNull)}
        readOnly={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.readOnly, NodeUtils.isBooleanOrNull)}
        remove={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.remove, NodeUtils.isBooleanOrNull)}
        download={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.download, a => NodeUtils.isInListOrNull(a, downloadBehaviours))}
        dragAndDrop={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.dragAndDrop, NodeUtils.isBooleanOrNull)}
        fileType={toFileTypeSymbol(NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.fileType, NodeUtils.isStringOrNull))}
        accept={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.accept, NodeUtils.isStringOrNull)}
        maxSizeInBytes={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.maxSizeInBytes, NodeUtils.isNumberOrNull)}
        onChange={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.onChange, NodeUtils.isFunctionOrNull)}
    />),
    renderDesigner: dn => {
        const m = memberOf(dn.route);
        return (
            <div>
                <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.field)} />
                <StyleOptionsLine dn={dn} binding={Binding.create(dn.node, n => n.styleOptions)} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.label)} type="string" defaultValue={m?.niceToString() ?? ""} />
                <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.labelHtmlAttributes)} />
                <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.formGroupHtmlAttributes)} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.readOnly)} type="boolean" defaultValue={null} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.remove)} type="boolean" defaultValue={null} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.download)} type="string" defaultValue={null} options={downloadBehaviours} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.dragAndDrop)} type="boolean" defaultValue={null} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.dragAndDropMessage)} type="string" defaultValue={null} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.fileType)} type="string" defaultValue={null} options={getFileTypes()} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.accept)} type="string" defaultValue={null} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.maxSizeInBytes)} type="number" defaultValue={null} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onChange)} type={null} defaultValue={null} exampleExpression={"/* you must declare 'forceUpdate' in locals */ \n() => locals.forceUpdate()"} />
            </div>
        );
    },
});

export interface FileImageLineNode extends EntityBaseNode {
    kind: "FileImageLine";
    dragAndDrop?: ExpressionOrValue<boolean>;
    dragAndDropMessage?: ExpressionOrValue<string>;
    fileType?: ExpressionOrValue<string>;
    accept?: ExpressionOrValue<string>;
    maxSizeInBytes?: ExpressionOrValue<number>;
    imageHtmlAttributes?: HtmlAttributesExpression;
}

NodeUtils.register<FileImageLineNode>({
    kind: "FileImageLine",
    group: "Property",
    order: 5,
    isContainer: false,
    hasEntity: true,
    validate: dn => NodeUtils.validateFieldMandatory(dn),
    renderTreeNode: NodeUtils.treeNodeKindField,
    renderCode: (node, cc) => cc.elementCode("FileImageLine", {
        ref: node.ref,
        ctx: cc.subCtxCode(node.field, node.styleOptions),
        label: node.label,
        labelHtmlAttributes: node.labelHtmlAttributes,
        formGroupHtmlAttributes: node.formGroupHtmlAttributes,
        visible: node.visible,
        readOnly: node.readOnly,
        remove: node.remove,
        dragAndDrop: node.dragAndDrop,
        dragAndDropMessage: node.dragAndDropMessage,
        fileType: node.fileType,
        accept: node.accept,
        maxSizeInBytes: node.maxSizeInBytes,
        onChange: node.onChange,
    }),
    render: (dn, parentCtx) => (<FileImageLine
        ctx={parentCtx.subCtx(dn.node.field, toStyleOptions(dn, parentCtx, dn.node.styleOptions)) as never}
        label={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.label, NodeUtils.isStringOrNull)}
        labelHtmlAttributes={toHtmlAttributes(dn, parentCtx, dn.node.labelHtmlAttributes)}
        formGroupHtmlAttributes={toHtmlAttributes(dn, parentCtx, dn.node.formGroupHtmlAttributes)}
        imageHtmlAttributes={toHtmlAttributes(dn, parentCtx, dn.node.imageHtmlAttributes)}
        visible={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.visible, NodeUtils.isBooleanOrNull)}
        readOnly={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.readOnly, NodeUtils.isBooleanOrNull)}
        remove={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.remove, NodeUtils.isBooleanOrNull)}
        dragAndDrop={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.dragAndDrop, NodeUtils.isBooleanOrNull)}
        fileType={toFileTypeSymbol(NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.fileType, NodeUtils.isStringOrNull))}
        accept={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.accept, NodeUtils.isStringOrNull)}
        maxSizeInBytes={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.maxSizeInBytes, NodeUtils.isNumberOrNull)}
        onChange={NodeUtils.evaluateAndValidate(dn, parentCtx, dn.node, n => n.onChange, NodeUtils.isFunctionOrNull)}
    />),
    renderDesigner: dn => {
        const m = memberOf(dn.route);
        return (
            <div>
                <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.field)} />
                <StyleOptionsLine dn={dn} binding={Binding.create(dn.node, n => n.styleOptions)} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.label)} type="string" defaultValue={m?.niceToString() ?? ""} />
                <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.labelHtmlAttributes)} />
                <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.formGroupHtmlAttributes)} />
                <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.imageHtmlAttributes)} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.readOnly)} type="boolean" defaultValue={null} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.remove)} type="boolean" defaultValue={null} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.dragAndDrop)} type="boolean" defaultValue={null} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.dragAndDropMessage)} type="string" defaultValue={null} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.fileType)} type="string" defaultValue={null} options={getFileTypes()} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.accept)} type="string" defaultValue={null} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.maxSizeInBytes)} type="number" defaultValue={null} />
                <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onChange)} type={null} defaultValue={null} exampleExpression={"/* you must declare 'forceUpdate' in locals */ \n() => locals.forceUpdate()"} />
            </div>
        );
    },
});

export interface MultiFileLineNode extends LineBaseNode {
    kind: "MultiFileLine";
    download?: ExpressionOrValue<DownloadBehaviour>;
    dragAndDrop?: ExpressionOrValue<boolean>;
    dragAndDropMessage?: ExpressionOrValue<string>;
    fileType?: ExpressionOrValue<string>;
    accept?: ExpressionOrValue<string>;
    maxSizeInBytes?: ExpressionOrValue<number>;
}

NodeUtils.register<MultiFileLineNode>({
    kind: "MultiFileLine",
    group: "Property",
    hasCollection: true,
    hasEntity: true,
    order: 6,
    validate: dn => NodeUtils.validateFieldMandatory(dn),
    renderTreeNode: NodeUtils.treeNodeKindField,
    renderCode: (node, cc) => cc.elementCode("MultiFileLine", {
        ref: node.ref,
        ctx: cc.subCtxCode(node.field, node.styleOptions),
        label: node.label,
        labelHtmlAttributes: node.labelHtmlAttributes,
        formGroupHtmlAttributes: node.formGroupHtmlAttributes,
        readOnly: node.readOnly,
        download: node.download,
        dragAndDrop: node.dragAndDrop,
        dragAndDropMessage: node.dragAndDropMessage,
        fileType: node.fileType,
        accept: node.accept,
        maxSizeInBytes: node.maxSizeInBytes,
        onChange: node.onChange,
    }),
    render: (dn, ctx) => (
        <MultiFileLine
            ctx={ctx.subCtx(dn.node.field, toStyleOptions(dn, ctx, dn.node.styleOptions)) as never}
            label={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.label, NodeUtils.isStringOrNull)}
            labelHtmlAttributes={toHtmlAttributes(dn, ctx, dn.node.labelHtmlAttributes)}
            formGroupHtmlAttributes={toHtmlAttributes(dn, ctx, dn.node.formGroupHtmlAttributes)}
            readOnly={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.readOnly, NodeUtils.isBooleanOrNull)}
            download={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.download, a => NodeUtils.isInListOrNull(a, downloadBehaviours))}
            dragAndDrop={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.dragAndDrop, NodeUtils.isBooleanOrNull)}
            fileType={toFileTypeSymbol(NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.fileType, NodeUtils.isStringOrNull))}
            accept={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.accept, NodeUtils.isStringOrNull)}
            maxSizeInBytes={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.maxSizeInBytes, NodeUtils.isNumberOrNull)}
            onChange={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.onChange, NodeUtils.isFunctionOrNull)}
        />
    ),
    renderDesigner: dn => {
        const m = memberOf(dn.route);
        return (<div>
            <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.field)} />
            <StyleOptionsLine dn={dn} binding={Binding.create(dn.node, n => n.styleOptions)} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.label)} type="string" defaultValue={m?.niceToString() ?? ""} />
            <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.labelHtmlAttributes)} />
            <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.formGroupHtmlAttributes)} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.readOnly)} type="boolean" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.download)} type="string" defaultValue={null} options={downloadBehaviours} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.dragAndDrop)} type="boolean" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.dragAndDropMessage)} type="string" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.fileType)} type="string" defaultValue={null} options={getFileTypes()} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.accept)} type="string" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.maxSizeInBytes)} type="number" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onChange)} type={null} defaultValue={false} exampleExpression={"/* you must declare 'forceUpdate' in locals */ \n() => locals.forceUpdate()"} />
        </div>);
    },
});

/**
 * Signum enumerates every SymbolContainer whose name ends in "FileType" and lists its members, because its
 * client TypeInfo blob HAS a "SymbolContainer" kind. altea has none: a symbol is declared with `init()` in
 * a data-layer namespace, so the only way the client knows one exists is that something imported it.
 *
 * Hence a REGISTRY the app fills (`DynamicClient.registerFileTypes`) — the same "declared, not reflected"
 * call altea-agent made for its tools. An app that registers nothing simply gets a free-text field, which
 * still works: the value stored is the symbol KEY either way.
 */
function getFileTypes(): string[] {
    return Object.keys(DynamicViewClient.registeredFileTypes).sort();
}

function toFileTypeSymbol(fileTypeKey?: string): FileTypeSymbol | undefined {
    if (fileTypeKey == undefined)
        return undefined;

    const symbol = DynamicViewClient.registeredFileTypes[fileTypeKey];
    if (symbol == undefined)
        throw new Error(`The FileType '${fileTypeKey}' is not registered.`
            + " Call DynamicClient.registerFileTypes(...) with the app's file types.");

    return symbol;
}

// ---- checkbox lists -------------------------------------------------------------------------------------

export interface EnumCheckboxListNode extends LineBaseNode {
    kind: "EnumCheckboxList";
    columnCount?: ExpressionOrValue<number>;
    columnWidth?: ExpressionOrValue<number>;
    avoidFieldSet?: ExpressionOrValue<boolean>;
}

NodeUtils.register<EnumCheckboxListNode>({
    kind: "EnumCheckboxList",
    group: "Collection",
    order: 0,
    hasCollection: true,
    validate: dn => NodeUtils.validateFieldMandatory(dn),
    renderTreeNode: NodeUtils.treeNodeKindField,
    renderCode: (node, cc) => cc.elementCode("EnumCheckboxList", {
        ref: node.ref,
        ctx: cc.subCtxCode(node.field, node.styleOptions),
        label: node.label,
        avoidFieldSet: node.avoidFieldSet,
        readOnly: node.readOnly,
        columnCount: node.columnCount,
        columnWidth: node.columnWidth,
        onChange: node.onChange,
    }),
    render: (dn, ctx) => (<EnumCheckboxList
        ctx={ctx.subCtx(dn.node.field, toStyleOptions(dn, ctx, dn.node.styleOptions)) as never}
        label={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.label, NodeUtils.isStringOrNull)}
        avoidFieldSet={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.avoidFieldSet, NodeUtils.isBooleanOrNull)}
        readOnly={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.readOnly, NodeUtils.isBooleanOrNull)}
        columnCount={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.columnCount, NodeUtils.isNumberOrNull)}
        columnWidth={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.columnWidth, NodeUtils.isNumberOrNull)}
        onChange={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.onChange, NodeUtils.isFunctionOrNull)}
    />),
    renderDesigner: dn => {
        const m = memberOf(dn.route);
        return (<div>
            <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.field)} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.label)} type="string" defaultValue={m?.niceToString() ?? ""} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.avoidFieldSet)} type="boolean" defaultValue={false} allowsExpression={false} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.readOnly)} type="boolean" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.columnCount)} type="number" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.columnWidth)} type="number" defaultValue={200} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onChange)} type={null} defaultValue={null} exampleExpression={"/* you must declare 'forceUpdate' in locals */ \n() => locals.forceUpdate()"} />
        </div>);
    },
});

export interface EntityListBaseNode extends EntityBaseNode {
    move?: ExpressionOrValue<boolean | ((item: BaseEntity | Lite<Entity>) => boolean)>;
    onFindMany?: Expression<() => Promise<(BaseEntity | Lite<Entity>)[] | undefined> | undefined>;
    filterRows?: Expression<(ctxs: TypeContext<unknown>[]) => TypeContext<unknown>[]>;
}

export interface EntityCheckboxListNode extends EntityListBaseNode {
    kind: "EntityCheckboxList";
    columnCount?: ExpressionOrValue<number>;
    columnWidth?: ExpressionOrValue<number>;
    avoidFieldSet?: ExpressionOrValue<boolean>;
}

NodeUtils.register<EntityCheckboxListNode>({
    kind: "EntityCheckboxList",
    group: "Collection",
    order: 1,
    hasEntity: true,
    hasCollection: true,
    validate: (dn, ctx) => NodeUtils.validateEntityBase(dn, ctx),
    renderTreeNode: NodeUtils.treeNodeKindField,
    renderCode: (node, cc) => cc.elementCode("EntityCheckboxList", {
        ...cc.getEntityBasePropsEx(node, { showMove: false, filterRows: true }),
        columnCount: node.columnCount,
        columnWidth: node.columnWidth,
        avoidFieldSet: node.avoidFieldSet,
    }),
    render: (dn, ctx) => (<EntityCheckboxList {...NodeUtils.getEntityListBaseProps(dn, ctx, { showMove: false, filterRows: true })}
        columnCount={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.columnCount, NodeUtils.isNumberOrNull)}
        columnWidth={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.columnWidth, NodeUtils.isNumberOrNull)}
        avoidFieldSet={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.avoidFieldSet, NodeUtils.isBooleanOrNull)}
    />),
    renderDesigner: dn => <div>
        {NodeUtils.designEntityBase(dn, { filterRows: true })}
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.columnCount)} type="number" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.columnWidth)} type="number" defaultValue={200} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.avoidFieldSet)} type="boolean" defaultValue={false} allowsExpression={false} />
    </div>,
});

// ---- EntityStrip / Repeater / TabRepeater / Table ------------------------------------------------------

export interface EntityStripNode extends EntityListBaseNode {
    kind: "EntityStrip";
    autoComplete?: ExpressionOrValue<AutocompleteConfig<unknown> | null>;
    iconStart?: boolean;
    vertical?: boolean;
}

NodeUtils.register<EntityStripNode>({
    kind: "EntityStrip",
    group: "Collection",
    order: 3,
    isContainer: true,
    hasEntity: true,
    hasCollection: true,
    validate: (dn, ctx) => NodeUtils.validateEntityBase(dn, ctx),
    renderTreeNode: NodeUtils.treeNodeKindField,
    renderCode: (node, cc) => cc.elementCode("EntityStrip", {
        ...cc.getEntityBasePropsEx(node, { showAutoComplete: true, findMany: true, showMove: true, filterRows: true }),
        iconStart: node.iconStart,
        vertical: node.vertical,
    }),
    render: (dn, ctx) => (<EntityStrip
        {...NodeUtils.getEntityListBaseProps(dn, ctx, { showAutoComplete: true, findMany: true, showMove: true, filterRows: true })}
        iconStart={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.iconStart, NodeUtils.isBooleanOrNull)}
        vertical={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.vertical, NodeUtils.isBooleanOrNull)}
    />),
    renderDesigner: dn =>
        <div>
            {NodeUtils.designEntityBase(dn, { showAutoComplete: true, findMany: true, showMove: true, filterRows: true })}
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.iconStart)} type="boolean" defaultValue={false} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.vertical)} type="boolean" defaultValue={false} />
        </div>,
});

export interface EntityRepeaterNode extends EntityListBaseNode {
    kind: "EntityRepeater";
    avoidFieldSet?: ExpressionOrValue<boolean>;
}

NodeUtils.register<EntityRepeaterNode>({
    kind: "EntityRepeater",
    group: "Collection",
    order: 4,
    isContainer: true,
    hasEntity: true,
    hasCollection: true,
    validate: (dn, ctx) => NodeUtils.validateEntityBase(dn, ctx),
    renderTreeNode: NodeUtils.treeNodeKindField,
    renderCode: (node, cc) => cc.elementCode("EntityRepeater", {
        ...cc.getEntityBasePropsEx(node, { findMany: true, showMove: true, filterRows: true }),
        avoidFieldSet: node.avoidFieldSet,
    }),
    render: (dn, ctx) => (<EntityRepeater
        {...NodeUtils.getEntityListBaseProps(dn, ctx, { findMany: true, showMove: true, filterRows: true })}
        avoidFieldSet={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.avoidFieldSet, NodeUtils.isBooleanOrNull)}
    />),
    renderDesigner: dn =>
        <div>
            {NodeUtils.designEntityBase(dn, { findMany: true, showMove: true, filterRows: true })}
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.avoidFieldSet)} type="boolean" defaultValue={false} allowsExpression={false} />
        </div>,
});

export interface EntityTabRepeaterNode extends EntityListBaseNode {
    kind: "EntityTabRepeater";
    avoidFieldSet?: ExpressionOrValue<boolean>;
}

NodeUtils.register<EntityTabRepeaterNode>({
    kind: "EntityTabRepeater",
    group: "Collection",
    order: 5,
    isContainer: true,
    hasEntity: true,
    hasCollection: true,
    validate: (dn, ctx) => NodeUtils.validateEntityBase(dn, ctx),
    renderTreeNode: NodeUtils.treeNodeKindField,
    renderCode: (node, cc) => cc.elementCode("EntityTabRepeater", {
        ...cc.getEntityBasePropsEx(node, { findMany: true, showMove: true, filterRows: true }),
        avoidFieldSet: node.avoidFieldSet,
    }),
    render: (dn, ctx) => (<EntityTabRepeater
        {...NodeUtils.getEntityListBaseProps(dn, ctx, { findMany: true, showMove: true, filterRows: true })}
        avoidFieldSet={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.avoidFieldSet, NodeUtils.isBooleanOrNull)} />),
    renderDesigner: dn =>
        <div>
            {NodeUtils.designEntityBase(dn, { findMany: true, showMove: true, filterRows: true })}
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.avoidFieldSet)} type="boolean" defaultValue={false} allowsExpression={false} />
        </div>,
});

export interface EntityTableNode extends EntityListBaseNode {
    kind: "EntityTable";
    avoidFieldSet?: ExpressionOrValue<boolean>;
    scrollable?: ExpressionOrValue<boolean>;
    maxResultsHeight?: Expression<number | string>;
}

NodeUtils.register<EntityTableNode>({
    kind: "EntityTable",
    group: "Collection",
    order: 6,
    isContainer: true,
    hasEntity: true,
    hasCollection: true,
    validChild: "EntityTableColumn",
    validate: (dn, ctx) => NodeUtils.validateEntityBase(dn, ctx),
    renderTreeNode: NodeUtils.treeNodeKindField,
    renderCode: (node, cc) => cc.elementCode("EntityTable", {
        ...cc.getEntityBasePropsEx(node, { findMany: true, showMove: true, avoidGetComponent: true, filterRows: true }),
        avoidFieldSet: node.avoidFieldSet,
        scrollable: node.scrollable,
        maxResultsHeight: node.maxResultsHeight,
        // Signum emits `EntityTable.typedColumns<T>(…)`; altea's `columns` prop takes the array directly.
        columns: {
            __code__: cc.stringifyObject(node.children.map(col =>
                ({ __code__: NodeUtils.renderCode(col, cc) }))),
        } as Expression<unknown>,
    }),
    render: (dn, ctx) => (<EntityTable
        columns={dn.node.children.length === 0 ? undefined : dn.node.children
            .filter(c => (c.visible == undefined || NodeUtils.evaluateAndValidate(dn, ctx, c, n => n.visible, NodeUtils.isBooleanOrNull))
                && NodeUtils.validate(dn.createChild(c), ctx) == null)
            .map(col => NodeUtils.render(dn.createChild(col), ctx) as never)}
        {...NodeUtils.getEntityListBaseProps(dn, ctx, { findMany: true, showMove: true, avoidGetComponent: true, filterRows: true })}
        avoidFieldSet={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.avoidFieldSet, NodeUtils.isBooleanOrNull)}
        scrollable={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.scrollable, NodeUtils.isBooleanOrNull)}
        maxResultsHeight={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.maxResultsHeight, NodeUtils.isNumberOrStringOrNull)}
    />),
    renderDesigner: dn =>
        <div>
            {NodeUtils.designEntityBase(dn, { findMany: true, showMove: true, filterRows: true })}
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.avoidFieldSet)} type="boolean" defaultValue={false} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.scrollable)} type="boolean" defaultValue={false} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.maxResultsHeight)} type={null} defaultValue={null} />
        </div>,
});

export interface EntityTableColumnNode extends ContainerNode {
    kind: "EntityTableColumn";
    property?: string;
    header?: string;
    headerHtmlAttributes?: HtmlAttributesExpression;
    cellHtmlAttributes?: HtmlAttributesExpression;
}

NodeUtils.register<EntityTableColumnNode>({
    kind: "EntityTableColumn",
    group: null,
    order: null,
    isContainer: true,
    avoidHighlight: true,
    validParent: "EntityTable",
    validate: dn => dn.node.property ? undefined : NodeUtils.mandatory(dn, n => n.header),
    renderTreeNode: NodeUtils.treeNodeTableColumnProperty,
    renderCode: (node, cc) => cc.stringifyObject({
        property: node.property ? { __code__: "a => a." + node.property } : undefined,
        header: node.header,
        headerHtmlAttributes: node.headerHtmlAttributes,
        cellHtmlAttributes: node.cellHtmlAttributes,
        template: cc.getGetComponentEx(node, false),
    }),
    // A column is DATA, not an element — Signum casts through EntityTableColumn the same way.
    render: (dn, ctx) => ({
        property: dn.node.property,
        header: NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.header, NodeUtils.isStringOrNull),
        headerHtmlAttributes: toHtmlAttributes(dn, ctx, dn.node.headerHtmlAttributes),
        cellHtmlAttributes: toHtmlAttributes(dn, ctx, dn.node.cellHtmlAttributes),
        template: NodeUtils.getGetComponent(dn),
    }) as unknown as EntityTableColumn<BaseEntity, never> as never,
    renderDesigner: dn => <div>
        <FieldComponent dn={dn} binding={Binding.create(dn.node, n => n.property)} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.header)} type="string" defaultValue={null} />
        <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.headerHtmlAttributes)} />
        <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.cellHtmlAttributes)} />
    </div>,
});

// ---- SearchControl / SearchValueLine --------------------------------------------------------------------

export interface SearchControlNode extends BaseNode {
    kind: "SearchControl";
    findOptions?: FindOptionsExpr;
    searchOnLoad?: ExpressionOrValue<boolean>;
    showContextMenu?: Expression<(fop: FindOptionsParsed) => boolean | "Basic">;
    extraButtons?: Expression<(searchControl: SearchControlLoaded) => (ButtonBarElement | null | undefined | false)[]>;
    viewName?: ExpressionOrValue<string | ((mod: BaseEntity) => string | ViewPromise<BaseEntity>)>;
    showHeader?: ExpressionOrValue<boolean>;
    showFilters?: ExpressionOrValue<boolean>;
    showFilterButton?: ExpressionOrValue<boolean>;
    showFooter?: ExpressionOrValue<boolean>;
    showGroupButton?: ExpressionOrValue<boolean>;
    showBarExtension?: ExpressionOrValue<boolean>;
    hideFullScreenButton?: ExpressionOrValue<boolean>;
    allowSelection?: ExpressionOrValue<boolean>;
    allowChangeColumns?: ExpressionOrValue<boolean>;
    create?: ExpressionOrValue<boolean>;
    onCreate?: Expression<() => Promise<undefined | EntityPack<Entity> | BaseEntity | "no_change">>;
    navigate?: ExpressionOrValue<boolean>;
    deps?: Expression<React.DependencyList | undefined>;
    maxResultsHeight?: Expression<number | string>;
    onSearch?: Expression<(fo: FindOptionsParsed, dataChange: boolean) => void>;
    onResult?: Expression<(table: ResultTable, dataChange: boolean) => void>;
}

NodeUtils.register<SearchControlNode>({
    kind: "SearchControl",
    group: "Search",
    order: 1,
    validate: (dn, ctx) => NodeUtils.mandatory(dn, n => n.findOptions)
        ?? (dn.node.findOptions && NodeUtils.validateFindOptions(dn.node.findOptions, ctx)),
    renderTreeNode: dn => <span><small>SearchControl:</small> <strong>{dn.node.findOptions?.queryName ?? " - "}</strong></span>,
    renderCode: (node, cc) => cc.elementCode("SearchControl", {
        ref: node.ref,
        findOptions: node.findOptions,
        searchOnLoad: node.searchOnLoad,
        showContextMenu: node.showContextMenu,
        extraButtons: node.extraButtons,
        getViewPromise: NodeUtils.toFunctionCode(node.viewName),
        showHeader: node.showHeader,
        showFilters: node.showFilters,
        showFilterButton: node.showFilterButton,
        showFooter: node.showFooter,
        showGroupButton: node.showGroupButton,
        showBarExtension: node.showBarExtension,
        hideFullScreenButton: node.hideFullScreenButton,
        allowSelection: node.allowSelection,
        allowChangeColumns: node.allowChangeColumns,
        create: node.create,
        onCreate: node.onCreate,
        navigate: node.navigate,
        deps: node.deps,
        maxResultsHeight: node.maxResultsHeight,
        onSearch: node.onSearch,
        onResult: node.onResult,
    }),
    render: (dn, ctx) => <SearchControl
        findOptions={toFindOptions(dn, ctx, dn.node.findOptions!)}
        getViewPromise={NodeUtils.toFunction(NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.viewName, NodeUtils.isFunctionOrStringOrNull) as never)}
        searchOnLoad={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.searchOnLoad, NodeUtils.isBooleanOrNull)}
        showContextMenu={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.showContextMenu, NodeUtils.isFunctionOrNull)}
        extraButtons={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.extraButtons, NodeUtils.isFunctionOrNull)}
        showHeader={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.showHeader, NodeUtils.isBooleanOrNull)}
        showFilters={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.showFilters, NodeUtils.isBooleanOrNull)}
        showFilterButton={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.showFilterButton, NodeUtils.isBooleanOrNull)}
        showFooter={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.showFooter, NodeUtils.isBooleanOrNull)}
        showGroupButton={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.showGroupButton, NodeUtils.isBooleanOrNull)}
        showBarExtension={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.showBarExtension, NodeUtils.isBooleanOrNull)}
        hideFullScreenButton={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.hideFullScreenButton, NodeUtils.isBooleanOrNull)}
        allowSelection={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.allowSelection, NodeUtils.isBooleanOrNull)}
        allowChangeColumns={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.allowChangeColumns, NodeUtils.isBooleanOrNull)}
        create={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.create, NodeUtils.isBooleanOrNull)}
        onCreate={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.onCreate, NodeUtils.isFunctionOrNull)}
        view={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.navigate, NodeUtils.isBooleanOrNull)}
        deps={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.deps, NodeUtils.isArrayOrNull) as React.DependencyList | undefined}
        maxResultsHeight={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.maxResultsHeight, NodeUtils.isNumberOrStringOrNull)}
        onSearch={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.onSearch, NodeUtils.isFunctionOrNull)}
        onResult={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.onResult, NodeUtils.isFunctionOrNull)}
    />,
    renderDesigner: dn => <div>
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.ref)} type={null} defaultValue={true} />
        <FindOptionsLine dn={dn} binding={Binding.create(dn.node, a => a.findOptions)} />
        <FetchQueryRootType queryName={dn.node.findOptions?.queryName}>
            {typeName => <ViewNameComponent dn={dn} binding={Binding.create(dn.node, n => n.viewName)} typeName={typeName} />}
        </FetchQueryRootType>
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.searchOnLoad)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.showContextMenu)} type={null} defaultValue={null} exampleExpression={`fop => "Basic"`} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.extraButtons)} type={null} defaultValue={null} exampleExpression={`sc => [
  {
    order: -1.1,
    button: modules.React.createElement("button", { className: "btn btn-light", title: "Setting", onClick: e => alert(e) },
      modules.React.createElement(modules.FontAwesomeIcon, { icon: "gear", color: "green" }), " ", "Setting")
  },
]`} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.showHeader)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.showFilters)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.showFilterButton)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.showFooter)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.showGroupButton)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.showBarExtension)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.hideFullScreenButton)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.allowSelection)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.allowChangeColumns)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.create)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.onCreate)} type={null} defaultValue={null} exampleExpression={`() =>
{
    modules.Constructor.constructPack("YourTypeHere").then(pack => {
        if (pack == undefined)
            return;

        /* Set entity properties here... */
        /* pack.entity.[propertyName] = ... */
        modules.Navigator.view(pack);
    });
}`} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.navigate)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.deps)} type={null} defaultValue={null} exampleExpression="[ctx.frame.refreshCount]" />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.maxResultsHeight)} type={null} defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.onSearch)} type={null} defaultValue={null} exampleExpression="(fop, dataChange) => {}" />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.onResult)} type={null} defaultValue={null} exampleExpression="(table, dataChange) => dataChange && ctx.frame.onReload()" />
    </div>,
});

export interface SearchValueLineNode extends BaseNode {
    kind: "SearchValueLine";
    findOptions?: FindOptionsExpr;
    valueToken?: string;
    label?: ExpressionOrValue<string>;
    labelHtmlAttributes?: HtmlAttributesExpression;
    isBadge?: ExpressionOrValue<boolean>;
    isLink?: ExpressionOrValue<boolean>;
    isFormControl?: ExpressionOrValue<boolean>;
    findButton?: ExpressionOrValue<boolean>;
    viewEntityButton?: ExpressionOrValue<boolean>;
    deps?: Expression<React.DependencyList | undefined>;
    formGroupHtmlAttributes?: HtmlAttributesExpression;
}

NodeUtils.register<SearchValueLineNode>({
    kind: "SearchValueLine",
    group: "Search",
    order: 1,
    validate: (dn, ctx) => {
        if (!dn.node.findOptions && !dn.node.valueToken)
            return DynamicViewValidationMessage.Member0IsMandatoryFor1.niceToString("findOptions (or valueToken)", dn.node.kind);

        if (dn.node.findOptions) {
            const error = NodeUtils.validateFindOptions(dn.node.findOptions, ctx);
            if (error)
                return error;
        }

        if (dn.node.valueToken && !dn.node.findOptions && ctx) {
            const route = ctx.propertyRoute;
            const name = route?.type.getTypeName() ?? "";
            if (!route?.type.is(Entity))
                return DynamicViewValidationMessage.ValueTokenCanNotBeUseFor0BecauseIsNotAnEntity.niceToString(name);
        }

        return null;
    },
    renderTreeNode: dn => <span><small>SearchValueLine:</small> <strong>{
        dn.node.valueToken ? dn.node.valueToken
            : dn.node.findOptions ? dn.node.findOptions.queryName : " - "
    }</strong></span>,
    renderCode: (node, cc) => cc.elementCode("SearchValueLine", {
        ref: node.ref,
        ctx: cc.subCtxCode(),
        findOptions: node.findOptions,
        valueToken: node.valueToken,
        label: node.label,
        isBadge: node.isBadge,
        isLink: node.isLink,
        isFormControl: node.isFormControl,
        findButton: node.findButton,
        viewEntityButton: node.viewEntityButton,
        labelHtmlAttributes: node.labelHtmlAttributes,
        formGroupHtmlAttributes: node.formGroupHtmlAttributes,
        deps: node.deps,
    }),
    render: (dn, ctx) => <SearchValueLine ctx={ctx}
        findOptions={dn.node.findOptions && toFindOptions(dn, ctx, dn.node.findOptions)}
        valueToken={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.valueToken, NodeUtils.isStringOrNull)}
        label={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.label, NodeUtils.isStringOrNull)}
        isBadge={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.isBadge, NodeUtils.isBooleanOrNull)}
        isLink={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.isLink, NodeUtils.isBooleanOrNull)}
        isFormControl={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.isFormControl, NodeUtils.isBooleanOrNull)}
        findButton={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.findButton, NodeUtils.isBooleanOrNull)}
        viewEntityButton={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.viewEntityButton, NodeUtils.isBooleanOrNull)}
        labelHtmlAttributes={toHtmlAttributes(dn, ctx, dn.node.labelHtmlAttributes)}
        formGroupHtmlAttributes={toHtmlAttributes(dn, ctx, dn.node.formGroupHtmlAttributes)}
        deps={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, f => f.deps, NodeUtils.isArrayOrNull) as React.DependencyList | undefined}
    />,
    renderDesigner: dn => (<div>
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.ref)} type={null} defaultValue={true} />
        <QueryTokenLine dn={dn} binding={Binding.create(dn.node, a => a.valueToken)}
            queryKey={dn.node.findOptions?.queryName ?? rootQueryKeyOf(dn.route)}
            subTokenOptions={SubTokensOptions.CanAggregate | SubTokensOptions.CanElement} />
        <FindOptionsLine dn={dn} binding={Binding.create(dn.node, a => a.findOptions)} onQueryChanged={() => dn.node.valueToken = undefined} />
        <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.labelHtmlAttributes)} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.label)} type="string" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.isBadge)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.isLink)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.isFormControl)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.findButton)} type="boolean" defaultValue={null} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.viewEntityButton)} type="boolean" defaultValue={null} />
        <HtmlAttributesLine dn={dn} binding={Binding.create(dn.node, n => n.formGroupHtmlAttributes)} />
        <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, f => f.deps)} type={null} defaultValue={null} exampleExpression="[ctx.frame.refreshCount]" />
    </div>),
});

/** Signum's `isTypeEntity(name) ? name : route.findRootType().name`. */
function rootQueryKeyOf(route: PropertyRoute | undefined): string | undefined {
    if (route == undefined)
        return undefined;

    if (route.type.is(Entity))
        return route.type.getTypeName();

    return cleanTypeName(route.rootType);
}

// ---- Button ---------------------------------------------------------------------------------------------

export interface ButtonNode extends BaseNode {
    kind: "Button";
    name: string;
    operationName?: string;
    onOperationClick?: ExpressionOrValue<(e: EntityOperationContext<Entity>) => Promise<void>>;
    canExecute?: ExpressionOrValue<string>;
    text?: ExpressionOrValue<string>;
    active?: ExpressionOrValue<boolean>;
    color?: ExpressionOrValue<string>;
    icon?: ExpressionOrValue<string>;
    iconColor?: ExpressionOrValue<string>;
    disabled?: ExpressionOrValue<boolean>;
    outline?: ExpressionOrValue<boolean>;
    onClick?: ExpressionOrValue<(e: React.MouseEvent) => void>;
    size?: ExpressionOrValue<string>;
    className?: ExpressionOrValue<string>;
}

NodeUtils.register<ButtonNode>({
    kind: "Button",
    group: "Simple",
    hasCollection: false,
    hasEntity: false,
    order: 0,
    renderTreeNode: dn => <span><small>Button:</small> <strong>{dn.node.name}</strong></span>,
    renderCode: (node, cc) => cc.elementCode(node.operationName ? "OperationButton" : "Button", {
        ref: node.ref,
        eoc: node.operationName
            ? { __code__: `EntityOperationContext.fromTypeContext(${cc.subCtxCode().__code__}, "${node.operationName}")` }
            : undefined,
        onOperationClick: node.onOperationClick,
        canExecute: node.canExecute,
        active: node.active,
        color: node.color,
        icon: node.icon,
        iconColor: node.iconColor,
        disabled: node.disabled,
        outline: node.outline,
        onClick: node.onClick,
        size: node.size,
        className: node.className,
    }),
    render: (dn, ctx) => {

        const icon = NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.icon, NodeUtils.isStringOrNull);
        const pIcon = parseIcon(icon);
        const iconColor = NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.iconColor, NodeUtils.isStringOrNull);

        const children = pIcon || iconColor ? <>
            {pIcon && <FontAwesomeIcon icon={pIcon} color={iconColor} className="me-2" />}
            {NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.text, NodeUtils.isStringOrNull)}
        </> : undefined;

        if (dn.node.operationName) {
            const eoc = EntityOperationContext.fromTypeContext(ctx as TypeContext<Entity>, dn.node.operationName);
            return (
                <OperationButton
                    eoc={eoc}
                    canExecute={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.canExecute, NodeUtils.isStringOrNull)}
                    onOperationClick={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.onOperationClick, NodeUtils.isFunctionOrNull)}
                    disabled={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.disabled, NodeUtils.isBooleanOrNull)}
                    className={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.className, NodeUtils.isStringOrNull)}
                    variant={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.color, NodeUtils.isStringOrNull) as BsColor}
                    size={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.size, NodeUtils.isStringOrNull) as BsSize as never}
                >
                    {children}
                </OperationButton>
            );
        }

        return (
            <Button
                active={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.active, NodeUtils.isBooleanOrNull)}
                disabled={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.disabled, NodeUtils.isBooleanOrNull)}
                onClick={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.onClick, NodeUtils.isFunctionOrNull)}
                className={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.className, NodeUtils.isStringOrNull)}
                variant={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.color, NodeUtils.isStringOrNull) as BsColor}
                size={NodeUtils.evaluateAndValidate(dn, ctx, dn.node, n => n.size, NodeUtils.isStringOrNull) as BsSize as never}
            >
                {children}
            </Button>
        );
    },
    renderDesigner: dn => {

        // Signum reads `ti.operations`; in altea operations are per-ROLE metadata (CLAUDE.md), so they come
        // from the metadata blob through getOperationInfos.
        const ctor = dn.route?.type.getFunction();
        const operations = ctor == undefined ? [] : getOperationInfos(ctor).map(o => o.key);

        return (<div>
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.name)} type="string" defaultValue={null} allowsExpression={false} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.operationName)} type="string" defaultValue={null} allowsExpression={false}
                options={operations} refreshView={() => {
                    if (dn.node.operationName == null) {
                        delete dn.node.canExecute;
                        delete dn.node.onOperationClick;
                    }
                    dn.context.refreshView();
                }} />
            {dn.node.operationName && <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.canExecute)} type="string" defaultValue={null} />}
            {dn.node.operationName && <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onOperationClick)} type={null} defaultValue={false} exampleExpression="(eoc) => eoc.defaultClick()" />}
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.text)} type="string" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.color)} type="string" defaultValue={null}
                options={["primary", "secondary", "success", "danger", "warning", "info", "light", "dark"] as BsColor[]} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.size)} type="string" defaultValue={null}
                options={["lg", "md", "sm", "xs"] as BsSize[]} />
{/* Signum offers an IconTypeahead here; altea has no icon picker, so the icon is typed as text
                (e.g. "gear", "fas fa-gear") — parseIcon accepts the same strings either way. */}
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.icon)} type="string" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.iconColor)} type="string" defaultValue={null}
                onRenderValue={(val, e) => <input type="color" value={val as string | undefined}
                    className="form-control form-control-xs" onChange={ev => e.updateValue(ev.currentTarget.value)} />} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.active)} type="boolean" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.disabled)} type="boolean" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.onClick)} type={null} defaultValue={false} exampleExpression={"/* you must declare 'forceUpdate' in locals */ \n(e) => locals.forceUpdate()"} />
            <ExpressionOrValueComponent dn={dn} binding={Binding.create(dn.node, n => n.className)} type="string" defaultValue={null} />
        </div>);
    },
});

// ---- the default-tree builder ---------------------------------------------------------------------------

export namespace NodeConstructor {

    export function createDefaultNode(ti: TypeInfo): DivNode {
        return {
            kind: "Div",
            children: ti.ctor == undefined ? [] : createSubChildren(PropertyRoute.root(ti.ctor)),
        } as DivNode;
    }

    export function createEntityTableSubChildren(pr: PropertyRoute): BaseNode[] {
        return Object.entries(pr.subMembers())
            .filter(([field, fi]) => field !== "id" && !fi.noSerialize)
            .map(([field]) => field)
            .map(field => ({ kind: "EntityTableColumn", property: field, children: [] }) as unknown as BaseNode);
    }

    export function createSubChildren(pr: PropertyRoute): BaseNode[] {
        const subMembers = pr.subMembers();

        return Object.entries(subMembers)
            .map(([field, fi]) => appropiateComponent(fi, field))
            .filter((a): a is BaseNode => a != undefined);
    }

    export const specificComponents: {
        [typeName: string]: (fi: FieldInfo, field: string) => BaseNode | undefined;
    } = {};

    /**
     * Signum's `appropiateComponent` — pick the node kind that fits a field. Kept case for case; the only
     * behavioural differences are the two facets altea does not ship to the client (`mi.notVisible` and
     * `mi.defaultFileTypeInfo.onlyImages`), so nothing is hidden automatically and a FilePath field starts
     * as a FileLine rather than a FileImageLine.
     */
    export const appropiateComponent = (fi: FieldInfo, field: string): BaseNode | undefined => {
        // Signum skips `Id` and anything `notVisible`. altea has no notVisible, but it does mark the
        // bookkeeping props `@serialize(false)` — `isNew` / `ticks` / `_snapshot` — and PropertyRoute's own
        // route generation skips exactly those. Without this a generated tree renders three AutoLines over
        // internals that have no PropertyRoute, which fails at render time.
        if (field === "id" || fi.noSerialize)
            return undefined;

        // altea's FieldInfo EXTENDS TypeReference (CLAUDE.md), so the field IS the type descriptor:
        // Signum's `mi.type` is just `fi` here.
        const tr = fi;
        const typeName = tr.getTypeName() ?? "";

        const sc = specificComponents[typeName];
        if (sc) {
            const result = sc(fi, field);
            if (result)
                return result;
        }

        const tis = tr.typeInfos();
        const ti = tis.length > 0 ? tis[0] : undefined;
        const isEmbedded = tr.is(EmbeddedEntity);

        if (tr.array) {
            if (tr.isByAll())
                return { kind: "EntityStrip", field, children: [] } as unknown as EntityStripNode;
            if (!ti && !isEmbedded)
                return { kind: "MultiValueLine", field, children: [] } as unknown as MultiValueLineNode;
            if (isEmbedded || ti!.entityKind === "Part" || ti!.entityKind === "SharedPart")
                return { kind: "EntityTable", field, children: [] } as unknown as EntityTableNode;
            if (ti!.lowPopulation)
                return { kind: "EntityCheckboxList", field, children: [] } as unknown as EntityCheckboxListNode;
            return { kind: "EntityStrip", field, children: [] } as unknown as EntityStripNode;
        }

        if (tr.isByAll())
            return { kind: "EntityLine", field, children: [] } as unknown as EntityLineNode;

        if (ti) {
            // Signum tests `ti.kind == "Enum"`; altea's TypeInfo.kind is "Entity" | "Model" and an enum is
            // a facet of the TYPE REFERENCE (`isEnum`), so the question is asked of the field.
            if (tr.isEnum)
                return { kind: "AutoLine", field } as unknown as AutoLineNode;

            if (ti.entityKind === "Part" || ti.entityKind === "SharedPart")
                return { kind: "EntityDetail", field, children: [] } as unknown as EntityDetailNode;

            if (ti.lowPopulation)
                return { kind: "EntityCombo", field, children: [] } as unknown as EntityComboNode;

            return { kind: "EntityLine", field, children: [] } as unknown as EntityLineNode;
        }

        if (isEmbedded) {
            const ctor = tr.getFunction();
            if (ctor === FileEmbedded || ctor === FilePathEmbedded)
                return { kind: "FileLine", field } as unknown as FileLineNode;

            return { kind: "EntityDetail", field, children: [] } as unknown as EntityDetailNode;
        }

        return { kind: "AutoLine", field } as unknown as AutoLineNode;
    };
}
