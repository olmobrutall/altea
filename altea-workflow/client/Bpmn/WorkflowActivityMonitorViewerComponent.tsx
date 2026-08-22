import "@altea/altea/data/globals/arrayExtensions";
import * as React from "react";
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import searchPad from "bpmn-js/lib/features/search";
import { WorkflowActivityMonitorMessage, type WorkflowModel } from "../../data/Workflow";
import { WorkflowActivityModel } from "../../data/WorkflowNodes";
import type { WorkflowActivityMonitor } from "../../data/WorkflowDtos";
import type { WorkflowActivityMonitorConfig } from "../ActivityMonitor/WorkflowActivityMonitorConfig";
import WorkflowActivityStatsModal from "../ActivityMonitor/WorkflowActivityStatsModal";
import * as workflowActivityMonitorRenderer from "./WorkflowActivityMonitorRenderer";
import * as BpmnUtils from "./BpmnUtils";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css";
import "diagram-js/assets/diagram-js.css";
import "./Bpmn.css";

// Port of Signum.Workflow's Bpmn/WorkflowActivityMonitorViewerComponent.tsx — the monitor's diagram: the same
// document, heat-mapped, with a per-activity dialog. `componentWillReceiveProps` → `componentDidUpdate`.

export interface WorkflowActivityMonitorViewerComponentProps {
    workflowModel: WorkflowModel;
    workflowActivityMonitor: WorkflowActivityMonitor;
    workflowConfig: WorkflowActivityMonitorConfig;
    onDraw: () => void;
}

class CustomViewer extends NavigatedViewer {
}

CustomViewer.prototype._modules = CustomViewer.prototype._modules.concat([workflowActivityMonitorRenderer]);

export default class WorkflowActivityMonitorViewerComponent
    extends React.Component<WorkflowActivityMonitorViewerComponentProps> {

    viewer!: NavigatedViewer;
    divArea!: HTMLDivElement;

    handleOnModelError = (err: string): void => {
        if (err)
            throw new Error("Error rendering the model " + err);
    };

    override componentDidMount(): void {
        this.viewer = new CustomViewer({
            container: this.divArea,
            keyboard: { bindTo: document },
            height: 1000,
            additionalModules: [searchPad],
        });
        this.configureModules(this.props);
        this.viewer.on("element.dblclick", 1500, this.handleElementDoubleClick as (obj: BPMN.Event) => void);
        this.viewer.importXML(this.props.workflowModel.diagramXml, this.handleOnModelError);
    }

    handleElementDoubleClick = (obj: BPMN.DoubleClickEvent): void => {
        obj.preventDefault();
        obj.stopPropagation();

        const pair = this.props.workflowModel.entities.singleOrNull(a => a.bpmnElementId === obj.element.id);

        if (pair != null && pair.model instanceof WorkflowActivityModel) {
            const actMod = pair.model;
            const stats = this.props.workflowActivityMonitor.activities
                .singleOrNull(a => a.workflowActivity.is(actMod.workflowActivity!));
            if (stats)
                void WorkflowActivityStatsModal.show(stats, this.props.workflowConfig, actMod);
        }
    };

    override componentWillUnmount(): void {
        this.viewer.destroy();
    }

    override componentDidUpdate(prevProps: WorkflowActivityMonitorViewerComponentProps): void {
        if (!this.viewer)
            return;

        const redrawAll = (): void => {
            this.configureModules(this.props);

            const reg = this.viewer.get<BPMN.ElementRegistry>("elementRegistry");
            const gFactory = this.viewer.get<BPMN.GraphicsFactory>("graphicsFactory");
            reg.getAll().forEach(a => {
                const type = BpmnUtils.isConnection(a.type) ? "connection" : "shape";
                gFactory.update(type, a, reg.getGraphics(a));
            });
        };

        if (prevProps.workflowModel.diagramXml !== this.props.workflowModel.diagramXml) {
            this.viewer.importXML(this.props.workflowModel.diagramXml, error => {
                this.handleOnModelError(error);

                if (!error && prevProps.workflowActivityMonitor !== this.props.workflowActivityMonitor)
                    redrawAll();
            });
        }
        else if (prevProps.workflowActivityMonitor !== this.props.workflowActivityMonitor)
            redrawAll();
    }

    configureModules(props: WorkflowActivityMonitorViewerComponentProps): void {
        const renderer = this.viewer
            .get<workflowActivityMonitorRenderer.WorkflowActivityMonitorRenderer>("workflowActivityMonitorRenderer");
        renderer.viewer = this.viewer;
        renderer.workflowActivityMonitor = props.workflowActivityMonitor;
        renderer.workflowModel = props.workflowModel;
        renderer.workflowConfig = props.workflowConfig;
    }

    handleSearchClick = (): void => {
        this.viewer.get<any>("searchPad").toggle();
    };

    resetZoom(): void {
        this.viewer.get<any>("zoomScroll").reset();
    }

    override render(): React.JSX.Element {
        return (
            <div>
                <div className="btn-toolbar" style={{ marginBottom: "5px" }}>
                    <button className="btn btn-primary" onClick={this.props.onDraw}>
                        {WorkflowActivityMonitorMessage.Draw.niceToString()}
                    </button>
                    <button className="btn btn-default" onClick={() => this.resetZoom()}>
                        {WorkflowActivityMonitorMessage.ResetZoom.niceToString()}
                    </button>
                    <button className="btn btn-default" onClick={this.handleSearchClick}>
                        {WorkflowActivityMonitorMessage.Find.niceToString()}
                    </button>
                </div>
                <div style={{ border: "1px solid lightgray" }} ref={de => { this.divArea = de!; }} />
            </div>
        );
    }
}
