import "@altea/altea/data/globals/arrayExtensions";
import * as React from "react";
import { Link, useParams } from "react-router";
import { Collapse } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import * as AppContext from "@altea/altea/client/AppContext";
import { useTitle } from "@altea/altea/client/AppContext";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { Operations } from "@altea/altea/client/Operations";
import { useAPI, useAPIWithReload, useForceUpdate } from "@altea/altea/client/Hooks";
import { TypeContext, mlistItemContext } from "@altea/altea/client/TypeContext";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { getOperationInfos, tryGetTypeInfo } from "@altea/altea/client/Reflection";
import { classes } from "@altea/altea/data/globals";
import { Entity } from "@altea/altea/data/entity";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import {
    HelpMessage, TypeHelpEntity, TypeHelpOperation,
    type QueryHelpEntity, type QueryHelpEntity_Column,
    type TypeHelpEntity_Operation, type TypeHelpEntity_Property,
} from "../../data/Help";
import { HelpClient } from "../HelpClient";
import { EditableHtml, HtmlViewer } from "../Editor/EditableHtml";
import { Shortcut, useHash } from "./Shortcut";

// Port of Signum.Help's Pages/TypeHelpPage.tsx — one type's page: its own description, then a definition
// list per property (nested ones collapsed under their parent), per operation and per query.
//
// altea divergences:
//  - a `@part` ROW array replaces every MList, so `mlistItemContext` walks plain entities and there is no
//    `.element` hop;
//  - `phCtx.value.property.path` becomes `propertyRoute` (a route STRING — altea has no
//    PropertyRouteEntity), parsed with `PropertyRoute.parse`;
//  - the operation label comes from `getOperationInfos` (the metadata blob), not from a TypeInfo field;
//  - `getNiceTypeName(pr.member.type)` has no counterpart, so a collapsed sub-property group is labelled
//    with the member's own nice name and its type's nice name is read off the route.
export default function TypeHelpPage(): React.JSX.Element {

    const params = useParams() as { cleanName: string };
    const cleanName = params.cleanName;
    const hash = useHash();

    const [typeHelp, reload] = useAPIWithReload(() => HelpClient.API.type(cleanName), [cleanName]);
    const namespaceHelp = useAPI(
        () => typeHelp?.namespace == null ? Promise.resolve(undefined) : HelpClient.API.namespaceHelp(typeHelp.namespace),
        [typeHelp]);
    const forceUpdate = useForceUpdate();

    React.useEffect(() => {
        const elem = hash && document.getElementById(hash);
        if (elem)
            elem.scrollIntoView({ block: "center" });
    }, [hash, typeHelp]);

    useTitle(HelpMessage.Help.niceToString()
        + (namespaceHelp ? " > " + namespaceHelp.title : "")
        + " > " + (tryGetTypeInfo(cleanName)?.getNiceName() ?? cleanName));

    if (typeHelp == null || typeHelp.type.cleanName !== cleanName)
        return <div className="container"><h1 className="display-6">{JavascriptMessage.loading.niceToString()}</h1></div>;

    const ctx = TypeContext.root(typeHelp, { readOnly: Navigator.isReadOnly(TypeHelpEntity) });

    // The property rows as a TREE, so an embedded's members collapse under it (Signum's same shape).
    const propertyTree = mlistItemContext(ctx.subCtx(th => th.properties))
        .map(phCtx => ({ ctx: phCtx, pr: PropertyRoute.parse(Entity.resolveType(cleanName), phCtx.value.propertyRoute) }))
        .toTree(t => t.pr.propertyString(), t => {
            const parent = t.pr.parent;
            if (parent == null || parent.propertyRouteType === "Root" || parent.propertyRouteType === "Mixin")
                return null;
            if (parent.propertyRouteType === "MListItems")
                return parent.parent?.propertyString() ?? null;
            return parent.propertyString();
        });

    return (
        <div className="container">
            <h1 className="display-6">
                <Link to={HelpClient.Urls.indexUrl()}>{HelpMessage.Help.niceToString()}</Link>
                {" > "}
                {namespaceHelp && <Link to={HelpClient.Urls.namespaceUrl(namespaceHelp.namespace)}>{namespaceHelp.title}</Link>}
                {" > "}
                {tryGetTypeInfo(cleanName)?.getNiceName() ?? cleanName}
                <small className="ms-5 text-muted display-7">({ctx.value.culture.englishName})</small>
            </h1>

            <div className="shortcut-container">
                <Shortcut text={`[t:${cleanName}]`} />
                <HtmlViewer htmlAttributes={{ className: "sf-info" }} text={typeHelp.info} />
            </div>

            <EditableHtml key="__type_help_main_editor__"
                ctx={ctx.subCtx(a => a.description)}
                defaultEditable={typeHelp.isNew}
                onChange={forceUpdate} />

            <h2 className="display-6">{ctx.niceName(a => a.properties)}</h2>
            <dl className="row">
                {propertyTree.map(node =>
                    <PropertyLine key={node.value.pr.propertyString()} node={node} cleanName={cleanName} onChange={forceUpdate} hash={hash} />)}
            </dl>

            {ctx.value.operations.length > 0 && <>
                <h2 className="display-6">{ctx.niceName(a => a.operations)}</h2>
                <dl className="row">
                    {mlistItemContext(ctx.subCtx(th => th.operations)).map(octx =>
                        <OperationLine key={octx.value.operation.key} ctx={octx} cleanName={cleanName} onChange={forceUpdate} hash={hash} />)}
                </dl>
            </>}

            {ctx.value.queries.length > 0 && <>
                <h2 className="display-6">{ctx.niceName(a => a.queries)}</h2>
                {mlistItemContext(ctx.subCtx(th => th.queries)).map(qctx =>
                    <QueryBlock key={qctx.value.query.key} ctx={qctx} onChange={forceUpdate} hash={hash} />)}
            </>}

            <div className={classes("btn-toolbar", "sf-button-bar", "mt-4")}>
                <SaveButton ctx={ctx} onSuccess={reload} />
            </div>
        </div>
    );
}

