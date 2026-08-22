import * as React from "react";
import { useParams } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Finder } from "@altea/altea/client/Finder";
import { Navigator } from "@altea/altea/client/Navigator";
import { useAPI, useAPIWithReload, useForceUpdate } from "@altea/altea/client/Hooks";
import FilterBuilder from "@altea/altea/client/SearchControl/FilterBuilder";
import QueryTokenBuilder from "@altea/altea/client/SearchControl/QueryTokenBuilder";
import { SubTokensOptions, type QueryToken } from "@altea/altea/client/QueryToken";
import type { ColumnOptionParsed } from "@altea/altea/client/FindOptions";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { getQueryKey } from "@altea/altea/client/Reflection";
import { EntityControlMessage } from "@altea/altea/data/uiMessages";
import type { ColumnRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import { WorkflowActivityMonitorMessage, WorkflowEntity } from "../../data/Workflow";
import { CaseActivityEntity } from "../../data/CaseActivity";
import type { WorkflowActivityMonitor, WorkflowActivityMonitorRequest } from "../../data/WorkflowDtos";
import { WorkflowClient } from "../WorkflowClient";
import WorkflowActivityMonitorViewerComponent from "../Bpmn/WorkflowActivityMonitorViewerComponent";
import type { WorkflowActivityMonitorConfig } from "./WorkflowActivityMonitorConfig";

// Port of Signum.Workflow's ActivityMonitor/WorkflowActivityMonitorPage.tsx — "where are the cases of this
// workflow piling up?": a filter/column builder over the CaseActivity query, and the heat-mapped diagram.
//
// altea divergences:
//  - `Finder.getQueryDescription` is gone with the QueryDescription DTO. Both builders take the query's ROOT
//    TOKEN, which `Finder.getQueryRoot` resolves client-side from the registered metadata.
//  - altea has no `ColumnBuilder` component (Signum's is part of its SearchControl surface), so the column
//    list is a small local one over `QueryTokenBuilder` — the same control Signum's ColumnBuilder rows use.
//  - the config interface lives in its own module so the renderer and the stats modal can import it without
//    pulling in bpmn-js through this page.

interface WorkflowActivityMonitorPageState {
    lastConfig: WorkflowActivityMonitorConfig;
    workflowActivityMonitor: WorkflowActivityMonitor;
}

export default function WorkflowActivityMonitorPage(): React.JSX.Element {
    const params = useParams() as { workflowId: string };

    const workflow = useAPI(() => Navigator.API.fetchEntity(WorkflowEntity, params.workflowId)
        .then(w => w.toLite()), [params.workflowId]);

    const queryToken = useAPI(() => Finder.getQueryRoot(CaseActivityEntity), []);

    const config = React.useMemo(() => workflow == null ? undefined : ({
        workflow,
        filters: [],
        columns: [],
    }) as WorkflowActivityMonitorConfig, [workflow]);

    const [result, reloadResult] = useAPIWithReload<WorkflowActivityMonitorPageState | undefined>(() => {
        if (config == null)
            return Promise.resolve(undefined);

        // The config the DIAGRAM is drawn from must be the one the numbers were computed with, so the
        // renderer's per-column tooltip cannot drift from the user's still-being-edited filters.
        const snapshot: WorkflowActivityMonitorConfig = {
            workflow: config.workflow,
            filters: [...config.filters],
            columns: [...config.columns],
        };
        return WorkflowClient.API.workflowActivityMonitor(toRequest(config))
            .then(r => ({ workflowActivityMonitor: r, lastConfig: snapshot }));
    }, [config]);

    const workflowModel = useAPI(() => workflow == null
        ? Promise.resolve(undefined)
        : WorkflowClient.API.getWorkflowModel(workflow).then(wmi => wmi.model), [workflow]);

    return (
        <div>
            <h3 className="modal-title">
                {!config ? JavascriptMessage.loading.niceToString() : config.workflow.toString()}
                {config && Navigator.isViewable(WorkflowEntity) &&
                    <small>&nbsp;<a href={Navigator.navigateRoute(config.workflow)} target="blank">
                        <FontAwesomeIcon icon="pencil"
                            title={WorkflowActivityMonitorMessage.OpenWorkflow.niceToString()} />
                    </a></small>}
                <br />
                <small>{WorkflowActivityMonitorMessage.WorkflowActivityMonitor.niceToString()}</small>
            </h3>
            {config && queryToken &&
                <WorkflowActivityMonitorConfigComponent config={config} queryToken={queryToken} />}

            {!workflowModel || !result
                ? <h3>{JavascriptMessage.loading.niceToString()}</h3>
                : <div className="code-container">
                    <WorkflowActivityMonitorViewerComponent
                        onDraw={reloadResult}
                        workflowModel={workflowModel}
                        workflowActivityMonitor={result.workflowActivityMonitor}
                        workflowConfig={result.lastConfig} />
                </div>}
        </div>
    );
}

function toRequest(conf: WorkflowActivityMonitorConfig): WorkflowActivityMonitorRequest {
    return {
        workflow: conf.workflow,
        filters: Finder.toFilterRequests(conf.filters),
        columns: conf.columns.filter(c => c.token != null).map(c => ({
            token: c.token!.fullKey(),
            displayName: c.displayName ?? c.token!.niceName(),
        }) as ColumnRequest),
    };
}

export function WorkflowActivityMonitorConfigComponent(
    p: { config: WorkflowActivityMonitorConfig, queryToken: QueryToken }): React.JSX.Element {

    const filterOpts = SubTokensOptions.CanAggregate | SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement;
    const columnOpts = SubTokensOptions.CanAggregate | SubTokensOptions.CanElement;

    return (
        <div>
            <FilterBuilder title={WorkflowActivityMonitorMessage.Filters.niceToString()}
                queryToken={p.queryToken} subTokensOptions={filterOpts}
                filterOptions={p.config.filters} />
            <ColumnsBuilder title={WorkflowActivityMonitorMessage.Columns.niceToString()}
                queryToken={p.queryToken} subTokensOptions={columnOpts}
                columnOptions={p.config.columns} />
        </div>
    );
}

/** The stand-in for Signum's ColumnBuilder: one QueryTokenBuilder per column, plus add / remove. */
function ColumnsBuilder(p: {
    title: React.ReactNode;
    queryToken: QueryToken;
    subTokensOptions: SubTokensOptions;
    columnOptions: ColumnOptionParsed[];
}): React.JSX.Element {

    const forceUpdate = useForceUpdate();
    const queryKey = getQueryKey(CaseActivityEntity);

    return (
        <fieldset className="form-xs">
            <legend>{p.title}</legend>
            <table className="table table-sm">
                <tbody>
                    {p.columnOptions.map((co, i) =>
                        <tr key={i}>
                            <td style={{ width: "30px" }}>
                                <a href="#" className="sf-line-button sf-remove" title={EntityControlMessage.Remove.niceToString()}
                                    onClick={e => { e.preventDefault(); p.columnOptions.removeAt(i); forceUpdate(); }}>
                                    <FontAwesomeIcon icon="xmark" />
                                </a>
                            </td>
                            <td>
                                <QueryTokenBuilder queryToken={co.token} queryKey={queryKey}
                                    subTokenOptions={p.subTokensOptions} readOnly={false}
                                    onTokenChange={token => {
                                        co.token = token;
                                        co.displayName = token?.niceName();
                                        forceUpdate();
                                    }} />
                            </td>
                        </tr>)}
                    <tr>
                        <td colSpan={2}>
                            <a href="#" className="sf-line-button sf-create" title={EntityControlMessage.Create.niceToString()}
                                onClick={e => { e.preventDefault(); p.columnOptions.push({}); forceUpdate(); }}>
                                <FontAwesomeIcon icon="plus" className="sf-create" />
                                &nbsp;{EntityControlMessage.Create.niceToString()}
                            </a>
                        </td>
                    </tr>
                </tbody>
            </table>
        </fieldset>
    );
}
