import * as React from "react";
import { OverlayTrigger, Popover } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import * as AppContext from "@altea/altea/client/AppContext";
import { useAPI } from "@altea/altea/client/Hooks";
import type { WidgetContext } from "@altea/altea/client/Frames/Widgets";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { classes } from "@altea/altea/data/globals";
import type { Entity } from "@altea/altea/data/entity";
import { cleanTypeName } from "@altea/altea/data/registration";
import { HelpMessage, type TypeHelpEntity } from "../data/Help";
import { HelpClient } from "./HelpClient";
import { HtmlViewer } from "./Editor/EditableHtml";
import "./HelpWidget.css";

// Port of Signum.Help's HelpWidget.tsx — the "?" button on an entity frame, and the "?" badge beside a
// documented Line's label.
//
// altea divergences:
//  - `entity.Type` (Signum's string discriminator) becomes `cleanTypeName(entity.constructor)` — altea has
//    no `.Type` compat accessor (see CLAUDE.md).
//  - the badge reads a `@part` ROW array (`typeHelp.properties`) rather than an MList of embeddeds, so
//    there is no `.element` hop.
//  - `pr.findRootType()` → `pr.rootType`; the property is matched on `propertyString()`, which is also
//    what the stored row keys on.

export interface HelpWidgetProps {
    wc: WidgetContext<Entity>;
}

export function HelpWidget(p: HelpWidgetProps): React.JSX.Element {

    const entity = p.wc.ctx.value;
    const cleanName = cleanTypeName(entity.constructor);

    const typeHelp = useAPI(() => HelpClient.API.type(cleanName), [cleanName]);

    const hasContent = Boolean(typeHelp && !typeHelp.isNew);

    React.useEffect(() => {
        if (hasContent) {
            // Stow it on the pack so every Line on the page can render its badge without a request of its
            // own, then ask the frame to re-render so they pick it up (Signum's same two steps).
            p.wc.frame.pack.typeHelp = typeHelp;
            p.wc.frame.onReload();
        }
    }, [hasContent]);

    return (
        <a href={AppContext.toAbsoluteUrl(HelpClient.Urls.typeUrl(cleanName))}
            role="button"
            target="_blank"
            rel="noreferrer"
            title={HelpMessage.Help.niceToString()}
            className={hasContent ? "sf-help-button active" : "sf-help-button"}>
            <FontAwesomeIcon aria-hidden={true} icon="circle-question" />
        </a>
    );
}

/** The badge beside a Line's label: a popover with the property's description plus a "view more" link. */
export function HelpIcon(p: { ctx: TypeContext<unknown>; typeHelp?: TypeHelpEntity }): React.JSX.Element | null {

    const pr = p.ctx.propertyRoute;
    if (pr == null)
        return null;

    const typeHelp = p.typeHelp ?? p.ctx.frame?.pack.typeHelp;
    const rootType = pr.rootType;

    if (typeHelp == null || rootType == null || cleanTypeName(rootType) !== typeHelp.type.cleanName)
        return null;

    const prop = typeHelp.properties.find(a => a.propertyRoute === pr.propertyString());
    if (!prop?.description)
        return null;

    return <HelpIconPopover description={prop.description} url={HelpClient.Urls.propertyUrl(typeHelp.type.cleanName, pr)} />;
}

/**
 * Split out so the hooks below never run conditionally — `HelpIcon` returns early four times, and Signum's
 * version calls `useRef` / `useState` AFTER those early returns, which violates the hook rules (it works
 * only because the early-return conditions happen not to change for a given line).
 */
function HelpIconPopover(p: { description: string; url: string }): React.JSX.Element {

    const bodyRef = React.useRef<HTMLDivElement>(null);
    const jumpId = "popover-viewmore-help-jump";

    const popover = (
        <Popover id="popover-help" role="dialog" tabIndex={-1} aria-labelledby="popover-header" aria-describedby="popover-body">
            <Popover.Header as="h3" id="popover-header">{HelpMessage.Help.niceToString()}</Popover.Header>

            <a href={`#${jumpId}`} style={{ position: "absolute", left: "-9999px" }}>
                {HelpMessage.JumpToViewMore.niceToString()}
            </a>

            <Popover.Body id="popover-body" role="document" ref={bodyRef}>
                <HtmlViewer text={p.description} />
                <br />
                <a id={jumpId} href={AppContext.toAbsoluteUrl(p.url)} target="_blank" rel="noreferrer">
                    {HelpMessage.ViewMore.niceToString()}
                </a>
            </Popover.Body>
        </Popover>
    );

    return (
        <OverlayTrigger
            trigger="click"
            rootClose
            placement="right"
            overlay={popover}
            onEntered={() => bodyRef.current?.parentElement?.focus()}>
            <LinkButton onClick={() => { }} className="ms-1 sf-help-button" title={HelpMessage.Help.niceToString()}>
                <FontAwesomeIcon aria-hidden={true} icon="circle-question" />
            </LinkButton>
        </OverlayTrigger>
    );
}

/** Signum's `TypeHelpIcon` — a bare "open this type's help" link, for a page that has no frame. */
export function TypeHelpIcon({ type, className, ...rest }: { type: string } & React.HTMLAttributes<HTMLAnchorElement>): React.JSX.Element {
    return (
        <a href={AppContext.toAbsoluteUrl(HelpClient.Urls.typeUrl(type))}
            role="button"
            target="_blank"
            rel="noreferrer"
            className={classes("sf-help-button", className)}
            {...rest}>
            <FontAwesomeIcon aria-hidden={true} icon="circle-question" />
        </a>
    );
}