interface TreeNodeOf<T> { value: T; children: TreeNodeOf<T>[] }
type PropertyNode = TreeNodeOf<{ ctx: TypeContext<TypeHelpEntity_Property>; pr: PropertyRoute }>;

function PropertyLine({ node, cleanName, onChange, hash }: {
    node: PropertyNode; cleanName: string; onChange: () => void; hash: string | undefined;
}): React.JSX.Element {

    const id = HelpClient.Urls.idProperty(node.value.pr);

    return (
        <>
            <dt className={classes("col-sm-3", "shortcut-container", "text-end", hash === id && "sf-target")} id={id}>
                {node.value.pr.fieldInfo?.niceToString() ?? node.value.pr.member}<br />
                <Shortcut text={`[p:${cleanName}.${node.value.pr.propertyString()}]`} />
            </dt>
            <dd className="col-sm-9">
                <span className="info">
                    <HtmlViewer htmlAttributes={{ className: "sf-info" }} text={node.value.ctx.value.info} />
                    <EditableHtml ctx={node.value.ctx.subCtx(a => a.description)} onChange={onChange} />
                </span>
            </dd>
            {node.children.length > 0 && <div className="col-sm-12">
                <SubPropertiesCollapse node={node} cleanName={cleanName} onChange={onChange} hash={hash} />
            </div>}
        </>
    );
}

function SubPropertiesCollapse({ node, cleanName, onChange, hash }: {
    node: PropertyNode; cleanName: string; onChange: () => void; hash: string | undefined;
}): React.JSX.Element {

    const [open, setOpen] = React.useState(false);
    const pr = node.value.pr;

    return (
        <>
            <div className="row mb-2">
                <button type="button"
                    className="col-sm-9 offset-sm-3 lead border-0 bg-transparent text-start"
                    onClick={() => setOpen(!open)}
                    aria-expanded={open}>
                    <FontAwesomeIcon aria-hidden={true} icon={open ? "chevron-down" : "chevron-right"} />
                    {" "}{pr.fieldInfo?.niceToString() ?? pr.member} ({pr.type.getTypeName() ?? pr.type.typeName})
                </button>
            </div>

            <Collapse in={open}>
                <dl className="row ms-4">
                    {open && node.children.map(n =>
                        <PropertyLine key={n.value.pr.propertyString()} node={n} cleanName={cleanName} onChange={onChange} hash={hash} />)}
                </dl>
            </Collapse>
        </>
    );
}

