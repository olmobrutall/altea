import * as React from "react";
import { Collapse, Modal } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import "@altea/altea/data/globals/arrayExtensions";
import * as AppContext from "@altea/altea/client/AppContext";
import { useAPI } from "@altea/altea/client/Hooks";
import { type IModalProps, openModal } from "@altea/altea/client/Modals";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { JavascriptMessage, SearchMessage } from "@altea/altea/data/uiMessages";
import { parseIcon } from "@altea/altea/client/Components/IconHelpers";
import { ToolbarMenuEntity, ToolbarMessage } from "../../data/Toolbar";
import type { ToolbarResponse } from "../../data/ToolbarResponse";
import { ToolbarClient } from "../ToolbarClient";
import { ToolbarConfig } from "../ToolbarConfig";
import "@altea/altea/client/Frames/Widgets.css";
import "./Toolbar.css";

// Faithful port of Signum's ToolbarMainRenderer.tsx (Signum.Toolbar/Renderers/ToolbarMainRenderer.tsx): the
// `Main` toolbar — a PAGE of big icon cards grouped by header / divider, where a card that has children opens
// a modal with the nested cards (a launcher / app-menu style home page).
//
// altea divergences: import paths only (`getToString(lite)` → `lite.toString()`, and `PropTypes` — an unused
// Signum import — is dropped).

export interface ToolbarMainRendererProps {
}

export default function ToolbarMainRenderer(p: ToolbarMainRendererProps): React.JSX.Element {
    const response = useAPI(() => ToolbarClient.API.getCurrentToolbar("Main").then(t => t ?? null), []);

    if (response === undefined)
        return <span>{JavascriptMessage.loading.niceToString()}</span>;

    if (response === null)
        return <span>{SearchMessage.NoResultsFound.niceToString()}</span>;

    return (<ToolbarMainRendererPrivate response={response} />);
}

function ToolbarMainRendererPrivate({ response }: { response: ToolbarResponse<any> }): React.JSX.Element {
    return (
        <div>
            {
                response.elements!.groupWhen(a => a.type == "Divider" || a.type == "Header", false, "defaultGroup").map((gr, i) => <div key={i}>
                    {gr.key && gr.key.type == "Divider" && <hr />}
                    {gr.key && gr.key.type == "Header" && gr.key.content?.entityType === ToolbarMenuEntity && <CollapsableBlock r={gr.key} />}
                    {gr.key && gr.key.type == "Header" && gr.key.content?.entityType !== ToolbarMenuEntity && <h4>{gr.key.label ?? gr.key.content!.toString()}</h4>}
                    {gr.elements.length > 0 && <div className="row">
                        {gr.elements.map((tr, j) => <div key={j} className="toolbar-card-container">
                            <ToolbarIconButton tr={tr} />
                        </div>)}
                    </div>}
                </div>
                )
            }
        </div>
    );
}

function CollapsableBlock({ r }: { r: ToolbarResponse<any> }): React.JSX.Element {
    const [isOpen, setIsOpen] = React.useState(false);
    return (
        <div>
            <h4>
                <LinkButton title={undefined} onClick={e => { e.preventDefault(); setIsOpen(!isOpen); }}><FontAwesomeIcon aria-hidden icon={isOpen ? "chevron-down" : "chevron-right"} /> {r.label ?? r.content!.toString()}</LinkButton>
            </h4>
            <Collapse in={isOpen}>
                <div>
                    <ToolbarMainRendererPrivate response={r} />
                </div>
            </Collapse>
        </div>
    );
}

function ToolbarIconButton({ tr }: { tr: ToolbarResponse<any> }): React.JSX.Element {

    if (tr.elements && tr.elements.length > 0) {
        return (
            <LinkButton
                title={undefined} onClick={e => { ToolbarMainModal.show(tr); }}>
                <div className="card toolbar-card">
                    <div className="card-img-top" style={{ fontSize: "60px" }}>
                        {ToolbarConfig.coloredIcon(parseIcon(tr.iconName), tr.iconColor)}
                    </div>
                    <div className="card-body">
                        <h5 className="card-title">{tr.label ?? tr.content!.toString()}</h5>
                    </div>
                </div>
            </LinkButton>
        );
    }


    if (tr.url) {
        return (
            <LinkButton
                title={undefined} onMouseDown={e => { AppContext.pushOrOpenInTab(tr.url!, e); }}>
                <div className="card toolbar-card">
                    <div className="card-img-top" style={{ fontSize: "60px" }}>
                        {ToolbarConfig.coloredIcon(parseIcon(tr.iconName), tr.iconColor)}
                    </div>
                    <div className="card-body">
                        <h5 className="card-title">{tr.label}</h5>
                    </div>
                </div>
            </LinkButton>
        );
    }

    const config = ToolbarClient.getConfig(tr);
    if (config == null)
        return (
            <div className="card toolbar-card text-danger">
                {ToolbarMessage.ToolbarConfigNotRegistered0.niceToString(tr.content!.entityType.name)}
            </div>
        );

    return (
        <LinkButton title={undefined} onMouseDown={e => { config.handleNavigateClick(e, tr, null); }}>
            <div className="card toolbar-card">
                <div className="card-img-top" style={{ fontSize: "60px" }}>
                    {config.getIcon(tr, null)}
                </div>
                <div className="card-body">
                    <h5 className="card-title">{tr.label}</h5>
                </div>
            </div>
        </LinkButton>
    );
}

interface ToolbarMainModalProps extends IModalProps<undefined> {
    tr: ToolbarResponse<any>;
}

function ToolbarMainModal(p: ToolbarMainModalProps): React.ReactElement {

    const [show, setShow] = React.useState<boolean>(true);

    function handleCloseClicked(): void {
        setShow(false);
    }

    function handleOnExited(): void {
        p.onExited!(undefined);
    }

    return (
        <Modal onHide={handleCloseClicked} show={show} className="message-modal" onExited={handleOnExited} size="xl">
            <div className="modal-header">
                <h5 className="modal-title">{p.tr.label ?? p.tr.content!.toString()}</h5>
                <button type="button" className="btn-close" data-dismiss="modal" aria-label="Close" onClick={handleCloseClicked} />
            </div>
            <div className="modal-body">
                <ToolbarMainRendererPrivate response={p.tr} />
            </div>
        </Modal>
    );
}

// Signum names this `ToolbarMainModalModal` (a typo it carries); the single `Modal` reads better and the
// symbol is module-private.
ToolbarMainModal.show = (tr: ToolbarResponse<any>): Promise<undefined> => {
    return openModal<undefined>(<ToolbarMainModal tr={tr} />);
};
