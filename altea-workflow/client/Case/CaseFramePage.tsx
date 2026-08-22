import * as React from "react";
import { useParams } from "react-router";
import * as AppContext from "@altea/altea/client/AppContext";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { Navigator } from "@altea/altea/client/Navigator";
import { TypeContext } from "@altea/altea/client/TypeContext";
import type { EntityFrame, FunctionalFrameComponent, StyleOptions } from "@altea/altea/client/TypeContext";
import { GraphExplorer, entityInfo, getTypeInfo, getTypeName, parseId } from "@altea/altea/client/Reflection";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { ReadonlyBinding } from "@altea/altea/client/binding";
import { ButtonBar } from "@altea/altea/client/Frames/ButtonBar";
import type { ButtonBarHandle } from "@altea/altea/client/Frames/ButtonBar";
import { ValidationErrors } from "@altea/altea/client/Frames/ValidationErrors";
import type { ValidationErrorsHandle } from "@altea/altea/client/Frames/ValidationErrors";
import { renderWidgets, type WidgetContext } from "@altea/altea/client/Frames/Widgets";
import { ErrorBoundary } from "@altea/altea/client/Components";
import { AutoFocus } from "@altea/altea/client/Components/AutoFocus";
import { FunctionalAdapter } from "@altea/altea/client/Modals";
import { useForceUpdate, useStateWithPromise } from "@altea/altea/client/Hooks";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import type { Entity } from "@altea/altea/data/entity";
import { Enum } from "@altea/altea/data/enum";
import { WorkflowEntity, WorkflowMainEntityStrategy, WorkflowPermission } from "../../data/Workflow";
import { CaseActivityEntity } from "../../data/CaseActivity";
import type { ICaseMainEntity } from "../../data/Case";
import type { CaseEntityPack } from "../../data/WorkflowDtos";
import { WorkflowClient } from "../WorkflowClient";
import CaseButtonBar from "./CaseButtonBar";
import CaseFlowButton from "./CaseFlowButton";
import InlineCaseTags from "./InlineCaseTags";
import "@altea/altea/client/Frames/Frames.css";
import "./CaseAct.css";

// Port of Signum.Workflow's Case/CaseFramePage.tsx — the page a case activity opens as: the MAIN ENTITY's own
// view, framed by the activity's buttons (Next / Jump / …) and its note field.
//
// Its shape is Signum's, adapted to altea's FramePage (which the port follows for the frame's members and for
// the title / widgets / validation-errors layout). TWO frames are built over the same component, as in Signum:
// the MAIN frame drives the entity's own operations, the ACTIVITY frame drives the workflow buttons — which is
// how "Save the order" and "send the activity to the next step" can sit on one page without fighting.
//
// altea divergences: `entity.Type` → `getTypeName(entity)`, `toLite(x)` → `x.toLite()`, and the permission
// gate is `AuthClient.isPermissionAuthorized` — altea's core client has no isPermissionAuthorized (Signum
// puts it on AppContext); it is an authorization concept, so it lives in altea-auth.

interface CaseFramePageState {
    pack: CaseEntityPack;
    lastActivity: string;
    getComponent: (ctx: TypeContext<ICaseMainEntity>) => React.ReactElement;
    refreshCount: number;
    executing?: boolean;
}

