import "@altea/altea/data/globals/arrayExtensions";
import * as React from "react";
import { Button, Dropdown, DropdownButton } from "react-bootstrap";
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import searchPad from "bpmn-js/lib/features/search";
import { JavascriptMessage, SearchMessage } from "@altea/altea/data/uiMessages";
import { Enum } from "@altea/altea/data/enum";
import { WorkflowMessage, type IWorkflowNodeEntity } from "../../data/Workflow";
import { CaseFlowColor, type CaseEntity } from "../../data/Case";
import type { WorkflowConnectionModel } from "../../data/WorkflowNodes";
import type { CaseFlow } from "../../data/WorkflowDtos";
import type { WorkflowEntitiesDictionary } from "../WorkflowEntitiesDictionary";
import CaseActivityStatsModal from "../Case/CaseActivityStatsModal";
import * as caseFlowRenderer from "./CaseFlowRenderer";
import * as connectionIcons from "./ConnectionIcons";
import * as customMinimap from "./CustomMinimap";
import * as BpmnUtils from "./BpmnUtils";
import "diagram-js-minimap/assets/diagram-js-minimap.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css";
import "diagram-js/assets/diagram-js.css";
import "./Bpmn.css";

// Port of Signum.Workflow's Bpmn/CaseFlowViewerComponent.tsx — the READ-ONLY diagram of one case: the same
// BPMN document the designer edits, colored by what actually happened, with a per-node stats dialog.
//
// altea divergences: `componentWillReceiveProps` → `componentDidUpdate`, and the color choice is an ORDINAL.

export interface CaseFlowViewerComponentProps {
    diagramXML?: string;
    entities: WorkflowEntitiesDictionary;
    caseFlow: CaseFlow;
    case: CaseEntity;
    workflowActivity?: IWorkflowNodeEntity;
}

interface CaseFlowViewerComponentState {
    caseFlowColor: CaseFlowColor;
}

class CustomViewer extends NavigatedViewer {
}

CustomViewer.prototype._modules =
    CustomViewer.prototype._modules.concat([caseFlowRenderer, customMinimap]);

export default class CaseFlowViewerComponent
    extends React.Component<CaseFlowViewerComponentProps, CaseFlowViewerComponentState> {

    constructor(props: CaseFlowViewerComponentProps) {
        super(props);
        this.state = { caseFlowColor: CaseFlowColor.CaseMaxDuration };
    }

    viewer!: NavigatedViewer;
    divArea!: HTMLDivElement;

    handleOnModelError = (err: string): void => {
        if (err)
            throw new Error("Error rendering the model " + err);

        this.resetZoom();
        if (this.props.workflowActivity) {
            const selection = this.viewer.get<any>("selection");
            selection.select(this.props.workflowActivity.bpmnElementId);
        }
    };

    override componentDidMount(): void {
        this.viewer = new CustomViewer({
            container: this.divArea,
            keyboard: { bindTo: document },
            height: 500,
            additionalModules: [connectionIcons, searchPad],
        });
        this.configureModules();
        if (this.props.diagramXML && this.props.diagramXML.trim() !== "") {
            this.viewer.on("element.dblclick", 1500, this.handleElementDoubleClick as (obj: BPMN.Event) => void);
            this.viewer.importXML(this.props.diagramXML, this.handleOnModelError);
        }
    }

    handleElementDoubleClick = (obj: BPMN.DoubleClickEvent): void => {
        obj.preventDefault();
        obj.stopPropagation();
        this.showCaseActivityStatsModal(obj.element.id);
    };

    showCaseActivityStatsModal(bpmnElementId: string): void {
        const stats = this.props.caseFlow.activities[bpmnElementId];
        if (stats)
            void CaseActivityStatsModal.show(this.props.case, stats);
    }

    override componentWillUnmount(): void {
        this.viewer.destroy();
    }

    override componentDidUpdate(prevProps: CaseFlowViewerComponentProps): void {
        if (this.viewer && this.props.diagramXML !== undefined && prevProps.diagramXML !== this.props.diagramXML)
            this.viewer.importXML(this.props.diagramXML, this.handleOnModelError);
    }

    configureModules(): void {
        const conIcons = this.viewer.get<connectionIcons.ConnectionIcons>("connectionIcons");
        conIcons.hasAction = con => (this.props.entities[con.id] as WorkflowConnectionModel | undefined)?.action ?? undefined;
        conIcons.hasCondition = con => (this.props.entities[con.id] as WorkflowConnectionModel | undefined)?.condition ?? undefined;

        const renderer = this.viewer.get<caseFlowRenderer.CaseFlowRenderer>("caseFlowRenderer");
        renderer.getConnectionType = con => (this.props.entities[con.id] as WorkflowConnectionModel | undefined)?.type ?? undefined;
        renderer.getDecisionStyle = con => BpmnUtils.findDecisionStyle(con, this.props.entities);

        renderer.viewer = this.viewer;
        renderer.caseFlow = this.props.caseFlow;
        renderer.maxDuration = Object.values(this.props.caseFlow.activities)
            .map(a => a.map(x => x.duration || 0).sum()).max() ?? 0;
        renderer.caseFlowColor = this.state.caseFlowColor;

        conIcons.show();
    }

    handleChangeColor = (color: CaseFlowColor): void => {
        this.setState({ caseFlowColor: color });
        this.viewer.get<caseFlowRenderer.CaseFlowRenderer>("caseFlowRenderer").caseFlowColor = color;
        this.redrawAll();
    };

    private redrawAll(): void {
        const reg = this.viewer.get<BPMN.ElementRegistry>("elementRegistry");
        const gFactory = this.viewer.get<BPMN.GraphicsFactory>("graphicsFactory");
        reg.getAll().forEach(a => {
            const type = BpmnUtils.isConnection(a.type) ? "connection" : "shape";
            gFactory.update(type, a, reg.getGraphics(a));
        });
    }

    handleSearchClick = (): void => {
        this.viewer.get<any>("searchPad").toggle();
    };

    resetZoom(): void {
        this.viewer.get<any>("zoomScroll").reset();
    }

    focusElement(bpmnElementId: string): void {
        const pad = this.viewer.get<any>("searchPad");
        pad._search(bpmnElementId);
        pad._resetOverlay();
    }

    override render(): React.JSX.Element {
        return (
            <div>
                <div className="btn-toolbar">
                    <Button variant="light" onClick={() => this.resetZoom()}>
                        {WorkflowMessage.ResetZoom.niceToString()}
                    </Button>
                    <DropdownButton id="colorMenu" variant="light"
                        title={WorkflowMessage.Color.niceToString() + Enum.niceName(CaseFlowColor, this.state.caseFlowColor)}>
                        {this.menuItem(CaseFlowColor.CaseMaxDuration)}
                        {this.menuItem(CaseFlowColor.AverageDuration)}
                        {this.menuItem(CaseFlowColor.EstimatedDuration)}
                    </DropdownButton>
                    <Button variant="light" onClick={this.handleSearchClick}>
                        {SearchMessage.Search.niceToString()}
                    </Button>
                </div>
                <div ref={de => { this.divArea = de!; }} />
            </div>
        );
    }

    menuItem(color: CaseFlowColor): React.JSX.Element {
        return (
            <Dropdown.Item onClick={() => this.handleChangeColor(color)} active={this.state.caseFlowColor === color}>
                {Enum.niceName(CaseFlowColor, color)}
            </Dropdown.Item>
        );
    }
}
