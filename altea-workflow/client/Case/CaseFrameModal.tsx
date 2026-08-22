import * as React from "react";
import { Modal } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { openModal, FunctionalAdapter } from "@altea/altea/client/Modals";
import type { IModalProps, IHandleKeyboard } from "@altea/altea/client/Modals";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import * as AppContext from "@altea/altea/client/AppContext";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { Navigator } from "@altea/altea/client/Navigator";
import { TypeContext } from "@altea/altea/client/TypeContext";
import type { EntityFrame, FunctionalFrameComponent, StyleOptions } from "@altea/altea/client/TypeContext";
import { GraphExplorer, entityInfo, getTypeInfo, getTypeName } from "@altea/altea/client/Reflection";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { ReadonlyBinding } from "@altea/altea/client/binding";
import { ButtonBar } from "@altea/altea/client/Frames/ButtonBar";
import type { ButtonBarHandle } from "@altea/altea/client/Frames/ButtonBar";
import { ValidationErrors } from "@altea/altea/client/Frames/ValidationErrors";
import type { ValidationErrorsHandle } from "@altea/altea/client/Frames/ValidationErrors";
import { renderWidgets, type WidgetContext } from "@altea/altea/client/Frames/Widgets";
import { ErrorBoundary } from "@altea/altea/client/Components";
import { ModalHeaderButtons } from "@altea/altea/client/Components/ModalHeaderButtons";
import { AutoFocus } from "@altea/altea/client/Components/AutoFocus";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useForceUpdate, useStateWithPromise } from "@altea/altea/client/Hooks";
import { JavascriptMessage, FrameMessage, SaveChangesMessage } from "@altea/altea/data/uiMessages";
import { isGraphModified } from "@altea/altea/data/changes";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { WorkflowPermission } from "../../data/Workflow";
import { CaseActivityEntity } from "../../data/CaseActivity";
import type { ICaseMainEntity } from "../../data/Case";
import type { CaseEntityPack } from "../../data/WorkflowDtos";
import { WorkflowClient } from "../WorkflowClient";
import CaseButtonBar from "./CaseButtonBar";
import CaseFlowButton from "./CaseFlowButton";
import CaseFromSenderInfo from "./CaseFromSenderInfo";
import InlineCaseTags from "./InlineCaseTags";
import "@altea/altea/client/Frames/Frames.css";
import "./CaseAct.css";

// Port of Signum.Workflow's Case/CaseFrameModal.tsx — the same two-frame arrangement as CaseFramePage, in a
// modal (which is how the Inbox opens an activity). Adapted to altea's Modals / Frames API; the divergences
// are the ones CaseFramePage documents, plus `entity.modified` → `isGraphModified(entity)`.

interface CaseFrameModalProps extends IModalProps<CaseActivityEntity | undefined> {
    ref?: React.Ref<IHandleKeyboard>;
    title?: string;
    entityOrPack: Lite<CaseActivityEntity> | CaseActivityEntity | CaseEntityPack;
    avoidPromptLooseChange?: boolean;
    readOnly?: boolean;
}

interface CaseFrameModalState {
    pack: CaseEntityPack;
    lastActivity: string;
    getComponent: (ctx: TypeContext<ICaseMainEntity>) => React.ReactElement;
    refreshCount: number;
    executing?: boolean;
}

let modalCount = 0;