function CaseFramePage(): React.JSX.Element {

    const params = useParams() as { workflowId?: string; mainEntityStrategy?: string; caseActivityId?: string };
    const [state, setState] = useStateWithPromise<CaseFramePageState | undefined>(undefined);

    const buttonBarRef = React.useRef<ButtonBarHandle>(null);
    const entityComponentRef = React.useRef<React.Component | null>(null);
    const validationErrorsTop = React.useRef<ValidationErrorsHandle>(null);
    const validationErrorsBottom = React.useRef<ValidationErrorsHandle>(null);
    const forceUpdate = useForceUpdate();

    const [errorsPosition, setErrorsPosition] = React.useState<"top" | "bottom">("top");

    React.useEffect(() => {

        function loadEntity(): Promise<CaseEntityPack | undefined> {
            if (params.caseActivityId)
                return WorkflowClient.API.fetchActivityForViewing(
                    CaseActivityEntity.newLite(CaseActivityEntity.parseId(params.caseActivityId)));

            if (params.workflowId) {
                return WorkflowClient.createNewCase(params.workflowId,
                    Enum.toValue(WorkflowMainEntityStrategy, params.mainEntityStrategy as keyof typeof WorkflowMainEntityStrategy));
            }

            throw new Error("No caseActivityId or workflowId set");
        }

        void loadEntity().then(pack => {
            if (pack)
                void WorkflowClient.getViewPromiseComponent(pack.activity).then(c => setPack(pack, c));
            else
                // Signum navigates back one history entry (`navigate(-1)`); altea's navigate takes a URL,
                // so a cancelled "create a case" lands on the inbox, which is where it was started from.
                AppContext.navigate(WorkflowClient.getDefaultInboxUrl());
        });

    }, [params.caseActivityId, params.workflowId, params.mainEntityStrategy]);

    function handleKeyDown(e: KeyboardEvent): void {
        if (!e.openedModals && buttonBarRef.current)
            buttonBarRef.current.handleKeyDown(e);
    }

    React.useEffect(() => {
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, []);

    AppContext.useTitle(state == null ? "" : state.pack.activity.case.toString() ?? "", [state]);

    function onClose(): void {
        AppContext.navigate(WorkflowClient.getDefaultInboxUrl());
    }

    function setComponent(c: React.Component | null): void {
        if (c && entityComponentRef.current !== c) {
            entityComponentRef.current = c;
            forceUpdate();
        }
    }

    function setPack(pack: CaseEntityPack,
        getComponent: (ctx: TypeContext<ICaseMainEntity>) => React.ReactElement,
        callback?: () => void): void {
        void setState({
            pack,
            lastActivity: JSON.stringify(pack.activity),
            getComponent,
            refreshCount: state ? state.refreshCount + 1 : 0,
        }).then(callback);
    }

    if (!state) {
        return (
            <div className="normal-control">
                <h3 className="border-bottom pb-3">{JavascriptMessage.loading.niceToString()}</h3>
            </div>
        );
    }

    const s = state;
    const pack = state.pack;

    const frameComponent: FunctionalFrameComponent & WorkflowClient.IHasCaseActivity = {
        forceUpdate,
        type: CaseFramePage,
        getCaseActivity: () => pack?.activity,
    };

    const execute = async (action: () => Promise<void>): Promise<void> => {
        if (s.executing)
            return;

        s.executing = true;
        forceUpdate();
        try {
            await action();
        } finally {
            s.executing = undefined;
            forceUpdate();
        }
    };

    const activityFrame: EntityFrame = {
        tabs: undefined,
        frameComponent,
        entityComponent: entityComponentRef.current,
        pack: { entity: pack.activity, canExecute: pack.canExecuteActivity },
        onReload: (newPack, _reloadComponent, callback) => {
            if (newPack) {
                const newActivity = newPack.entity as CaseActivityEntity;
                if (pack.activity.isNew && !newActivity.isNew) {
                    AppContext.navigate("/workflow/activity/" + newActivity.id);
                    return;
                }
                pack.activity = newActivity;
                pack.canExecuteActivity = newPack.canExecute;
            }
            setPack(pack, s.getComponent, callback);
        },
        onClose: () => onClose(),
        revalidate: () => { throw new Error("Not implemented"); },
        setError: (ms, initialPrefix) => {
            GraphExplorer.setModelState(pack.activity, ms, initialPrefix ?? "");
            setErrorsPosition("bottom");
            forceUpdate();
        },
        refreshCount: state.refreshCount,
        allowExchangeEntity: false,
        prefix: "caseFrame",
        isExecuting: () => s.executing === true,
        execute,
    };

    const mainEntity = pack.activity.case.mainEntity;

    const mainFrame: EntityFrame = {
        tabs: undefined,
        frameComponent,
        entityComponent: entityComponentRef.current,
        pack: { entity: mainEntity, canExecute: pack.canExecuteMainEntity },
        onReload: (newPack, _reloadComponent, callback) => {
            if (newPack) {
                pack.activity.case.mainEntity = newPack.entity as ICaseMainEntity;
                pack.canExecuteMainEntity = newPack.canExecute;
            }
            setPack(pack, s.getComponent, callback);
        },
        onClose: () => onClose(),
        revalidate: () => {
            validationErrorsTop.current?.forceUpdate();
            validationErrorsBottom.current?.forceUpdate();
        },
        setError: (ms, initialPrefix) => {
            GraphExplorer.setModelState(mainEntity, ms, initialPrefix ?? "");
            setErrorsPosition("top");
            forceUpdate();
        },
        refreshCount: state.refreshCount,
        allowExchangeEntity: false,
        prefix: "caseFrame",
        isExecuting: () => s.executing === true,
        execute,
    };

    const mainTypeName = getTypeName(mainEntity);
    const ti = getTypeInfo(mainTypeName);

    const styleOptions: StyleOptions = {
        readOnly: Navigator.isReadOnly(mainTypeName) || Boolean(pack.activity.doneDate),
        frame: mainFrame,
    };

    const ctx = new TypeContext<ICaseMainEntity>(undefined, styleOptions,
        PropertyRoute.root(ti.ctor!), new ReadonlyBinding(mainEntity, "caseFrame"));

    const activityPack = { entity: pack.activity, canExecute: pack.canExecuteActivity };
    const settings = Navigator.getSettings(getTypeName(mainEntity));
    const wc: WidgetContext<ICaseMainEntity> = { ctx, frame: mainFrame };

    return (
        <div className="normal-control">
            <h3 className="border-bottom pb-3">
                <span className="sf-entity-title">{Navigator.renderEntity(pack.activity)}</span>
                <div className="sf-entity-sub-title">
                    <small className="sf-type-nice-name text-muted">
                        {Navigator.getTypeSubTitle(pack.activity, undefined)}
                    </small>
                    {renderWidgets(wc, settings?.stickyHeader)}
                </div>
            </h3>
            <div className="case-activity-widgets mt-2 me-2">
                {!pack.activity.case.isNew &&
                    <div className="mx-2">
                        <InlineCaseTags case={pack.activity.case.toLite()} avoidHideIcon={true} />
                    </div>}
                {!pack.activity.case.isNew && AuthClient.isPermissionAuthorized(WorkflowPermission.ViewCaseFlow) &&
                    <CaseFlowButton caseActivity={pack.activity} />}
            </div>
            <div className="sf-main-control" data-refresh-count={state.refreshCount}
                data-activity-entity={entityInfo(pack.activity)}>
                <div className="sf-main-entity case-main-entity"
                    style={s.executing === true ? { opacity: ".7" } : undefined}
                    data-main-entity={entityInfo(mainEntity as Entity)}>
                    <div className="sf-button-widget-container">
                        {entityComponentRef.current && !(mainEntity as Entity).isNew && !pack.activity.doneBy
                            ? <ButtonBar ref={buttonBarRef} frame={mainFrame} pack={mainFrame.pack} />
                            : <br />}
                    </div>
                    {errorsPosition === "top" &&
                        <ValidationErrors entity={mainEntity} ref={validationErrorsTop} prefix="caseFrame" />}
                    <ErrorBoundary>
                        {state.getComponent &&
                            <AutoFocus>{FunctionalAdapter.withRef(state.getComponent(ctx), c => setComponent(c))}</AutoFocus>}
                    </ErrorBoundary>
                    <br />
                    {errorsPosition === "bottom" &&
                        <ValidationErrors entity={mainEntity} ref={validationErrorsBottom} prefix="caseFrame" />}
                </div>
            </div>
            {entityComponentRef.current && <CaseButtonBar frame={activityFrame} pack={activityPack} />}
        </div>
    );
}

export default CaseFramePage;