function OperationLine({ ctx, cleanName, onChange, hash }: {
    ctx: TypeContext<TypeHelpEntity_Operation>; cleanName: string; onChange: () => void; hash: string | undefined;
}): React.JSX.Element {

    const id = HelpClient.Urls.idOperation(ctx.value.operation);
    const oi = getOperationInfos(cleanName).singleOrNull(o => o.key === ctx.value.operation.key);

    return (
        <>
            <dt className={classes("col-sm-3", "shortcut-container", "text-end", id === hash && "sf-target")} id={id}>
                {oi?.niceName ?? ctx.value.operation.niceToString()}<br />
                <Shortcut text={`[o:${ctx.value.operation.key}]`} />
            </dt>
            <dd className="col-sm-9">
                <span className="info">
                    <HtmlViewer htmlAttributes={{ className: "sf-info" }} text={ctx.value.info} />
                    <EditableHtml ctx={ctx.subCtx(a => a.description)} onChange={onChange} />
                </span>
            </dd>
        </>
    );
}

function QueryBlock({ ctx, onChange, hash }: {
    ctx: TypeContext<QueryHelpEntity>; onChange: () => void; hash: string | undefined;
}): React.JSX.Element {

    const [open, setOpen] = React.useState(!ctx.value.isNew);
    const queryKey = ctx.value.query.key;
    const id = HelpClient.Urls.idQuery(queryKey);

    return (
        <>
            <div className={classes("row", "mb-2", "shortcut-container", id === hash && "sf-target")} id={id}>
                <div className="col-sm-9 offset-sm-3">
                    <button type="button" className="lead border-0 bg-transparent" onClick={() => setOpen(!open)} aria-expanded={open}>
                        <FontAwesomeIcon aria-hidden={true} icon={open ? "chevron-down" : "chevron-right"} />
                        {" "}{ctx.value.query.toString()}
                    </button>
                    {" "}
                    {Finder.isFindable(queryKey, true) &&
                        <a href={AppContext.toAbsoluteUrl(Finder.findOptionsPath({ queryName: queryKey }))} target="_blank" rel="noreferrer">
                            <FontAwesomeIcon aria-hidden={true} icon="arrow-up-right-from-square" />
                        </a>}
                    {" "}
                    <Shortcut text={`[q:${queryKey}]`} />
                    <EditableHtml ctx={ctx.subCtx(a => a.description)} onChange={onChange} />
                </div>
            </div>
            <Collapse in={open}>
                <dl className="row ms-4">
                    {mlistItemContext(ctx.subCtx(q => q.columns)).map(cctx =>
                        <QueryColumnLine key={cctx.value.columnName} ctx={cctx} onChange={onChange} />)}
                </dl>
            </Collapse>
        </>
    );
}

function QueryColumnLine({ ctx, onChange }: {
    ctx: TypeContext<QueryHelpEntity_Column>; onChange: () => void;
}): React.JSX.Element {
    return (
        <>
            <dt className="col-sm-3 text-end">{ctx.value.niceName}<br /></dt>
            <dd className="col-sm-9">
                <span className="info">
                    <HtmlViewer htmlAttributes={{ className: "sf-info" }} text={ctx.value.info} />
                    <EditableHtml ctx={ctx.subCtx(a => a.description)} onChange={onChange} />
                </span>
            </dd>
        </>
    );
}

function SaveButton({ ctx, onSuccess }: { ctx: TypeContext<TypeHelpEntity>; onSuccess: () => void }): React.JSX.Element | null {

    const oi = getOperationInfos(TypeHelpEntity).singleOrNull(o => o.key === TypeHelpOperation.Save.key);
    if (oi == null)
        return null;

    function onClick(): void {
        HelpClient.API.saveType(ctx.value).then(() => {
            onSuccess();
            Operations.notifySuccess();
        });
    }

    return (
        <button type="button" className="btn btn-primary" onClick={onClick}>
            <FontAwesomeIcon aria-hidden={true} icon="floppy-disk" /> {oi.niceName}
        </button>
    );
}