export function CaseFrameModal(p: CaseFrameModalProps): React.JSX.Element {

    const [state, setState] = useStateWithPromise<CaseFrameModalState | undefined>(undefined);
    const [show, setShow] = React.useState(true);
    const prefix = React.useMemo(() => "caseModal" + (modalCount++), []);
    const okClicked = React.useRef(false);
    const buttonBarRef = React.useRef<ButtonBarHandle>(null);
    const entityComponentRef = React.useRef<React.Component | null>(null);
    const validationErrorsTop = React.useRef<ValidationErrorsHandle>(null);
    const validationErrorsBottom = React.useRef<ValidationErrorsHandle>(null);

    const forceUpdate = useForceUpdate();
    const [errorsPosition, setErrorsPosition] = React.useState<"top" | "bottom">("top");

    React.useImperativeHandle(p.ref, () => ({
        handleKeyDown(e: KeyboardEvent) {
            buttonBarRef.current?.handleKeyDown(e);
        },
    }));

    React.useEffect(() => {
        void WorkflowClient.toEntityPackWorkflow(p.entityOrPack)
            .then(pack => loadComponent(pack).then(getComponent => setPack(pack, getComponent)));
    }, [p.entityOrPack]);

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

    function loadComponent(pack: CaseEntityPack): Promise<(ctx: TypeContext<ICaseMainEntity>) => React.ReactElement> {
        return WorkflowClient.getViewPromiseComponent(pack.activity);
    }

    function handleCloseClicked(): void {
        if (state != null && isGraphModified(state.pack.activity) && !p.avoidPromptLooseChange) {
            void MessageModal.show({
                title: SaveChangesMessage.ThereAreChanges.niceToString(),
                message: JavascriptMessage.loseCurrentChanges.niceToString(),
                buttons: "yes_no",
                style: "warning",
                icon: "warning",
            }).then(result => {
                if (result === "yes")
                    setShow(false);
            });
        }
        else
            setShow(false);
    }

    function handleOnExited(): void {
        p.onExited!(okClicked.current ? state?.pack?.activity : undefined);
    }

    function setComponent(c: React.Component | null): void {
        if (c && entityComponentRef.current !== c) {
            entityComponentRef.current = c;
            forceUpdate();
        }
    }

    if (state == null) {
        return (
            <Modal size="lg" show={show} onExited={handleOnExited} onHide={handleCloseClicked} className="sf-popup-control">
                <ModalHeaderButtons onClose={handleCloseClicked}>
                    <span className="sf-entity-title">{JavascriptMessage.loading.niceToString()}</span>
                </ModalHeaderButtons>
            </Modal>
        );
    }

    const s = state;
    const pack = state.pack;
    const mainEntity = pack.activity.case.mainEntity;
    const settings = Navigator.getSettings(getTypeName(mainEntity));

    const frameComponent: FunctionalFrameComponent & WorkflowClient.IHasCaseActivity = {
        forceUpdate,
        type: CaseFrameModal,
        getCaseActivity: () => s.pack?.activity,
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
                pack.activity = newPack.entity as CaseActivityEntity;
                pack.canExecuteActivity = newPack.canExecute;
            }
            void loadComponent(pack).then(getComponent => setPack(pack, getComponent, callback));
        },
        onClose: () => p.onExited!(pack.activity),
        revalidate: () => {
            validationErrorsTop.current?.forceUpdate();
            validationErrorsBottom.current?.forceUpdate();
        },
        setError: (modelState, initialPrefix) => {
            GraphExplorer.setModelState(pack.activity, modelState, initialPrefix ?? "");
            setErrorsPosition("bottom");
            forceUpdate();
        },
        refreshCount: state.refreshCount,
        allowExchangeEntity: false,
        prefix,
        isExecuting: () => s.executing === true,
        execute,
    };

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
            void loadComponent(pack).then(getComponent => setPack(pack, getComponent, callback));
        },
        onClose: () => p.onExited!(undefined),
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
        prefix,
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
        PropertyRoute.root(ti.ctor!), new ReadonlyBinding(mainEntity, prefix));

    const wc: WidgetContext<ICaseMainEntity> = { ctx, frame: mainFrame };
    const activityPack = { entity: pack.activity, canExecute: pack.canExecuteActivity };

    function renderExpandLink(): React.ReactNode {
        const activity = pack.activity;
        if (activity == null || activity.isNew)
            return null;

        if (!Navigator.isViewable(getTypeName(activity)))
            return null;

        return (
            <LinkButton title={undefined} className="sf-popup-fullscreen"
                onClick={e => AppContext.pushOrOpenInTab("/workflow/activity/" + activity.id, e)}>
                <FontAwesomeIcon icon="up-right-from-square" title={FrameMessage.Fullscreen.niceToString()} />
            </LinkButton>
        );
    }

    return (
        <Modal size="lg" show={show} onExited={handleOnExited} onHide={handleCloseClicked} className="sf-popup-control">
            <ModalHeaderButtons onClose={handleCloseClicked}>
                <div>
                    <span className="sf-entity-title">{p.title || Navigator.renderEntity(pack.activity)}</span>&nbsp;
                    {renderExpandLink()}
                    <div className="sf-entity-sub-title">
                        <small className="sf-type-nice-name text-muted">
                            {Navigator.getTypeSubTitle(pack.activity, undefined)}
                        </small>
                        {renderWidgets(wc, settings?.stickyHeader)}
                    </div>
                </div>
            </ModalHeaderButtons>

            <div className="case-activity-widgets mt-2 me-2">
                {!pack.activity.case.isNew &&
                    <div className="mx-2">
                        <InlineCaseTags case={pack.activity.case.toLite()} avoidHideIcon={true} />
                    </div>}
                {!pack.activity.case.isNew && AuthClient.isPermissionAuthorized(WorkflowPermission.ViewCaseFlow) &&
                    <CaseFlowButton caseActivity={pack.activity} />}
            </div>
            <CaseFromSenderInfo current={pack.activity} />
            <div className="modal-body">
                <div className="sf-main-control" data-refresh-count={state.refreshCount}
                    data-activity-entity={entityInfo(pack.activity)}>
                    <div className="sf-main-entity case-main-entity"
                        style={s.executing ? { opacity: ".7" } : undefined}
                        data-main-entity={entityInfo(mainEntity as Entity)}>
                        <div className="sf-button-widget-container">
                            {entityComponentRef.current && !(mainEntity as Entity).isNew && !pack.activity.doneBy
                                ? <ButtonBar ref={buttonBarRef} frame={mainFrame} pack={mainFrame.pack} />
                                : <br />}
                        </div>
                        {errorsPosition === "top" &&
                            <ValidationErrors entity={mainEntity} ref={validationErrorsTop} prefix={prefix} />}
                        <ErrorBoundary>
                            {state.getComponent &&
                                <AutoFocus>{FunctionalAdapter.withRef(state.getComponent(ctx), c => setComponent(c))}</AutoFocus>}
                        </ErrorBoundary>
                        <br />
                        {errorsPosition === "bottom" &&
                            <ValidationErrors entity={mainEntity} ref={validationErrorsBottom} prefix={prefix} />}
                    </div>
                </div>
                {entityComponentRef.current && <CaseButtonBar frame={activityFrame} pack={activityPack} />}
            </div>
        </Modal>
    );
}

export namespace CaseFrameModalManager {
    export function openView(entityOrPack: Lite<CaseActivityEntity> | CaseActivityEntity | CaseEntityPack,
        options?: { readOnly?: boolean }): Promise<CaseActivityEntity | undefined> {

        return openModal<CaseActivityEntity>(<CaseFrameModal
            entityOrPack={entityOrPack}
            readOnly={options?.readOnly ?? false} />);
    }
}
