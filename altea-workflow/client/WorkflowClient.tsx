import * as React from "react";
import { Dic, ifError } from "@altea/altea/data/globals";
import { ajaxGet, ajaxPost, ValidationError } from "@altea/altea/client/Services";
import { QueryString } from "@altea/altea/client/QueryString";
import { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import { EntitySettings } from "@altea/altea/client/EntitySettings";
import { Finder } from "@altea/altea/client/Finder";
import { Constructor } from "@altea/altea/client/Constructor";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { FunctionalAdapter } from "@altea/altea/client/Modals";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import SelectorModal from "@altea/altea/client/SelectorModal";
import { QuickLinkClient, QuickLinkAction, QuickLinkLink } from "@altea/altea/client/QuickLinkClient";
import {
    Operations, EntityOperationSettings, EntityOperationContext, ContextualOperationContext,
} from "@altea/altea/client/Operations";
import { EntityOperations, OperationButton } from "@altea/altea/client/Operations/EntityOperations";
import { ContextualOperations } from "@altea/altea/client/Operations/ContextualOperations";
import {
    onContextualItems, type ContextualItemsContext, type MenuItemBlock, type MarkedRowsDictionary,
} from "@altea/altea/client/SearchControl/ContextualItems";
import SearchControlLoaded from "@altea/altea/client/SearchControl/SearchControlLoaded";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { getTypeInfo, getOperationInfo, getQueryNiceName } from "@altea/altea/client/Reflection";
import { toNumberFormat } from "@altea/altea/client/numberFormat";
import { useAPI } from "@altea/altea/client/Hooks";
import type { BsColor } from "@altea/altea/client/Components";
import type { Entity, Type } from "@altea/altea/data/entity";
import type { EntityPack } from "@altea/altea/data/entityPack";
import { Lite } from "@altea/altea/data/lite";
import { Enum } from "@altea/altea/data/enum";
import { cleanTypeName } from "@altea/altea/data/registration";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { Temporal, toInt } from "@altea/altea/data/basics";
import type { ExecuteSymbol } from "@altea/altea/data/operations";
import type { TypeEntity } from "@altea/altea/data/typeEntity";
import { UserEntity } from "@altea/altea-auth/data/User";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { UserAssetClient } from "@altea/altea-user-assets/client/UserAssetClient";
import { ToolbarClient } from "@altea/altea-toolbar/client/ToolbarClient";
import { registerSpecialAction } from "@altea/altea-omnibox/client/OmniboxSpecialAction";
import { DynamicClient } from "@altea/altea-dynamic/client/DynamicClient";
import {
    WorkflowEntity, WorkflowMessage, WorkflowModel, WorkflowOperation, WorkflowPermission,
    WorkflowMainEntityStrategy, WorkflowReplacementModel, BpmnEntityPairEmbedded,
    WorkflowActivityMonitorMessage, WorkflowEntity_MainEntityStrategy,
    type IWorkflowNodeEntity,
} from "../data/Workflow";
import {
    BootstrapStyle, ConnectionType, TimeSpanEmbedded, WorkflowActivityEntity, WorkflowActivityMessage,
    WorkflowActivityModel, WorkflowActivityType,
    WorkflowConnectionEntity, WorkflowConnectionModel, WorkflowEventEntity, WorkflowEventModel,
    WorkflowGatewayEntity, WorkflowLaneEntity, WorkflowLaneModel, WorkflowPoolEntity, WorkflowTimerEmbedded,
} from "../data/WorkflowNodes";
import { WorkflowConditionEntity } from "../data/WorkflowCondition";
import { WorkflowActionEntity } from "../data/WorkflowAction";
import { WorkflowTimerConditionEntity } from "../data/WorkflowTimerCondition";
import { WorkflowScriptEntity, WorkflowScriptRetryStrategyEntity } from "../data/WorkflowScript";
import { WorkflowEventTaskEntity } from "../data/WorkflowEventTask";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { CaseEntity, CaseMessage, CaseOperation, CaseTagsModel, CaseTagTypeEntity, type ICaseMainEntity } from "../data/Case";
import {
    CaseActivityEntity, CaseActivityMessage, CaseActivityMixin, CaseActivityOperation, InboxRowModel,
} from "../data/CaseActivity";
import { CaseNotificationEntity, CaseNotificationOperation, CaseNotificationState } from "../data/CaseNotification";
import type {
    CaseActivityMainEntityPair, CaseEntityPack, CaseFlow, CaseFlowEntityPack, EntityPackWithIssues,
    NextConnectionsRequest, WorkflowActivityMonitor, WorkflowActivityMonitorRequest, WorkflowFindNodeRequest,
    WorkflowIssue, WorkflowModelAndIssues, WorkflowScriptRunnerState,
} from "../data/WorkflowDtos";
import ActivityWithRemarksComponent from "./Case/ActivityWithRemarks";
import InboxFilter from "./Case/InboxFilter";
import ExpirationDateModal from "./Workflow/ExpirationDateModal";
import WorkflowToolbarConfig from "./WorkflowToolbarConfig";
import WorkflowToolbarMenuConfig from "./WorkflowToolbarMenuConfig";
import type { WorkflowHandle } from "./Workflow/Workflow";
import "./Case/Inbox.css";

// Port of Signum.Workflow's WorkflowClient.tsx — the module's CLIENT registration hub: routes, every entity's
// view, the Inbox's Finder settings, all the case/workflow operation settings, the quick links, and the typed
// HTTP client for /api/workflow/*.
//
// altea divergences (the module-wide ones are in ../data/Workflow.ts; these are client-side):
//  - `Navigator.addSettings(new EntitySettings(T, view))` → `cb.configure(T).withView(…)`, reaching for
//    `Navigator.getOrAddSettings` only for the options `configure` does not cover (modalSize, avoidPopup,
//    isViewable, onView, onNavigateRoute).
//  - `EvalClient.Options.checkEvalFindOptions` (the dynamic panel's "do these evals still compile?" pass) is
//    a SERVER-side registry in altea — @altea/altea-eval's `EvalLogic.registerEvalSource`, filled by
//    WorkflowLogic — because only the server can compile and it needs the rows anyway.
//    `registerDynamicPanelSearch` survives, re-homed on @altea/altea-dynamic's DynamicClient.
//  - `TypeHelpButtonBarComponent` / `WorkflowHelpComponent` (a C#-snippet cheat sheet for writing Evals) and
//    `showWorkflowTransitionContextCodeHelp` are dropped: they teach C# against a TypeHelp tree altea does not
//    have (see @altea/altea-eval's EvalLine). The activity designer's user-help slot is an injected seam
//    instead (`WorkflowActivityModelOptions.userHelpComponent`).
//  - altea has no `AutoLineModal`, so "pick an expiration date" is a small local modal (ExpirationDateModal).
//  - the Inbox is named by its ROW MODEL (`InboxRowModel`), not by Signum's `CaseActivityQuery.Inbox` enum
//    member, so its column tokens are rooted at that model rather than at CaseNotificationEntity — see the
//    model's own header. The URL is `/find/InboxRowModel`.
//  - Signum's `start({ overrideCaseActivityMixin })` flag becomes a per-type call the app makes
//    (`overrideCaseActivityMixinView(EmailMessageEntity, a => a.target)`) — see that function.
//  - `ContextualItemsContext` carries `queryToken`, not Signum's `queryDescription` (which altea has no DTO for).

declare module "@altea/altea/client/Operations" {
    interface ContextualOperationContext<T extends Entity> {
        readonly caseActivityLites?: Lite<CaseActivityEntity>[];
    }
}

declare module "@altea/altea/client/SearchControl/ContextualItems" {
    interface ContextualItemsContext<T extends Entity> {
        caseActivityLites?: Lite<CaseActivityEntity>[];
    }
}

export namespace WorkflowClient {

    /** Signum's WorkflowCustomClick — an app-supplied handler for ONE named button of ONE activity. */
    export interface WorkflowCustomClick<T extends Entity> {
        onClick: (eoc: EntityOperationContext<T>) => Promise<void>;
        onContextualClick?: (coc: ContextualOperationContext<T>) => Promise<void>;
        onContextualFromManyClick?: (coc: ContextualOperationContext<T>) => Promise<void>;
    }

    export const registeredOnClick: Record<string, Record<string, WorkflowCustomClick<any>>> = {};

    export function registerCustomClick<T extends Entity>(type: Type<T>, workflowActivity: string,
        customClickName: string, wcc: WorkflowCustomClick<T>): void {

        (registeredOnClick[workflowActivity] ??= {})[customClickName] = wcc;
    }

    export function start(cb: ClientBuilder): void {

        // Signum threads the selected case activities through the contextual context so a MAIN ENTITY's
        // operation, offered from the Inbox, can still find the activity it came from.
        Object.defineProperty(ContextualOperationContext.prototype, "caseActivityLites", {
            configurable: true,
            get: function (this: ContextualOperationContext<any>) {
                return (this.context as ContextualItemsContext<Entity>).caseActivityLites;
            },
        });

        const opsIndex = onContextualItems.indexOf(ContextualOperations.getOperationsContextualItems);
        if (opsIndex >= 0)
            onContextualItems.insertAt(opsIndex + 1, getMainEntityContextualItems);
        else
            onContextualItems.push(getMainEntityContextualItems);

        UserAssetClient.start(cb.routes);
        UserAssetClient.registerExportAssertLink(WorkflowEntity);

        ToolbarClient.registerConfig(new WorkflowToolbarConfig());
        ToolbarClient.registerConfig(new WorkflowToolbarMenuConfig());

        cb.routes.push(
            { path: "/workflow/activity/:caseActivityId", element: <ImportComponent onImport={() => import("./Case/CaseFramePage")} /> },
            { path: "/workflow/new/:workflowId/:mainEntityStrategy", element: <ImportComponent onImport={() => import("./Case/CaseFramePage")} /> },
            { path: "/workflow/panel", element: <ImportComponent onImport={() => import("./Workflow/WorkflowPanelPage")} /> },
            { path: "/workflow/activityMonitor/:workflowId", element: <ImportComponent onImport={() => import("./ActivityMonitor/WorkflowActivityMonitorPage")} /> },
        );

        // ---- The dynamic panel's search box (Signum: EvalClient.Options.registerDynamicPanelSearch) -----
        DynamicClient.registerDynamicPanelSearch(WorkflowEntity.typeName, [
            { token: "name", type: "Text" },
            { token: "mainEntityType.cleanName", type: "Text" },
        ]);
        DynamicClient.registerDynamicPanelSearch(WorkflowActivityEntity.typeName, [
            { token: "name", type: "Text" },
            { token: "viewName", type: "Text" },
        ]);
        DynamicClient.registerDynamicPanelSearch(WorkflowActionEntity.typeName, [
            { token: "name", type: "Text" },
            { token: "mainEntityType.cleanName", type: "Text" },
            { token: "eval.script", type: "Code" },
        ]);
        DynamicClient.registerDynamicPanelSearch(WorkflowScriptEntity.typeName, [
            { token: "name", type: "Text" },
            { token: "mainEntityType.cleanName", type: "Text" },
            { token: "eval.script", type: "Code" },
        ]);
        DynamicClient.registerDynamicPanelSearch(WorkflowConditionEntity.typeName, [
            { token: "name", type: "Text" },
            { token: "mainEntityType.cleanName", type: "Text" },
            { token: "eval.script", type: "Code" },
        ]);
        DynamicClient.registerDynamicPanelSearch(WorkflowTimerConditionEntity.typeName, [
            { token: "name", type: "Text" },
            { token: "mainEntityType.cleanName", type: "Text" },
            { token: "eval.script", type: "Code" },
        ]);
        DynamicClient.registerDynamicPanelSearch(WorkflowEventTaskEntity.typeName, [
            { token: "event.name", type: "Text" },
            { token: "condition.script", type: "Code" },
            { token: "action.script", type: "Code" },
        ]);

        registerSpecialAction({
            allowed: () => AuthClient.isPermissionAuthorized(WorkflowPermission.ViewWorkflowPanel),
            key: "WorkflowPanel",
            onClick: () => Promise.resolve("/workflow/panel"),
        });

        // ---- Quick links -------------------------------------------------------------------------------
        QuickLinkClient.registerQuickLink(CaseActivityEntity,
            new QuickLinkAction("caseFlow", () => WorkflowActivityMessage.CaseFlow.niceToString(), ctx => {
                void API.fetchCaseFlowPack(ctx.lite)
                    .then(result => Navigator.view(result.pack.entity,
                        { extraProps: { workflowActivity: result.workflowActivity } }))
                    .then(() => ctx.contextualContext && ctx.contextualContext.markRows({}));
            }, {
                isVisible: AuthClient.isPermissionAuthorized(WorkflowPermission.ViewCaseFlow),
                icon: "shuffle",
                iconColor: "green",
            }));

        QuickLinkClient.registerQuickLink(WorkflowEntity,
            new QuickLinkLink("bam", () => WorkflowActivityMonitorMessage.WorkflowActivityMonitor.niceToString(),
                ctx => workflowActivityMonitorUrl(ctx.lite), { icon: "gauge", iconColor: "green" }));

        // ---- Finder settings ---------------------------------------------------------------------------
        // The tokens are CAMEL-CASE literals, not `Type.token(a => a.case)`. altea's entity-property token
        // key IS the field name (`EntityPropertyToken.key`), and the SERVER's `QueryLogic.getToken` is a
        // strict Map lookup — so any token string that reaches it must already be camelCase. `Type.token()`
        // still PascalCases (Signum's `tokenSequence`), which survives wherever the CLIENT resolves the
        // string first and re-serialises the canonical key, but not here. The system hops keep their
        // PascalCase (`HasValue`) and a cast is `.(WorkflowActivity)`, as the token tree spells them. Same
        // shape as altea-auth-azuread's directory-search settings.
        cb.configure(CaseActivityEntity)
            .withQuerySettings(() => ({
                defaultFilters: [
                    {
                        token: "doneDate.HasValue", value: null,
                        pinned: { active: "WhenHasValue", column: 1, label: "Is Done" },
                    },
                    {
                        token: "workflowActivity.(WorkflowActivity)",
                        pinned: { active: "WhenHasValue", column: 2, label: () => WorkflowActivityEntity.niceName() },
                    },
                    {
                        token: "workflowActivity.(WorkflowActivity).lane.pool.workflow",
                        pinned: { active: "WhenHasValue", column: 3 },
                    },
                    { token: "case", pinned: { active: "WhenHasValue", column: 4 } },
                ],
            }));

        // The Inbox. Its rows are InboxRowModel, so the tokens below are rooted at that model, where
        // Signum's were rooted at CaseNotificationEntity (its projection reused the notification's member
        // names). Camel-case literals, for the reason spelled out on the CaseActivity settings above.
        Finder.addSettings({
            queryName: InboxRowModel,
            hiddenColumns: [
                { token: "state" },
            ],
            rowAttributes: (row, sc) => {
                const rowState = sc.tryGetRowValue(row, "state");
                switch (rowState?.value as CaseNotificationState | undefined) {
                    case CaseNotificationState.New: return { className: "new-row" };
                    case CaseNotificationState.Opened: return { className: "opened-row" };
                    case CaseNotificationState.InProgress: return { className: "in-progress-row" };
                    case CaseNotificationState.Done: return { className: "done-row" };
                    case CaseNotificationState.DoneByOther: return { className: "done-by-other-row" };
                    default: return {};
                }
            },
            formatters: {
                "activity": new Finder.CellFormatter(cell => <ActivityWithRemarksComponent data={cell} />, true),
                "mainEntity": new Finder.CellFormatter(cell => <span>{cell?.toString()}</span>, true),
                "actor": new Finder.CellFormatter(cell => <span>{cell?.toString()}</span>, true),
                "sender": new Finder.CellFormatter(cell => cell && <span>{cell.toString()}</span>, true),
                "workflow": new Finder.CellFormatter(cell => <span>{cell?.toString()}</span>, true),
            },
            defaultOrders: [{ token: "startDate", orderType: "Ascending" }],
            simpleFilterBuilder: sfbc => {
                const model = InboxFilter.extract(sfbc.initialFilterOptions);

                if (!model)
                    return undefined;

                return <InboxFilter ctx={TypeContext.root(model)} />;
            },
        });

        // ---- Views -------------------------------------------------------------------------------------
        cb.configure(CaseEntity).withView(() => import("./Case/Case"));
        cb.configure(CaseTagTypeEntity).withView(() => import("./Case/CaseTagType"));
        cb.configure(CaseTagsModel).withView(() => import("./Case/CaseTagsModel"));
        cb.configure(TimeSpanEmbedded).withView(() => import("./Workflow/TimeSpan"));
        cb.configure(WorkflowActivityModel).withView(() => import("./Workflow/WorkflowActivityModel"));
        cb.configure(WorkflowConnectionModel).withView(() => import("./Workflow/WorkflowConnectionModel"));
        cb.configure(WorkflowReplacementModel).withView(() => import("./Workflow/WorkflowReplacementComponent"));
        cb.configure(WorkflowTimerConditionEntity).withView(() => import("./Workflow/WorkflowTimerCondition"));
        cb.configure(WorkflowScriptEntity).withView(() => import("./Workflow/WorkflowScript"));
        cb.configure(WorkflowEventModel).withView(() => import("./Workflow/WorkflowEventModel"));
        cb.configure(WorkflowEventTaskEntity).withView(() => import("./Workflow/WorkflowEventTask"));
        cb.configure(WorkflowScriptRetryStrategyEntity).withView(() => import("./Workflow/WorkflowScriptRetryStrategy"));

        cb.configure(WorkflowConditionEntity).withView(() => import("./Workflow/WorkflowCondition"));
        Navigator.getOrAddSettings(WorkflowConditionEntity).modalSize = "xl";
        cb.configure(WorkflowActionEntity).withView(() => import("./Workflow/WorkflowAction"));
        Navigator.getOrAddSettings(WorkflowActionEntity).modalSize = "xl";
        cb.configure(WorkflowLaneModel).withView(() => import("./Workflow/WorkflowLaneModel"));
        Navigator.getOrAddSettings(WorkflowLaneModel).modalSize = "xl";

        // The designer is a PAGE, never a popup (its BPMN canvas needs the room).
        cb.configure(WorkflowEntity).withView(() => import("./Workflow/Workflow"));
        Navigator.getOrAddSettings(WorkflowEntity).avoidPopup = true;

        // A case activity is opened by its own page/modal, not the generic frame.
        Navigator.addSettings(new EntitySettings(CaseActivityEntity, undefined, {
            onNavigateRoute: (typeName, id) => "/workflow/activity/" + id,
            onView: (entityOrPack, viewOptions) => viewCase(
                (entityOrPack as EntityPack<CaseActivityEntity>).entity
                    ? (entityOrPack as EntityPack<CaseActivityEntity>).entity
                    : entityOrPack as CaseActivityEntity,
                viewOptions),
        }) as unknown as EntitySettings);

        // The workflow nodes are only ever seen through the designer.
        hide(WorkflowPoolEntity);
        hide(WorkflowLaneEntity);
        hide(WorkflowActivityEntity);
        hide(WorkflowGatewayEntity);
        hide(WorkflowEventEntity);
        hide(WorkflowConnectionEntity);

        // ---- Constructors ------------------------------------------------------------------------------
        Constructor.registerConstructor(TimeSpanEmbedded,
            () => TimeSpanEmbedded.create({ days: toInt(0), hours: toInt(0), minutes: toInt(0), seconds: toInt(0) }));
        Constructor.registerConstructor(WorkflowEntity, props => WorkflowEntity.create({
            mainEntityStrategies: [mainEntityStrategyRow(WorkflowMainEntityStrategy.CreateNew)],
            ...props,
        }));
        Constructor.registerConstructor(WorkflowTimerEmbedded, props => Constructor.construct(TimeSpanEmbedded)
            .then(ts => ts && WorkflowTimerEmbedded.create({ duration: ts, ...props })));

        // ---- Operations --------------------------------------------------------------------------------
        registerCaseOperations();
        registerWorkflowOperations();
    }

    /** Builds the @part row a workflow's `mainEntityStrategies` collection holds (Signum: newMListElement). */
    function mainEntityStrategyRow(strategy: WorkflowMainEntityStrategy): WorkflowEntity_MainEntityStrategy {
        return WorkflowEntity_MainEntityStrategy.create({ strategy });
    }

    function hide<T extends Entity>(type: Type<T>): void {
        const es = Navigator.getOrAddSettings(type);
        es.isViewable = "Never";
        es.isCreable = "Never";
    }

    function askDeleteMainEntity(mainEntity?: ICaseMainEntity): Promise<boolean | undefined> {
        return MessageModal.show({
            title: CaseMessage.DeleteMainEntity.niceToString(),
            message: mainEntity == null
                ? CaseMessage.DoYouWAntToAlsoDeleteTheMainEntities.niceToString()
                : CaseMessage.DoYouWAntToAlsoDeleteTheMainEntity0.niceToString(mainEntity.toString()),
            buttons: "yes_no_cancel",
            style: "warning",
        }).then(u => u === "cancel" || u == null ? undefined : u === "yes");
    }

    function registerCaseOperations(): void {

        Operations.addSettings(new EntityOperationSettings(CaseNotificationOperation.SetRemarks,
            { isVisible: () => false }));

        Operations.addSettings(new EntityOperationSettings(
            CaseNotificationOperation.CreateCaseNotificationFromCaseActivity, {
            onClick: eoc => {
                eoc.onConstructFromSuccess = () => { Operations.notifySuccess(); return Promise.resolve(); };
                return Finder.find(UserEntity).then(u => u && eoc.defaultClick(u));
            },
        }));

        Operations.addSettings(new EntityOperationSettings(CaseOperation.Delete, {
            commonOnClick: oc => oc.getEntity().then(e => askDeleteMainEntity(e.mainEntity))
                .then(u => u == undefined ? undefined : oc.defaultClick(u)),
            contextualFromMany: {
                onClick: coc => askDeleteMainEntity().then(u => u == undefined ? undefined : coc.defaultClick(u)),
            },
        }));

        Operations.addSettings(new EntityOperationSettings(CaseOperation.SetTags, { isVisible: () => false }));

        Operations.addSettings(new EntityOperationSettings(CaseActivityOperation.Delete, {
            hideOnCanExecute: true,
            isVisible: () => false,
            commonOnClick: oc => oc.getEntity().then(e => askDeleteMainEntity(e.case.mainEntity))
                .then(u => u == undefined ? undefined : oc.defaultClick(u)),
            contextualFromMany: {
                onClick: coc => askDeleteMainEntity().then(u => u == undefined ? undefined : coc.defaultClick(u)),
            },
        }));

        Operations.addSettings(new EntityOperationSettings(CaseActivityOperation.Register, {
            hideOnCanExecute: true,
            color: "primary",
            onClick: eoc => executeCaseActivity(eoc, e => e.defaultClick()),
        }));

        Operations.addSettings(new EntityOperationSettings(CaseActivityOperation.Jump, {
            icon: "share",
            iconColor: "blue",
            hideOnCanExecute: true,
            onClick: eoc => executeCaseActivity(eoc, eoc => {
                eoc.onExecuteSuccess = pack => {
                    Operations.notifySuccess();
                    eoc.frame.onClose!(pack);
                    Navigator.raiseEntityChanged(pack.entity);
                    return Promise.resolve();
                };
                return getWorkflowJumpSelector((eoc.entity.workflowActivity as WorkflowActivityEntity).toLite())
                    .then(dest => dest && eoc.defaultClick(dest));
            }),
            contextual: {
                isVisible: () => true,
                onClick: coc => Navigator.API.fetch(coc.context.lites[0])
                    .then(ca => getWorkflowJumpSelector((ca.workflowActivity as WorkflowActivityEntity).toLite()))
                    .then(dest => dest && coc.defaultClick(dest)),
            },
        }));

        Operations.addSettings(new EntityOperationSettings(CaseActivityOperation.FreeJump, {
            icon: "share-from-square",
            color: "danger",
            iconColor: "#800080",
            hideOnCanExecute: true,
            onClick: eoc => executeCaseActivity(eoc, eoc => {
                eoc.onExecuteSuccess = async pack => {
                    Operations.notifySuccess();
                    eoc.frame.onClose!(pack);
                    Navigator.raiseEntityChanged(pack.entity);
                };
                return getWorkflowFreeJump(eoc.entity.case.workflow)
                    .then(dest => dest && eoc.defaultClick(dest));
            }),
            contextual: {
                isVisible: () => true,
                onClick: coc => Navigator.API.fetch(coc.context.lites[0])
                    .then(ca => getWorkflowFreeJump(ca.case.workflow))
                    .then(dest => dest && coc.defaultClick(dest)),
            },
        }));

        Operations.addSettings(new EntityOperationSettings(CaseActivityOperation.Timer, { isVisible: () => false }));
        Operations.addSettings(new EntityOperationSettings(CaseActivityOperation.MarkAsUnread, {
            color: "dark",
            hideOnCanExecute: true,
            isVisible: () => false,
            contextual: { isVisible: () => true },
        }));
        Operations.addSettings(new EntityOperationSettings(CaseActivityOperation.ScriptExecute, { isVisible: () => false }));
        Operations.addSettings(new EntityOperationSettings(CaseActivityOperation.ScriptFailureJump, { isVisible: () => false }));
        Operations.addSettings(new EntityOperationSettings(CaseActivityOperation.ScriptScheduleRetry, { isVisible: () => false }));
        Operations.addSettings(new EntityOperationSettings(CaseActivityOperation.CreateCaseActivityFromWorkflow, { isVisible: () => false }));
        Operations.addSettings(new EntityOperationSettings(CaseActivityOperation.CreateCaseFromWorkflowEventTask, { isVisible: () => false }));

        Operations.addSettings(new EntityOperationSettings(CaseActivityOperation.Next, {
            hideOnCanExecute: true,
            color: "primary",
            onClick: eoc => executeCaseActivity(eoc, executeAndClose),
            createButton: (eoc, group) => {
                const wa = eoc.entity.workflowActivity as WorkflowActivityEntity;
                const s = eoc.settings;
                if (wa.type === WorkflowActivityType.Task) {
                    return [{
                        order: s?.order ?? 0,
                        shortcut: e => eoc.onKeyDown(e),
                        button: wa.customNextButton == null
                            ? <OperationButton eoc={eoc} group={group} />
                            : <OperationButton eoc={eoc} group={group}
                                color={buttonColor(wa.customNextButton.style)}
                                onOperationClick={async () => {
                                    const custom = registeredOnClick[wa.name]?.[wa.customNextButton!.name];
                                    if (custom)
                                        await custom.onClick(eoc);
                                    else
                                        eoc.frame.execute(() => eoc.defaultClick(wa.customNextButton!.name));
                                }}>{wa.customNextButton.name} </OperationButton>,
                    }];
                }
                else if (wa.type === WorkflowActivityType.Decision) {
                    return wa.decisionOptions.map(row => ({
                        order: s?.order ?? 0,
                        shortcut: undefined,
                        button: <OperationButton eoc={eoc} group={group}
                            color={buttonColor(row.option.style)}
                            onOperationClick={async () => {

                                const custom = registeredOnClick[wa.name]?.[row.option.name];
                                if (custom) {
                                    await custom.onClick(eoc);
                                    return;
                                }

                                if (row.option.withConfirmation) {
                                    const answer = await MessageModal.show({
                                        title: WorkflowActivityMessage.Confirmation.niceToString(),
                                        message: WorkflowActivityMessage.AreYouSureYouWantToExecute0
                                            .niceToString(row.option.name),
                                        buttons: "yes_no",
                                        style: "warning",
                                    });

                                    if (answer !== "yes")
                                        return;
                                }

                                eoc.frame.execute(() => eoc.defaultClick(row.option.name));
                            }}>
                            {row.option.name}
                        </OperationButton>,
                    }));
                }
                else
                    return [];
            },
            contextual: {
                settersConfig: () => "NoDialog",
                isVisible: () => true,
                createMenuItems: coc => {
                    const wa = coc.pack!.entity.workflowActivity as WorkflowActivityEntity;
                    if (wa.type === WorkflowActivityType.Task) {
                        return [wa.customNextButton == null
                            ? <ContextualOperations.OperationMenuItem coc={coc} />
                            : <ContextualOperations.OperationMenuItem coc={coc}
                                color={buttonColor(wa.customNextButton.style)}>
                                {wa.customNextButton.name}
                            </ContextualOperations.OperationMenuItem>];
                    }
                    else if (wa.type === WorkflowActivityType.Decision) {
                        return wa.decisionOptions.map((row, i) =>
                            <ContextualOperations.OperationMenuItem key={i} coc={coc}
                                onOperationClick={() => coc.defaultClick(row.option.name)}
                                color={buttonColor(row.option.style)}>
                                {row.option.name}
                            </ContextualOperations.OperationMenuItem>);
                    }
                    else
                        return [];
                },
            },
            contextualFromMany: {
                isVisible: () => true,
                color: "primary",
                createMenuItems: coc => [<CaseActivitiyOperations caseActivities={coc.context.lites} coc={coc} />],
                settersConfig: () => "NoDialog",
            },
        }));

        Operations.addSettings(new EntityOperationSettings(CaseActivityOperation.Undo, {
            hideOnCanExecute: true,
            color: "danger",
            onClick: eoc => executeCaseActivity(eoc, executeAndClose),
            contextual: { isVisible: () => true },
            contextualFromMany: { isVisible: () => true, color: "danger" },
        }));

        Operations.addSettings(new EntityOperationSettings(CaseActivityOperation.ResetToCaseActivity, {
            isVisible: () => false,
            contextual: {
                isVisible: () => true,
                color: "warning",
                icon: "rotate-left",
                confirmMessage: () => CaseActivityMessage
                    .AreYouSureYouWantToResetTheCaseBackToTheSelectedActivity.niceToString(),
            },
            contextualFromMany: { isVisible: () => false },
        }));
    }

    function registerWorkflowOperations(): void {

        Operations.addSettings(new EntityOperationSettings(WorkflowOperation.Save,
            { color: "primary", onClick: executeWorkflowSave, alternatives: () => [] }));
        Operations.addSettings(new EntityOperationSettings(WorkflowOperation.Delete,
            { contextualFromMany: { isVisible: () => false } }));
        Operations.addSettings(new EntityOperationSettings(WorkflowOperation.Activate, {
            contextual: { icon: "heart-pulse", iconColor: "red" },
            contextualFromMany: { icon: "heart-pulse", iconColor: "red" },
        }));
        Operations.addSettings(new EntityOperationSettings(WorkflowOperation.Deactivate, {
            onClick: eoc => chooseWorkflowExpirationDate([eoc.entity.toLite()])
                .then(val => !val ? undefined : eoc.defaultClick(val)),
            contextual: {
                onClick: coc => chooseWorkflowExpirationDate(coc.context.lites)
                    .then(val => !val ? undefined : coc.defaultClick(val)),
                icon: ["far", "heart"],
                iconColor: "gray",
            },
            contextualFromMany: {
                onClick: coc => chooseWorkflowExpirationDate(coc.context.lites)
                    .then(val => !val ? undefined : coc.defaultClick(val)),
                icon: ["far", "heart"],
                iconColor: "gray",
            },
        }));
    }

    function chooseWorkflowExpirationDate(workflows: Lite<WorkflowEntity>[]):
        Promise<Temporal.PlainDateTime | undefined> {
        return ExpirationDateModal.show({
            title: WorkflowMessage.DeactivateWorkflow.niceToString(),
            message:
                <div>
                    <strong>{WorkflowMessage.PleaseChooseExpirationDate.niceToString()}</strong>
                    <ul>{workflows.map((w, i) => <li key={i}>{w.toString()}</li>)}</ul>
                </div>,
        });
    }

    /**
     * Signum's `start({ overrideCaseActivityMixin: true })` — show the owning case activity, read-only, on a
     * type that carries the CaseActivityMixin.
     *
     * altea divergence: Signum hard-codes the two types it knows (SMSMessageEntity after `referred`,
     * EmailMessageEntity after `target`), each with the ANCHOR its line goes after. Which types carry the
     * mixin is the APP's decision here (`sb.include(X).withCaseActivityMixin()`) and there is no generic
     * anchor, so this is a per-type call the app makes rather than one boolean flag. Signum's SMS module is
     * not ported, so EmailMessageEntity is the only in-repo caller.
     */
    export function overrideCaseActivityMixinView<T extends Entity>(type: Type<T>,
        afterLine: (entity: T) => unknown): void {

        if (!CaseActivityMixin.isDeclaredOn(type))
            throw new Error("CaseActivityMixin is not declared on " + cleanTypeName(type)
                + " — call sb.include(...).withCaseActivityMixin() on the server first.");

        if (!Navigator.isViewable(type))
            return;

        Navigator.getOrAddSettings(type).overrideView(vr => {
            vr.insertAfterLine(afterLine, ctx => [
                <EntityLine ctx={ctx.subCtx(a => a.mixin(CaseActivityMixin)).subCtx(m => m.caseActivity)}
                    readOnly={true} />,
            ]);
        });
    }

    // ---- The main entity's contextual operations, offered from the Inbox --------------------------------

    async function getMainEntityContextualItems(ctx: ContextualItemsContext<Entity>):
        Promise<MenuItemBlock | undefined> {

        if (ctx.lites.length === 0)
            return undefined;

        if (cleanTypeName(ctx.lites[0].entityType) !== CaseActivityEntity.typeName)
            return undefined;

        if (ctx.container instanceof SearchControlLoaded && ctx.container.state.resultFindOptions?.systemTime)
            return undefined;

        const caseActivityLites = ctx.lites as Lite<CaseActivityEntity>[];
        const pairs = await API.mainEntitiesFromCaseActivities(caseActivityLites);

        if (pairs.length === 0)
            return undefined;

        const types = pairs.map(p => cleanTypeName(p.mainEntity.entityType)).distinctBy();
        if (types.length !== 1)
            return undefined;

        const mainEntityLites = pairs.map(p => p.mainEntity);
        const caByMainKey: { [k: string]: Lite<CaseActivityEntity> } = {};
        pairs.forEach(p => caByMainKey[p.mainEntity.key()] = p.caseActivity);

        const translatedCtx: ContextualItemsContext<Entity> = {
            lites: mainEntityLites as Lite<Entity>[],
            queryToken: ctx.queryToken,
            styleContext: ctx.styleContext,
            caseActivityLites: caseActivityLites,
            markRows: dic => {
                const remapped: MarkedRowsDictionary = {};
                Object.keys(dic).forEach(k => {
                    const ca = caByMainKey[k];
                    if (ca)
                        remapped[ca.key()] = dic[k];
                });
                ctx.markRows(remapped);
            },
        };

        const block = await ContextualOperations.getOperationsContextualItems(translatedCtx);
        if (!block)
            return undefined;

        block.header = WorkflowMessage._0Operations.niceToString(getTypeInfo(types[0]).getNiceName());

        return block;
    }

    // ---- URLs ------------------------------------------------------------------------------------------

    export function workflowActivityMonitorUrl(workflow: Lite<WorkflowEntity>): string {
        return `/workflow/activityMonitor/${workflow.id}`;
    }

    export function workflowStartUrl(lite: Lite<WorkflowEntity>, strategy?: WorkflowMainEntityStrategy): string {
        return "/workflow/new/" + lite.id
            + (strategy == null ? "" : ("/" + Enum.toName(WorkflowMainEntityStrategy, strategy)));
    }

    export function getDefaultInboxUrl(): string {
        return Finder.findOptionsPath({
            queryName: InboxRowModel,
            filterOptions: [{
                token: "state", operation: "IsIn",
                value: [CaseNotificationState.New, CaseNotificationState.Opened, CaseNotificationState.InProgress],
            }],
        });
    }

    // ---- Frame helpers ---------------------------------------------------------------------------------

    export function getCaseActivityContext(ctx: TypeContext<any>): TypeContext<CaseActivityEntity> | undefined {
        const fc = ctx.frame?.frameComponent as unknown as IHasCaseActivity | undefined;
        const activity = fc?.getCaseActivity?.();
        return activity && TypeContext.root(activity, undefined, ctx);
    }

    export interface IHasCaseActivity {
        getCaseActivity(): CaseActivityEntity | undefined;
    }

    export function inWorkflow(ctx: TypeContext<any>, workflowName: string, activityName: string): boolean {
        const fc = ctx.frame?.frameComponent as unknown as IHasCaseActivity | undefined;
        const ca = fc?.getCaseActivity?.();

        if (!ca)
            return false;

        const wa = ca.workflowActivity as WorkflowActivityEntity;

        return wa.lane.pool.workflow.name === workflowName && wa.name === activityName;
    }

    /**
     * The view an activity asks for (Signum's getViewPromiseCompoment — the typo is Signum's).
     *
     * altea divergence: a `viewNameProps` expression is stored TEXT and Signum `eval`s it. That is kept, but
     * the eval is scoped to a function so it cannot see this module's locals — an expression is meant to be a
     * literal or a simple global lookup, not a closure over the framework.
     */
    export function getViewPromiseComponent(ca: CaseActivityEntity):
        Promise<(ctx: TypeContext<ICaseMainEntity>) => React.ReactElement> {

        const wa = ca.workflowActivity as WorkflowActivityEntity;

        let viewPromise = Navigator.getViewDispatcher()
            .getViewPromise(ca.case.mainEntity, wa.viewName ?? undefined);

        if (wa.viewNameProps.length) {
            const props = wa.viewNameProps.reduce<Record<string, unknown>>((acc, row) => {
                acc[row.prop.name] = !row.prop.expression ? undefined
                    : new Function("return (" + row.prop.expression + ");")();
                return acc;
            }, {});
            viewPromise = viewPromise.withProps(props);
        }

        return viewPromise.promise as Promise<(ctx: TypeContext<ICaseMainEntity>) => React.ReactElement>;
    }

    // ---- Operation click plumbing -----------------------------------------------------------------------

    export const customOnClicks: {
        [operationKey: string]: {
            [typeName: string]: (ctx: EntityOperationContext<CaseActivityEntity>) => Promise<void>
        }
    } = {};

    export function registerOnClick<T extends ICaseMainEntity>(type: Type<T>,
        operationKey: ExecuteSymbol<CaseActivityEntity>,
        action: (ctx: EntityOperationContext<CaseActivityEntity>) => Promise<void>): void {
        (customOnClicks[operationKey.key] ??= {})[cleanTypeName(type)] = action;
    }

    export function executeCaseActivity(eoc: EntityOperationContext<CaseActivityEntity>,
        defaultOnClick: (eoc: EntityOperationContext<CaseActivityEntity>) => Promise<void>): Promise<void> {
        const onClick = customOnClicks[eoc.operationInfo.key]
            ?.[cleanTypeName(eoc.entity.case.mainEntity.constructor as Type<Entity>)];

        return onClick ? onClick(eoc) : defaultOnClick(eoc);
    }

    export function executeAndClose(eoc: EntityOperationContext<CaseActivityEntity>): Promise<void> {

        return EntityOperations.confirmInNecessary(eoc).then(conf => {
            if (!conf)
                return;

            return Operations.API.executeEntity(eoc.entity, eoc.operationInfo.key)
                .then(pack => {
                    eoc.frame.onClose!();
                    Navigator.raiseEntityChanged(pack.entity);
                    return Operations.notifySuccess();
                })
                .catch(ifError(ValidationError, e => eoc.frame.setError(e.modelState, "entity")));
        });
    }

    /**
     * The workflow SAVE — the designer's diagram XML plus the per-node models, with a "these activities are
     * being replaced, where do their cases go?" round trip first.
     */
    export function executeWorkflowSave(eoc: EntityOperationContext<WorkflowEntity>): Promise<void> {

        function saveAndSetErrors(entity: WorkflowEntity, model: WorkflowModel,
            replacementModel: WorkflowReplacementModel | undefined): Promise<void> {
            return API.saveWorkflow(entity, model, replacementModel)
                .then(packWithIssues => {
                    eoc.frame.onReload(packWithIssues.entityPack);
                    wf.setIssues(packWithIssues.issues);
                    Operations.notifySuccess();
                })
                .catch(ifError(ValidationError, e => {

                    const issuesString = e.modelState["workflowIssues"];
                    if (issuesString) {
                        wf.setIssues(JSON.parse(issuesString[0] as string) as WorkflowIssue[]);
                        delete e.modelState["workflowIssues"];
                    }
                    eoc.frame.setError(e.modelState, "entity");
                }));
        }

        const wf = FunctionalAdapter.innerRef(eoc.frame.entityComponent) as unknown as WorkflowHandle;
        return wf.getXml()
            .then(xml => {
                const wfModel = WorkflowModel.create({
                    diagramXml: xml,
                    entities: Dic.map(wf.workflowState!.entities, (bpmnId, model) =>
                        BpmnEntityPairEmbedded.create({ bpmnElementId: bpmnId, model: model })),
                });

                const promise = eoc.entity.isNew
                    ? Promise.resolve<WorkflowReplacementModel | undefined>(undefined)
                    : API.previewChanges(eoc.entity.toLite(), wfModel);

                return promise.then(repoModel => {
                    if (!repoModel || repoModel.replacements.length === 0)
                        return saveAndSetErrors(eoc.entity, wfModel, undefined);

                    return Navigator.view(repoModel).then(replacementModel => {
                        if (!replacementModel)
                            return;

                        return saveAndSetErrors(eoc.entity, wfModel, replacementModel);
                    });
                });
            });
    }

    function getWorkflowJumpSelector(activity: Lite<WorkflowActivityEntity>):
        Promise<Lite<IWorkflowNodeEntity> | undefined> {

        return API.nextConnections({ workflowActivity: activity, connectionType: ConnectionType.Jump })
            .then(jumps => SelectorModal.chooseElement(jumps, {
                title: WorkflowActivityMessage.ChooseADestinationForWorkflowJumping.niceToString(),
                buttonDisplay: a => a.toString() ?? "",
                forceShow: true,
            }));
    }

    function getWorkflowFreeJump(workflow: WorkflowEntity): Promise<Lite<WorkflowActivityEntity> | undefined> {

        return Finder.find(WorkflowActivityEntity.findOptions(token => ({
            filterOptions: [token(w => w.lane.pool.workflow).filter("EqualTo", workflow)],
        })), {
            message: <span className="text-danger">
                FreeJump is an unrestricted but dangerous operation! If you don&apos;t know what you&apos;re
                doing... don&apos;t do it!
            </span>,
        });
    }

    // ---- Opening a case -------------------------------------------------------------------------------

    export function viewCase(entityOrPack: Lite<CaseActivityEntity> | CaseActivityEntity | CaseEntityPack,
        options?: { readOnly?: boolean }): Promise<CaseActivityEntity | undefined> {
        return import("./Case/CaseFrameModal")
            .then(NP => NP.CaseFrameModalManager.openView(entityOrPack, options));
    }

    export const customSelectByUser: {
        [typeName: string]: (workflow: Lite<WorkflowEntity>, strategy: WorkflowMainEntityStrategy)
            => Promise<Lite<Entity> | undefined>
    } = {};

    export function registerCustomSelectByUser<T extends Entity>(type: Type<T>,
        selectEntity: (workflow: Lite<WorkflowEntity>, strategy: WorkflowMainEntityStrategy)
            => Promise<Lite<T> | undefined>): void {
        customSelectByUser[cleanTypeName(type)] = selectEntity as typeof customSelectByUser[string];
    }

    export function createNewCase(workflowId: string, mainEntityStrategy: WorkflowMainEntityStrategy):
        Promise<CaseEntityPack | undefined> {
        return Navigator.API.fetchEntity(WorkflowEntity, workflowId)
            .then(async wf => {
                if (mainEntityStrategy === WorkflowMainEntityStrategy.CreateNew)
                    return Operations.API.constructFromEntity(wf,
                        CaseActivityOperation.CreateCaseActivityFromWorkflow);

                const typeName = wf.mainEntityType!.cleanName;

                const cloneKey = mainEntityStrategy === WorkflowMainEntityStrategy.Clone
                    ? getOperationInfo(`${typeName}Operation.Clone`, typeName).key
                    : undefined;

                const lite = await (customSelectByUser[typeName]?.(wf.toLite(), mainEntityStrategy)
                    ?? Finder.find({ queryName: typeName }));

                if (!lite)
                    return undefined;

                const entity = await Navigator.API.fetch(lite);

                if (cloneKey != null) {
                    const pack = await Operations.API.constructFromEntity(entity, cloneKey);
                    return Operations.API.constructFromEntity(wf,
                        CaseActivityOperation.CreateCaseActivityFromWorkflow, pack!.entity);
                }

                return Operations.API.constructFromEntity(wf,
                    CaseActivityOperation.CreateCaseActivityFromWorkflow, entity);
            })
            .then(ep => ep && ({
                activity: ep.entity,
                canExecuteActivity: ep.canExecute,
                canExecuteMainEntity: {},
            }) as CaseEntityPack);
    }

    export function toEntityPackWorkflow(
        entityOrEntityPack: Lite<CaseActivityEntity> | CaseActivityEntity | CaseEntityPack):
        Promise<CaseEntityPack> {
        if ((entityOrEntityPack as CaseEntityPack).canExecuteActivity)
            return Promise.resolve(entityOrEntityPack as CaseEntityPack);

        const lite = entityOrEntityPack instanceof CaseActivityEntity
            ? entityOrEntityPack.toLite()
            : entityOrEntityPack as Lite<CaseActivityEntity>;

        return API.fetchActivityForViewing(lite);
    }

    // ---- Formatting -----------------------------------------------------------------------------------

    const intFormatter = toNumberFormat("D");

    /**
     * Signum formats a luxon Duration ("2d 3h 15m"). altea's durations on the wire are MINUTES (a plain
     * number, as in Signum's own `CaseActivityEntity.Duration`), so this takes minutes and walks the same
     * unit ladder — down to minutes, which is the resolution the engine stores.
     */
    export function formatDurationMinutes(totalMinutes: number): string {
        const units: [string, number][] = [
            ["d", 60 * 24],
            ["h", 60],
            ["m", 1],
        ];

        let rest = Math.round(totalMinutes);
        return units.map(([label, size]) => {
            const value = Math.floor(rest / size);
            rest -= value * size;
            return value === 0 ? null : intFormatter.format(value) + label;
        }).notNull().join(" ");
    }

    // ---- The multi-selection "Next" menu item ----------------------------------------------------------

    export function CaseActivitiyOperations(p: {
        caseActivities: Lite<CaseActivityEntity>[],
        coc: ContextualOperationContext<CaseActivityEntity>,
    }): React.JSX.Element | null {

        const wa = useAPI(() => API.getOnlyWorkflowActivity(p.caseActivities), [p.caseActivities]);

        if (wa === undefined)
            return <div>{JavascriptMessage.loading.niceToString()}</div>;

        if (wa === null)
            return null;

        if (wa.type === WorkflowActivityType.Task) {
            return (
                <ContextualOperations.OperationMenuItem coc={p.coc}
                    color={wa.customNextButton == null ? undefined : buttonColor(wa.customNextButton.style)}>
                    {wa.customNextButton?.name}
                </ContextualOperations.OperationMenuItem>
            );
        }

        if (wa.type === WorkflowActivityType.Decision) {
            return (<>
                {wa.decisionOptions.map((row, i) =>
                    <ContextualOperations.OperationMenuItem key={i} coc={p.coc}
                        onOperationClick={() => p.coc.defaultClick(row.option.name)}
                        color={buttonColor(row.option.style)}>
                        {row.option.name}
                    </ContextualOperations.OperationMenuItem>)}
            </>);
        }

        return null;
    }

    // ---- The HTTP client -------------------------------------------------------------------------------

    export namespace API {
        export function fetchActivityForViewing(caseActivity: Lite<CaseActivityEntity>): Promise<CaseEntityPack> {
            return ajaxGet({ url: `/api/workflow/fetchForViewing/${caseActivity.id}` });
        }

        export function fetchCaseFlowPack(caseActivity: Lite<CaseActivityEntity>): Promise<CaseFlowEntityPack> {
            return ajaxGet({ url: `/api/workflow/caseFlowPack/${caseActivity.id}` });
        }

        export function fetchCaseTags(caseLite: Lite<CaseEntity>): Promise<CaseTagTypeEntity[]> {
            return ajaxGet({ url: `/api/workflow/tags/${caseLite.id}` });
        }

        export function starts(): Promise<WorkflowEntity[]> {
            return ajaxGet({ url: `/api/workflow/starts` });
        }

        export function getWorkflowModel(workflow: Lite<WorkflowEntity>): Promise<WorkflowModelAndIssues> {
            return ajaxGet({ url: `/api/workflow/workflowModel/${workflow.id}` });
        }

        export function previewChanges(workflow: Lite<WorkflowEntity>, model: WorkflowModel):
            Promise<WorkflowReplacementModel> {
            return ajaxPost({ url: `/api/workflow/previewChanges/${workflow.id}` }, model);
        }

        export function saveWorkflow(entity: WorkflowEntity, model: WorkflowModel,
            replacementModel: WorkflowReplacementModel | undefined): Promise<EntityPackWithIssues> {
            return ajaxPost({ url: "/api/workflow/save" }, {
                entity: entity,
                operationKey: WorkflowOperation.Save.key,
                args: [model, replacementModel],
            } as Operations.API.EntityOperationRequest);
        }

        export function findMainEntityType(request: { subString: string, count: number }, signal?: AbortSignal):
            Promise<Lite<TypeEntity>[]> {
            return ajaxGet({
                url: "/api/workflow/findMainEntityType?" + QueryString.stringify(request),
                signal,
            });
        }

        export function findNode(request: WorkflowFindNodeRequest, signal?: AbortSignal):
            Promise<Lite<IWorkflowNodeEntity>[]> {
            return ajaxPost({ url: "/api/workflow/findNode", signal }, request);
        }

        export function view(): Promise<WorkflowScriptRunnerState> {
            return ajaxGet({ url: "/api/workflow/scriptRunner/view" });
        }

        export function start(): Promise<void> {
            return ajaxPost({ url: "/api/workflow/scriptRunner/start" }, undefined);
        }

        export function stop(): Promise<void> {
            return ajaxPost({ url: "/api/workflow/scriptRunner/stop" }, undefined);
        }

        export function caseFlow(c: Lite<CaseEntity>): Promise<CaseFlow> {
            return ajaxGet({ url: `/api/workflow/caseFlow/${c.id}` });
        }

        export function workflowActivityMonitor(request: WorkflowActivityMonitorRequest):
            Promise<WorkflowActivityMonitor> {
            return ajaxPost({ url: "/api/workflow/activityMonitor" }, request);
        }

        export function nextConnections(request: NextConnectionsRequest):
            Promise<Lite<IWorkflowNodeEntity>[]> {
            return ajaxPost({ url: "/api/workflow/nextConnections" }, request);
        }

        export function getOnlyWorkflowActivity(caseActivities: Lite<CaseActivityEntity>[]):
            Promise<WorkflowActivityEntity | null> {
            return ajaxPost({ url: "/api/workflow/onlyWorkflowActivity" }, caseActivities);
        }

        export function mainEntitiesFromCaseActivities(caseActivities: Lite<CaseActivityEntity>[]):
            Promise<CaseActivityMainEntityPair[]> {
            return ajaxPost({ url: "/api/workflow/mainEntitiesFromCaseActivities" }, caseActivities);
        }
    }
}

/** A BootstrapStyle ordinal → the bootstrap color name an OperationButton takes (Signum stored the member
 *  NAME, so it could just `.toLowerCase()`). */
function buttonColor(style: BootstrapStyle): BsColor {
    return Enum.toName(BootstrapStyle, style).toLowerCase() as BsColor;
}
