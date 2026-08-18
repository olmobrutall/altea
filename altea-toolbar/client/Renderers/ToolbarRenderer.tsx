import * as React from "react";
import { useLocation, type Location } from "react-router";
import { Nav } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import "@altea/altea/data/globals/arrayExtensions";
import "@altea/altea/data/globals/stringExtensions";
import { classes } from "@altea/altea/data/globals";
import { cleanTypeName } from "@altea/altea/data/registration";
import type { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { EngineMessage } from "@altea/altea/data/uiMessages";
import * as AppContext from "@altea/altea/client/AppContext";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { QueryString } from "@altea/altea/client/QueryString";
import { Binding } from "@altea/altea/client/binding";
import { getTypeInfo, tryGetTypeInfo, newLite } from "@altea/altea/client/Reflection";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { TypeReference } from "@altea/altea/data/reflection";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { useAPI, useDocumentEvent, useUpdatedRef, useAPIWithReload, useForceUpdate } from "@altea/altea/client/Hooks";
import { parseIcon } from "@altea/altea/client/Components/IconHelpers";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { LayoutMessage, ToolbarEntity, ToolbarMenuEntity, ToolbarSwitcherEntity, ToolbarMessage } from "../../data/Toolbar";
import type { ToolbarResponse } from "../../data/ToolbarResponse";
import { ToolbarClient } from "../ToolbarClient";
import { ToolbarConfig, type ToolbarContext, type InferActiveResponse } from "../ToolbarConfig";
import { ToolbarUrl } from "../ToolbarUrl";
import { RightCaretDropdown } from "./RightCaretDropdown";
import "@altea/altea/client/Frames/Widgets.css";
import "./Toolbar.css";

// Faithful port of Signum's ToolbarRenderer.tsx (Signum.Toolbar/Renderers/ToolbarRenderer.tsx) — the SIDEBAR
// renderer plus the shared element-rendering machinery the Top / Main renderers reuse (`renderNavItem`,
// `inferActive`, `isCompatibleWithUrl`, `renderExtraIcons`, `isActive`, `ToolbarNavItem`).
//
// altea divergences:
//  - `res.content!.EntityType` (a clean-name STRING in Signum) is `res.content!.entityType` (a ctor) here, so
//    type tests are `res.content?.entityType === ToolbarMenuEntity` and lookups go through `cleanTypeName`.
//  - `getToString(lite)` / `liteKey(lite)` are methods: `lite.toString()` / `lite.key()`.
//  - `EntityLine`'s explicit `type={{ name, isLite: true }}` prop is gone: altea Lines read their type from
//    `ctx.memberType`, so the entity picker binds through a `TypeContext` built from the type's PropertyRoute
//    (see ToolbarMenuItemsEntityType).
//  - Signum's `typeAllowedInDomain(queryKey, entity)` filter inside `simplifyForEntity` is DEFERRED: it needs
//    Signum's client-side "type conditions in domain" feed (the `typeInDomains` document event), which altea
//    has not ported. The `queryKey` the server already sends is kept, so the check drops in unchanged when
//    that lands; until then a with-entity element is shown for every entity of the menu's type.
//  - `useDocumentEvent("typeInDomains", …)` is dropped with it.

export default function ToolbarRenderer(p: {
    onAutoClose?: () => void;
}): React.ReactElement | null {

    Navigator.useEntityChanged(ToolbarEntity, () => reload(), []);
    Navigator.useEntityChanged(ToolbarMenuEntity, () => reload(), []);
    Navigator.useEntityChanged(ToolbarSwitcherEntity, () => reload(), []);

    const [response, reload] = useAPIWithReload(() => ToolbarClient.API.getCurrentToolbar("Side"), [], { avoidReset: true });
    const responseRef = useUpdatedRef(response);

    const [refresh, setRefresh] = React.useState(false);
    const [active, setActive] = React.useState<InferActiveResponse | null>(null);

    const location = useLocation();

    function changeActive(location: Location): void {
        const query = QueryString.parse(location.search);
        if (responseRef.current) {
            const newActive = inferActive(responseRef.current, location, query);
            setActive(newActive);
        }
    }

    React.useEffect(() => {
        if (response)
            changeActive(location);
    }, [location, response]);

    function handleRefresh(): number {
        return window.setTimeout(() => setRefresh(!refresh), 500);
    }

    const ctx: ToolbarContext = {
        active,
        onRefresh: handleRefresh,
        onAutoClose: p.onAutoClose,
    };

    return (
        <div className={"sidebar-inner"}>
            <div className={"close-sidebar"}
                onClick={() => p.onAutoClose && p.onAutoClose()}>
                <FontAwesomeIcon aria-hidden={true} icon={"angles-left"} aria-label="Close" />
            </div>

            <ul>
                {response && response.elements && response.elements.map((res: ToolbarResponse<any>, i: number) => renderNavItem(res, i, ctx, null))}
            </ul>
        </div>
    );
}

/** Signum's `isCompatibleWithUrl`: for a raw-url element, match the current path against the url PATTERN
 *  (recovering the `:id` / `:type` it implies); otherwise ask the content's config. */
export function isCompatibleWithUrl(r: ToolbarResponse<any>, location: Location, query: any, entityType: string | undefined): { prio: number, inferredEntity?: Lite<Entity> } | null {
    if (r.url) {
        const current = AppContext.toAbsoluteUrl(location.pathname).replace(/\/+$/, "");
        const target = AppContext.toAbsoluteUrl(r.url).replace(/\/+$/, "");

        const currentSegments = current.split("/");
        const targetSegments = target.split("/");

        let id: number | string | undefined;
        let type: string | undefined;
        const idRegex = "[0-9A-Za-z-]+";
        const typeRegex = "[A-Za-z-]+";
        const toStrRegex = ".*";

        function assertValidId(id: string | undefined): void {

            if (!id)
                return;

            const m = id.match(new RegExp("^" + idRegex + "$"));
            if (m == null)
                throw new Error("Id is not valid:" + id);
        }

        const matches = currentSegments.length == targetSegments.length && targetSegments.every((pattern, i) => {

            const value = currentSegments[i];

            if (value.toLowerCase() === pattern.toLowerCase())
                return true;

            if (pattern.includes(":id") || pattern.includes(":type") || pattern.includes(":key") || pattern.includes(":toStr") ||
                pattern.includes(":id2") || pattern.includes(":type2") || pattern.includes(":key2") || pattern.includes(":toStr2")) {

                const regexPattern = "^" +
                    pattern
                        .replace(":id2", idRegex)
                        .replace(":type2", typeRegex)
                        .replace(":key2", typeRegex + ";" + idRegex)
                        .replace(":toStr2", toStrRegex)
                        .replace(":id", "(?<id>" + idRegex + ")")
                        .replace(":type", "(?<type>" + typeRegex + ")")
                        .replace(":key", "(?<type>" + typeRegex + ")" + ";" + "(?<id>" + idRegex + ")")
                        .replace(":toStr", toStrRegex)
                    + "$";

                const regex = new RegExp(regexPattern);
                const match = value.match(regex);
                if (match == null)
                    return false;

                if (match.groups?.id) {
                    id = match.groups?.id;
                    assertValidId(id);
                }

                if (match.groups?.type)
                    type = match!.groups?.type;

                if (type != null && type.toLowerCase() != entityType?.toLowerCase())
                    return false;

                return true;
            }

            return false;
        });

        if (matches)
            return { prio: 1, inferredEntity: entityType && id ? newLite(entityType, id) : undefined };

        return null;
    } else {

        if (!r.content)
            return null;

        const config = ToolbarClient.getConfig(r);
        if (!config)
            return null;

        return config.isCompatibleWithUrlPrio(r, location, query);
    }
}

/** Signum's `inferActive`: the deepest / highest-priority element the current URL corresponds to. For an
 *  entity-scoped menu the inferred entity is lifted onto `menuWithEntity` (so the menu can select it). */
export function inferActive(r: ToolbarResponse<any>, location: Location, query: any, entityType?: string): InferActiveResponse | null {
    if (r.elements) {

        const result = r.elements.map(e => inferActive(e, location, query, entityType ?? r.entityType)).notNull().maxBy(a => a.prio) ?? null;

        if (result == null)
            return null;

        if (r.entityType == null)
            return result;

        if (!result.inferredEntity)
            return result;

        if (cleanTypeName(result.inferredEntity.entityType) != r.entityType)
            return null;

        return {
            ...result,
            inferredEntity: undefined,
            menuWithEntity: { menu: r, entity: result.inferredEntity },
        };
    }

    const main = isCompatibleWithUrl(r, location, query, r.entityType ?? entityType);
    const bestExtra = r.extraIcons?.map(e => inferActive(e, location, query)).notNull().maxBy(a => a.prio) ?? null;

    if (bestExtra != null && (main == null || bestExtra.prio > main.prio))
        return bestExtra;

    if (main != null)
        return {
            prio: main.prio,
            response: r,
            inferredEntity: main.inferredEntity,
        };

    return null;
}

/** Signum's `renderNavItem`: one response → its rendered nav item (a divider, a menu, a switcher, a url
 *  link, a config-rendered item, or a bare header). */
export function renderNavItem(res: ToolbarResponse<any>, key: string | number, ctx: ToolbarContext, selectedEntity: Lite<Entity> | null): React.JSX.Element {

    switch (res.type) {
        case "Divider":
            return <hr style={{ margin: "10px 0 5px 0px" }} key={key}></hr>;
        case "Header":
        case "Item":
            if (res.content?.entityType === ToolbarMenuEntity) {
                return <ToolbarMenu response={res} key={key} ctx={ctx} selectedEntity={selectedEntity} />;
            }

            if (res.content?.entityType === ToolbarSwitcherEntity) {
                return <ToolbarSwitcher response={res} key={key} ctx={ctx} selectedEntity={selectedEntity} />;
            }

            if (res.url) {
                const config = res.content && ToolbarClient.getConfig(res);
                return (
                    <ToolbarNavItem key={key} title={res.label}
                        isExternalLink={ToolbarUrl.isExternalLink(res.url)}
                        content={res.content}
                        extraIcons={renderExtraIcons(res.extraIcons, ctx, selectedEntity)}
                        active={isActive(ctx.active, res, selectedEntity)} icon={<>
                            {ToolbarConfig.coloredIcon(parseIcon(res.iconName), res.iconColor)}
                            {config?.getCounter(res, selectedEntity)}
                        </>}
                        onClick={(e: React.MouseEvent<any>) => linkClick(res, selectedEntity, e, ctx)} />
                );
            }

            if (res.content) {
                const config = ToolbarClient.getConfig(res);
                if (!config)
                    return <Nav.Item className="text-danger">
                        {ToolbarMessage.ToolbarConfigNotRegistered0.niceToString(cleanTypeName(res.content.entityType))}
                    </Nav.Item>;

                return config.getMenuItem(res, key, ctx, selectedEntity);
            }

            if (res.type == "Header") {
                return (
                    <li key={key} className={"nav-item-header"}>
                        {ToolbarConfig.coloredIcon(parseIcon(res.iconName), res.iconColor)}
                        <span className={"nav-item-text"}>{res.label}</span>
                        <div className={"nav-item-float"}>{res.label}</div>
                    </li>
                );
            }

            return <Nav.Item key={key} style={{ color: "red" }}>{ToolbarMessage.NoContentOrUrlFound.niceToString()}</Nav.Item>;

        default:
            throw new Error("Unexpected " + res.type);
    }
}

function responseClick(r: ToolbarResponse<ToolbarMenuEntity>, selectedEntity: Lite<Entity> | null, e: React.SyntheticEvent | undefined, ctx: ToolbarContext): void {
    if (r.url != null) {
        linkClick(r, selectedEntity, e as React.MouseEvent | undefined, ctx);
    }
    else {
        const config = ToolbarClient.getConfig(r);
        if (config != null)
            config.handleNavigateClick(e as React.MouseEvent, r, selectedEntity);
    }
}

async function linkClick(r: ToolbarResponse<ToolbarMenuEntity>, selectedEntity: Lite<Entity> | null, e: React.MouseEvent | undefined, ctx: ToolbarContext): Promise<void> {

    let url = r.url!;
    if (ToolbarUrl.hasSubEntity(url)) {
        const config = r.content && ToolbarClient.getConfig(r);
        const subEntity = config && await config.selectSubEntityForUrl(r, selectedEntity);
        if (subEntity == null)
            return;

        url = ToolbarUrl.replaceSubEntity(url, subEntity);
    }

    url = ToolbarUrl.replaceVariables(url);

    if (selectedEntity)
        url = ToolbarUrl.replaceEntity(url, selectedEntity);

    if (ToolbarUrl.isExternalLink(url))
        window.open(url);
    else
        AppContext.pushOrOpenInTab(url, e);


    if (ctx.onAutoClose && !(e && (e.ctrlKey || (e as React.MouseEvent<any>).button == 1)))
        ctx.onAutoClose();
}

/** Signum's `ToolbarMenu`: a collapsible group whose open/closed state lives in localStorage. Alt+click opens
 *  the ToolbarMenu entity itself (the admin shortcut). */
function ToolbarMenu(p: { response: ToolbarResponse<ToolbarMenuEntity>, ctx: ToolbarContext, selectedEntity: Lite<Entity> | null }): React.ReactElement {

    const title = p.response.label || p.response.content?.toString();
    const icon = ToolbarConfig.coloredIcon(parseIcon(p.response.iconName), p.response.iconColor);

    const key = "toolbar-menu-" + p.response.content!.id;

    const [show, setShow] = React.useState(localStorage.getItem(key) != null);

    function handleShowClick(e: React.MouseEvent | null): void {

        if (e?.altKey && p.response.content && Navigator.isViewable(p.response.content)) {
            Navigator.view(p.response.content!);
            return;
        }

        const value = !show;

        if (value)
            localStorage.setItem(key, "1");
        else
            localStorage.removeItem(key);

        setShow(value);

        if (value && e) {
            const autoSelect = p.response.elements?.firstOrNull(a => a.autoSelect && !a.withEntity);
            if (autoSelect) {
                responseClick(autoSelect, p.selectedEntity, e, p.ctx);
            }
        }
    }

    React.useEffect(() => {

        if (p.ctx.active && !show) {
            const isContained = containsResponse(p.response, p.ctx.active.response);
            if (isContained)
                handleShowClick(null);
        }
    }, [p.ctx.active]);


    return (
        <li>
            <ul>
                <ToolbarNavItem title={title} extraIcons={renderExtraIcons(p.response.extraIcons, p.ctx, p.selectedEntity)} isGroup={true} onClick={e => handleShowClick(e)}
                    icon={
                        <div style={{ position: "relative" }}>
                            <div className="nav-arrow-icon" style={{ position: "absolute" }}>
                                <FontAwesomeIcon icon={show ? "chevron-down" : "chevron-right"} className="icon" />
                            </div>
                            <div className="nav-icon-with-arrow">
                                {icon}
                            </div>
                        </div>
                    }
                />
                {show && <li>
                    <ul style={{ display: show ? "block" : "none" }} className="nav-item-sub-menu">
                        <ToolbarMenuItems response={p.response} ctx={p.ctx} selectedEntity={p.selectedEntity} />
                    </ul>
                </li>}
            </ul>
        </li>
    );
}

export function ToolbarMenuItems(p: { response: ToolbarResponse<ToolbarMenuEntity>, ctx: ToolbarContext, selectedEntity: Lite<Entity> | null }): React.ReactNode {
    const entityType = p.response.entityType;
    // Only render the entity-bound menu when the current user actually has UI access to the type.
    // Otherwise the type is absent from the client reflection and getTypeInfo would throw, crashing
    // the whole toolbar (and blocking login). Fall back to the plain, server-filtered elements.
    if (entityType && tryGetTypeInfo(entityType))
        return <ToolbarMenuItemsEntityType response={p.response} ctx={p.ctx} selectedEntity={p.selectedEntity} />;

    return <>
        {p.response.elements!.map((sr, i) => renderNavItem(sr, i, p.ctx, p.selectedEntity))}
    </>;
}

/** Signum's `ToolbarMenuItemsEntityType`: an entity-scoped menu — an entity picker on top, then the elements
 *  that apply WITH the picked entity (or, with none picked, the ones that apply without). */
function ToolbarMenuItemsEntityType(p: { response: ToolbarResponse<ToolbarMenuEntity>, ctx: ToolbarContext, selectedEntity: Lite<Entity> | null }): React.ReactNode {

    const entityType = p.response.entityType!;
    const selEntityStorageKey = "toolbar-menuitems-entitytype-" + p.response.content!.id + "-" + entityType;

    const selEntityRef = React.useRef<Lite<Entity> | null>(null);
    const previousResponseRef = React.useRef<ToolbarResponse<ToolbarMenuEntity> | null>(null);
    const forceUpdate = useForceUpdate();

    function setSelectedEntity(entity: Lite<Entity> | null): void {
        selEntityRef.current = entity;

        if (entity)
            localStorage.setItem(selEntityStorageKey, entity.id!.toString());
        else
            localStorage.removeItem(selEntityStorageKey);

        forceUpdate();
    }

    class RefBinding extends Binding<Lite<Entity> | null> {
        override setValue(val: Lite<Entity> | null): void {
            setSelectedEntity(val);
            super.setValue(val);
        }
    }

    React.useEffect(() => {
        if (previousResponseRef.current && !previousResponseRef.current.content?.is(p.response.content)) {
            setSelectedEntity(null);
        }
        previousResponseRef.current = p.response;
    }, [p.response]);


    React.useEffect(() => {
        if (selEntityRef.current)
            return;

        const savedId = localStorage.getItem(selEntityStorageKey);
        if (!savedId)
            return;

        Finder.fetchLites({ queryName: entityType, filterOptions: [{ token: "Entity.Id", operation: "EqualTo", value: savedId }], count: 1 })
            .then(lites => {
                if (lites.length > 0)
                    setSelectedEntity(lites[0]);
            });
    }, [entityType]);

    const active = p.ctx.active;

    React.useEffect(() => {

        if (active?.menuWithEntity && p.response.entityType &&
            active.menuWithEntity.menu.content?.is(p.response.content)) {

            if (!active.menuWithEntity.entity.is(selEntityRef.current))
                setSelectedEntity(active.menuWithEntity.entity);
        }
    }, [active, p.response]);

    // Signum's "fill the display model of a lite we only know the id of" effect. It matters for the lite
    // `inferActive` builds out of the URL (`newLite(type, id)`, no toStr). altea's `Navigator.useFillToString`
    // is not ported yet (it needs the /api/liteModels route), so the lite is re-FETCHED through the query —
    // which is what Signum's effect does in the found case too — and REPLACED (an altea Lite's `toStr` is
    // readonly, so a not-found id gets a fresh lite carrying the message instead of Signum's `.model` write).
    React.useEffect(() => {
        const current = selEntityRef.current;
        if (!current || current.toString())
            return;

        Finder.fetchLites({ queryName: entityType, filterOptions: [{ token: "Entity", operation: "EqualTo", value: current }], count: 1 })
            .then(lites => {
                if (lites.length > 0)
                    setSelectedEntity(lites[0]);
                else
                    setSelectedEntity(newLite(entityType, current.id!,
                        EngineMessage._01NotFound.niceToString(getTypeInfo(entityType).getNiceName(), current.id)));
            });
    }, [selEntityRef.current]);

    function handleSelect(e: React.SyntheticEvent | undefined): void {

        forceUpdate();
        const autoSelect = p.response.elements?.firstOrNull(a => a.autoSelect && Boolean(a.withEntity) == Boolean(selEntityRef.current));
        if (autoSelect) {
            responseClick(autoSelect, selEntityRef.current, e, p.ctx);
        }
    }

    const ti = getTypeInfo(entityType);
    // altea Lines read their member type from the TypeContext (no `type=` prop), so the picker binds through
    // a context rooted at the TYPE's own PropertyRoute — `Lite<ti>` — instead of Signum's explicit
    // `type={{ name: entityType, isLite: true }}`.
    const ctx = new TypeContext<Lite<Entity> | null>(undefined, undefined,
        new TypeReference({ type: () => ti.ctor!, lite: true, isNullable: true }),
        new RefBinding(selEntityRef, "current"));

    const filter = ToolbarClient.entityElementFilters[entityType];
    const hiddenGuids = useAPI(
        async () => {
            if (!filter || !selEntityRef.current)
                return null;
            return await filter(selEntityRef.current);
        },
        [entityType, selEntityRef.current && selEntityRef.current.key()],
    );

    return (
        <>
            {entityType && (
                <Nav.Item title={ti.getNiceName()} className="d-flex mx-2 mb-2">
                    <div style={{ width: "100%" }}>
                        <EntityLine ctx={ctx} view={false} mandatory="warning"
                            inputAttributes={{ placeholder: LayoutMessage.SelectA0_G.niceToString(ti.getNiceName()) }}
                            onChange={e => handleSelect(e?.originalEvent)} create={false} createOnFind={false} formGroupStyle="SrOnly" />
                    </div>
                    {renderExtraIcons(p.response.extraIcons, p.ctx, selEntityRef.current ?? p.selectedEntity)}
                </Nav.Item>
            )}
            {selEntityRef.current ?
                simplifyForEntity(p.response.elements!.filter(sr => sr.withEntity), selEntityRef.current, hiddenGuids ?? undefined).map((sr, i) => renderNavItem(sr, i, p.ctx, selEntityRef.current ?? p.selectedEntity)) :
                p.response.elements!.filter(sr => !sr.withEntity).map((sr, i) => renderNavItem(sr, i, p.ctx, selEntityRef.current ?? p.selectedEntity))
            }
        </>
    );
}

/** Signum's `simplifyForEntity`: drop the elements an entity-scoped menu should hide for THIS entity, then
 *  re-run the divider / pure-header cleanup the server does for the unscoped case. */
function simplifyForEntity(resp: ToolbarResponse<any>[], selectedEntity: Lite<Entity>, hiddenGuids?: Set<string>): ToolbarResponse<any>[] {
    const result = resp
        .map(tr => {

            if (hiddenGuids && tr.guid && hiddenGuids.has(tr.guid))
                return null;

            // DEFERRED (see the file header): Signum also drops an element whose `queryKey` is not allowed in
            // the selected entity's DOMAIN (`typeAllowedInDomain(tr.queryKey, selectedEntity)`) — altea has no
            // client-side type-conditions-in-domain feed yet.

            if (tr.elements && tr.elements.length > 0) {
                const inner = simplifyForEntity(tr.elements, selectedEntity, hiddenGuids);
                if (inner.length == 0)
                    return null;

                tr = { ...tr, elements: inner };
            }

            if (tr.extraIcons && tr.extraIcons.length > 0) {
                const extraIcons = simplifyForEntity(tr.extraIcons, selectedEntity, hiddenGuids);

                tr = { ...tr, extraIcons };
            }

            return tr;
        }).notNull();

    function isPureHeader(tr: ToolbarResponse<any>): boolean {
        return tr.type == "Header" && !tr.content && !tr.url;
    }

    for (;;) {
        const extraDividers = result.filter((a, i) => a.type == "Divider" && (
            i == 0 ||
            result[i - 1].type == "Divider" ||
            i == result.length - 1
        ));

        const extraHeaders = result.filter((a, i) => isPureHeader(a) && (
            i == result.length - 1 ||
            isPureHeader(result[i + 1]) ||
            result[i + 1].type == "Divider" ||
            (result[i + 1].type == "Header" && result[i + 1].content?.entityType === ToolbarMenuEntity)
        ));

        if (extraDividers.length == 0 && extraHeaders.length == 0)
            return result;

        [...extraDividers, ...extraHeaders].forEach(r => {
            const i = result.indexOf(r);
            if (i >= 0)
                result.splice(i, 1);
        });
    }
}

function containsResponse(r: ToolbarResponse<any>, active: ToolbarResponse<any>): boolean {
    return r == active || (r.elements != null && r.elements.some(e => containsResponse(e, active)));
}

/** Signum's `ToolbarSwitcher`: one slot that switches between N menus (the pick lives in localStorage). */
function ToolbarSwitcher(p: { response: ToolbarResponse<ToolbarSwitcherEntity>, ctx: ToolbarContext, selectedEntity: Lite<Entity> | null }): React.ReactElement {

    const ts = p.response.content!;

    const key = "toolbar-switcher-" + ts.id!;

    const [selectedOption, setSelectedOption] = React.useState(() => {
        const sel = localStorage.getItem(key);
        return p.response.elements?.onlyOrNull(a => a.content!.id!.toString() == sel);
    });

    React.useEffect(() => {

        if (p.ctx.active) {
            const menu = p.response.elements?.firstOrNull(e => containsResponse(e, p.ctx.active!.response!));
            if (menu && menu !== selectedOption) {
                setSelectedOption(menu);
                localStorage.setItem(key, menu.content!.id!.toString());
            }
        }
    }, [p.ctx.active, p.response.elements]);

    function handleSetShow(value: ToolbarResponse<any>, e: React.SyntheticEvent | null): void {

        if (e && (e as React.MouseEvent).altKey && value.content && Navigator.isViewable(value.content)) {
            Navigator.view(value.content!);
            return;
        }

        localStorage.setItem(key, value.content!.id!.toString());
        setSelectedOption(value);

        const autoSelect = value.elements?.firstOrNull(a => a.autoSelect && !a.withEntity);
        if (autoSelect) {
            responseClick(autoSelect, null, undefined, p.ctx);
        }
    }

    const icon = ToolbarConfig.coloredIcon(parseIcon(p.response.iconName), p.response.iconColor);
    const title = p.response.label || p.response.content?.toString();

    const options = (p.response.elements ?? []).map(el => ({
        value: el,
        label: el.label || (el.content?.toString() ?? ""),
        icon: el.iconName ? ToolbarConfig.coloredIcon(parseIcon(el.iconName), el.iconColor) : undefined,
    }));

    return (
        <li>
            <ul>
                <Nav.Item
                    data-toolbar-content={liteKeyOrQuery(p.response.content)}
                    title={title} className="d-flex mb-2">
                    {icon}
                    <RightCaretDropdown
                        options={options}
                        value={selectedOption ?? null}
                        onChange={(val, e) => val && handleSetShow(val, e)}
                        placeholder={title}
                        disabled={false} />
                    {renderExtraIcons(p.response.extraIcons, p.ctx, p.selectedEntity)}
                </Nav.Item>

                {selectedOption &&
                    <li>
                        <ul>
                            {selectedOption.elements && <ToolbarMenuItems response={selectedOption} ctx={p.ctx} selectedEntity={p.selectedEntity} />}
                        </ul>
                    </li>
                }
            </ul>
        </li>
    );
}

export function ToolbarNavItem(p: { title: string | undefined, content?: Lite<Entity>, active?: boolean, isExternalLink?: boolean, isGroup?: boolean, extraIcons?: React.ReactElement, onClick: (e: React.MouseEvent) => void, icon?: React.ReactNode, onAutoCloseExtraIcons?: () => void }): React.JSX.Element {

    return (
        <li className="nav-item d-flex">
            <Nav.Link title={p.title} onClick={p.onClick} onAuxClick={p.onClick} active={p.active} className="d-flex w-100"
                data-toolbar-content={liteKeyOrQuery(p.content)}>
                <div>{p.icon}</div>
                <span className={classes("nav-item-text", p.isGroup && "nav-item-group")}>
                    {p.title}
                    {p.isExternalLink && <FontAwesomeIcon aria-hidden={true} icon="arrow-up-right-from-square" transform="shrink-5 up-3" />}
                </span>
                {p.extraIcons}
                <div className={classes("nav-item-float", p.isGroup && "nav-item-group")}>{p.title}</div>
            </Nav.Link>
        </li>
    );
}

/** Signum's `liteKeyOrQuery`: the `data-toolbar-content` attribute the Playwright proxy addresses items by —
 *  a query element is identified by its KEY, everything else by its lite key. */
export function liteKeyOrQuery(content: Lite<Entity> | null | undefined): string | null {
    return content == null ? null : content.entityType === QueryEntity ? content.toString() : content.key();
}

export function isActive(active: InferActiveResponse | null, res: ToolbarResponse<any>, selectedEntity: Lite<Entity> | null): boolean {

    function isSame(a: ToolbarResponse<any>, b: ToolbarResponse<any>): boolean {
        return a == b || (a.content == b.content && a.url == b.url); // simplifyForEntity clones responses
    }

    return active != null && isSame(active.response, res) && (active.menuWithEntity == null || active.menuWithEntity.entity.is(selectedEntity));
}

export function renderExtraIcons(extraIcons: ToolbarResponse<any>[] | undefined, ctx: ToolbarContext, selectedEntity: Lite<Entity> | null): React.ReactElement | undefined {
    if (extraIcons == null)
        return undefined;

    return (<>
        {extraIcons?.map((ei, i) => {

            if (ei.url) {
                return <button type="button" className={classes("btn btn-sm border-0 py-0 m-0 sf-extra-icon", isActive(ctx.active, ei, selectedEntity) && "active")} key={i}
                    onClick={e => { e.stopPropagation(); linkClick(ei, selectedEntity, e, ctx); }}>
                    {ToolbarConfig.coloredIcon(parseIcon(ei.iconName!), ei.iconColor)}
                </button>;
            }

            const config = ToolbarClient.getConfig(ei);
            if (config == null) {
                return <span key={i} className="text-danger sf-extra-icon">
                    {ToolbarMessage.ToolbarConfigNotRegistered0.niceToString(cleanTypeName(ei.content!.entityType))}
                </span>;
            }
            else {

                return <button type="button" className={classes("btn btn-sm border-0 py-0 m-0 sf-extra-icon", isActive(ctx.active, ei, selectedEntity) && "active")} key={i} onClick={e => {
                    e.stopPropagation();
                    config!.handleNavigateClick(e, ei, selectedEntity);

                    if (ctx.onAutoClose && !(e.ctrlKey || (e as React.MouseEvent<any>).button == 1))
                        ctx.onAutoClose();

                }} >{config.getIcon(ei, selectedEntity)}</button>;
            }

        })}
    </>);
}
