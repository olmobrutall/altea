import * as React from 'react';
import { useParams } from 'react-router';
import { Tabs, Tab, Modal } from 'react-bootstrap';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { RenderEntity } from '@altea/altea/client/Lines/RenderEntity';
import { TypeContext } from '@altea/altea/client/TypeContext';
import { Navigator } from '@altea/altea/client/Navigator';
import SearchControl from '@altea/altea/client/SearchControl/SearchControl';
import type { SearchControlHandler } from '@altea/altea/client/SearchControl/SearchControl';
import type { SearchControlLoaded } from '@altea/altea/client/SearchControl/SearchControlLoaded';
import EntityLink from '@altea/altea/client/SearchControl/EntityLink';
import { QueryTokenString } from '@altea/altea/client/QueryTokenString';
import { getTypeName } from '@altea/altea/client/Reflection';
import { useAPI, useForceUpdate } from '@altea/altea/client/Hooks';
import { type IModalProps, openModal } from '@altea/altea/client/Modals';
import MessageModal from '@altea/altea/client/Modals/MessageModal';
import { classes } from '@altea/altea/data/globals/helpers';
import '@altea/altea/data/globals/arrayExtensions';
import type { ResultRow } from '@altea/altea/data/dynamicQuery/queryRequest';
import { Entity } from '@altea/altea/data/entity';
import { Lite } from '@altea/altea/data/lite';
import { JavascriptMessage } from '@altea/altea/data/uiMessages';
import { OperationLogEntity } from '@altea/altea/data/operationLog';
import { DiffDocument } from '@altea/altea-diff-log/client/Templates/DiffDocument';
import { TimeMachineMessage } from '../data/TimeMachine';
import { TimeMachineClient } from './TimeMachineClient';

// Port of Signum.TimeMachine's TimeMachinePage.tsx — the page (and the two modal wrappers) that lists a
// row's versions and diffs two of them.
//
// Reading it: the SearchControl at the top runs the entity's OWN query with `systemTime: { mode: "All" }`,
// so each result row is one VERSION. Picking one (or ctrl-picking two) fetches those versions through
// `TimeMachineClient.API.getEntityDump` and shows them two ways —
//   • "UI differences": the newer version rendered by the ordinary entity view, with the older one on the
//     TypeContext's `previousVersion`, which is what makes core's `getTimeMachineIcon` mark each changed
//     line (see altea/client/Lines/TimeMachineIcon);
//   • "Data differences": the two ObjectDumper texts through altea-diff-log's DiffDocument — the same
//     component and the same dump format the operation log uses.
//
// altea divergences:
//  - **no `Finder.getQueryDescription` gate.** altea has no QueryDescription (see CLAUDE.md); the
//    SearchControl resolves its own query root, so it simply renders.
//  - `newLite(type, id)` → `Entity.resolveType(type).newLite(id)`.
//  - **the header's lite is fetched, not model-filled.** Signum calls `Navigator.API.fillLiteModels` and
//    catches the failure as "[Entity deleted]"; altea has no lite MODEL and no such endpoint, so the
//    display text comes from retrieving the row — which is the same existence probe, one call either way.
//  - Signum's stray `console.log(pair)` in RenderEntityVersion is dropped.

export default function TimeMachinePage(): React.JSX.Element {
    const params = useParams() as { type: string; id: string };

    // Signum fills the lite's display MODEL (`Navigator.API.fillLiteModels`) and falls back to
    // "[Entity deleted]". altea has no lite-model endpoint, so the display text comes from actually
    // retrieving the row — which also IS the "does it still exist?" probe Signum's catch relies on.
    const lite = useAPI(async () => {
        const type = Entity.resolveType(params.type);
        const id = type.parseId(params.id);
        try {
            return (await Navigator.API.fetchEntity(type, id)).toLite();
        } catch {
            return type.newLite(id, TimeMachineMessage.EntityDeleted.niceToString());
        }
    }, [params.type, params.id]);

    if (lite == undefined)
        return <h1 className="h4"><span className="display-6">{JavascriptMessage.loading.niceToString()}</span></h1>;

    return <TimeMachine lite={lite} />;
}

export function TimeMachine(p: { lite: Lite<Entity>; isModal?: boolean }): React.JSX.Element {

    const searchControl = React.useRef<SearchControlHandler>(null);
    const forceUpdate = useForceUpdate();

    const scl = searchControl.current?.searchControlLoaded ?? undefined;
    const colIndex = scl?.props.findOptions.columnOptions.findIndex(a => a.token != null && a.token.fullKey() == "systemValidFrom");

    // Signum's renderCheckBox: a RADIO per row. A plain click selects this version AND the one below it
    // (the natural "what changed here?"); ctrl-click toggles a second version to compare against.
    function renderCheckBox(sc: SearchControlLoaded, row: ResultRow, rowIndex: number): React.ReactElement {
        const checked = Boolean(sc.state.selectedRows?.includes(row));
        return (
            <input type="radio" className={classes("form-check-input",
                checked && sc.state.selectedRows!.maxBy(a => a.columns[colIndex!])! != row && "bg-secondary border-secondary")}
                checked={checked} onChange={() => { }} onClick={e => {
                    if (e.ctrlKey) {
                        if (checked) {
                            sc.state.selectedRows?.remove(row);
                            sc.notifySelectedRowsChanged("toggle");
                        } else {
                            if (sc.state.selectedRows && sc.state.selectedRows.length >= 2)
                                return void MessageModal.showError(TimeMachineMessage.YouCanNotSelectMoreThanTwoVersionToCompare.niceToString());
                            sc.state.selectedRows?.push(row);
                            sc.notifySelectedRowsChanged("toggle");
                        }
                    } else {
                        sc.state.selectedRows?.clear();
                        const rows = sc.state.resultTable!.rows;
                        if (rowIndex + 1 < rows.length)
                            sc.state.selectedRows?.push(rows[rowIndex + 1]);
                        sc.state.selectedRows?.push(row);
                        sc.notifySelectedRowsChanged("toggle");
                    }
                }}
            />
        );
    }

    // The `previousOperationLog` extension token core registers on every @systemVersioned type
    // (OperationLogic.registerPreviousLog): who ran which operation to produce this version.
    //
    // ROOTLESS and camelCase, where Signum writes `Entity.PreviousOperationLog`: an altea extension
    // token's key is derived from its quoted lambda's tail member, and altea's query tokens are rootless
    // (see CLAUDE.md — the same accommodation the workflow Inbox and the omnibox make).
    const prevLogToken = new QueryTokenString<OperationLogEntity>("previousOperationLog");

    return (
        <div>
            {!p.isModal && <h1 className="h4">
                <span className="display-5">{TimeMachineMessage.TimeMachine.niceToString()}</span>
                <br />
                <small className="sf-type-nice-name">
                    <EntityLink lite={p.lite}>
                        {`${p.lite.entityType.niceName()} ${p.lite.id}`}
                    </EntityLink>
                    &nbsp;<span style={{ color: "#aaa" }}>{p.lite.toString()}</span>
                </small>
                <br />
            </h1>}

            <h2 className="h5">{TimeMachineMessage.AllVersions.niceToString()}</h2>
            <SearchControl ref={searchControl} findOptions={{
                queryName: p.lite.entityType,
                // Signum filters by its `Entity` root token; altea has none (its tokens are rootless — see
                // CLAUDE.md), so the row is addressed by its id, which under `systemTime: All` is exactly
                // "every version of this row".
                filterOptions: [{ token: "id", operation: "EqualTo", value: p.lite.id }],
                columnOptions: [
                    { token: prevLogToken.append(a => a.start) },
                    { token: prevLogToken.append(a => a.user) },
                    { token: prevLogToken.append(a => a.operation) },
                    { token: QueryTokenString.entity().systemValidFrom() },
                    { token: QueryTokenString.entity().systemValidTo() },
                ],
                columnOptionsMode: "ReplaceAll",
                orderOptions: [{ token: QueryTokenString.entity().systemValidFrom(), orderType: "Descending" }],
                systemTime: { mode: "All", joinMode: "FirstCompatible" },
                pagination: { mode: "All" },
            }}
                onSelectionChanged={() => forceUpdate()}
                view={false}
                showSelectedButton={false}
                showContextMenu={() => "Basic"}
                allowSelection="single"
                selectionFromatter={renderCheckBox}
                searchOnLoad={true}
                create={false}
            />

            <br />

            {scl?.state.selectedRows &&
                <TimeMachineTabs
                    lite={p.lite}
                    versionDatesUTC={scl.state.selectedRows.map(sr => String(sr.columns[colIndex!]))}
                />}
        </div>
    );
}

interface VersionPairProps {
    previous?: () => Promise<TimeMachineClient.EntityDump>;
    current: () => Promise<TimeMachineClient.EntityDump>;
}

function useVersionPair(p: VersionPairProps): { curr: TimeMachineClient.EntityDump; prev: TimeMachineClient.EntityDump | null } | undefined {
    return useAPI(async () => {
        const curr = p.current();
        const prev = p.previous == null ? Promise.resolve(null) : p.previous();
        return { curr: await curr, prev: await prev };
    }, [p.current, p.previous], { avoidReset: true });
}

/** The "UI differences" tab: the entity's own view, with the older version on `ctx.previousVersion`. */
export function RenderEntityVersion(p: VersionPairProps & { currentDate?: string; previousDate?: string }): React.JSX.Element {
    const pair = useVersionPair(p);

    if (pair === undefined)
        return <h1 className="h3">{JavascriptMessage.loading.niceToString()}</h1>;

    const ctx = TypeContext.root(pair.curr.entity, { readOnly: true });

    if (pair.prev)
        ctx.previousVersion = { value: pair.prev.entity };

    return (
        <div>
            <RenderEntity ctx={ctx} currentDate={p.currentDate} previousDate={p.previousDate} />
        </div>
    );
}

/** The "Data differences" tab: the two ObjectDumper texts through altea-diff-log's DiffDocument. */
export function DiffEntityVersion(p: VersionPairProps): React.JSX.Element {
    const pair = useVersionPair(p);

    if (pair === undefined)
        return <h1 className="h3">{JavascriptMessage.loading.niceToString()}</h1>;

    if (pair.prev == null)
        return <pre>{pair.curr.dump}</pre>;

    return <DiffDocument first={pair.prev.dump} second={pair.curr.dump} />;
}

export function TimeMachineTabs(p: { lite: Lite<Entity>; versionDatesUTC: string[] }): React.JSX.Element | null {

    // One memoised fetcher per version date, kept across renders so switching tabs does not re-fetch.
    const refs = React.useRef<{ [versionDateUTC: string]: () => Promise<TimeMachineClient.EntityDump> }>({});

    if (p.versionDatesUTC == null || p.versionDatesUTC.length < 1)
        return null;

    function memoized(dateUtc: string): () => Promise<TimeMachineClient.EntityDump> {
        let memo: Promise<TimeMachineClient.EntityDump>;
        return () => (memo ??= TimeMachineClient.API.getEntityDump(p.lite, dateUtc));
    }

    refs.current = p.versionDatesUTC.toObject(a => a, a => refs.current[a] ?? memoized(a));
    const dates = p.versionDatesUTC.orderBy(a => a);
    const hasPrevious = p.versionDatesUTC.length > 1;
    const current = hasPrevious ? refs.current[dates[1]] : refs.current[dates[0]];
    const previous = hasPrevious ? refs.current[dates[0]] : undefined;

    return (
        <Tabs id="timeMachineTabs">
            <Tab key="ui" eventKey="ui" title={
                <span>
                    {hasPrevious ? TimeMachineMessage.UIDifferences.niceToString() : TimeMachineMessage.UISnapshot.niceToString()}
                    <span className="ms-2">
                        <FontAwesomeIcon aria-hidden={true} icon="eye" color="lightblue" />
                        {hasPrevious && <FontAwesomeIcon aria-hidden={true} icon="circle" transform="shrink-10 left-25 up-5" color="red" />}
                    </span>
                </span>}>
                <RenderEntityVersion
                    previous={previous}
                    current={current}
                    currentDate={hasPrevious ? dates[1] : dates[0]}
                    previousDate={hasPrevious ? dates[0] : undefined}
                />
            </Tab>
            <Tab key="data" eventKey="data" title={hasPrevious
                ? <span>{TimeMachineMessage.DataDifferences.niceToString()}
                    <FontAwesomeIcon aria-hidden={true} icon="plus" color="green" transform="up-5 right-7" />
                    <FontAwesomeIcon aria-hidden={true} icon="minus" color="red" transform="down-5 left-7" />
                </span>
                : <span>{TimeMachineMessage.DataSnapshot.niceToString()}
                    <FontAwesomeIcon aria-hidden={true} className="ms-2" icon="align-left" color="lightblue" />
                </span>}>
                <DiffEntityVersion previous={previous} current={current} />
            </Tab>
        </Tabs>
    );
}

interface TimeMachineModalProps extends IModalProps<boolean | undefined> {
    lite: Lite<Entity>;
}

export function TimeMachineModal(p: TimeMachineModalProps): React.JSX.Element {
    const [show, setShow] = React.useState(true);

    return (
        <Modal onHide={() => setShow(false)} show={show} className="message-modal" onExited={() => p.onExited!(undefined)} size="xl">
            <div className="modal-header">
                <h1 className="h4">
                    <span className="display-5">{TimeMachineMessage.TimeMachine.niceToString()}</span>
                    <br />
                    <small className="sf-type-nice-name">
                        <span style={{ color: "#aaa" }}>{p.lite.toString()}</span>
                    </small>
                </h1>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setShow(false)} />
            </div>
            <div className="modal-body">
                <TimeMachine lite={p.lite} isModal={true} />
            </div>
        </Modal>
    );
}

export namespace TimeMachineModal {
    export function show(lite: Lite<Entity>): Promise<boolean | undefined> {
        return openModal<boolean | undefined>(<TimeMachineModal lite={lite} />);
    }
}

interface TimeMachineCompareModalProps extends IModalProps<boolean | undefined> {
    lite: Lite<Entity>;
    versionDatesUTC: string[];
}

export function TimeMachineCompareModal(p: TimeMachineCompareModalProps): React.JSX.Element {
    const [show, setShow] = React.useState(true);

    return (
        <Modal onHide={() => setShow(false)} show={show} className="message-modal" onExited={() => p.onExited!(undefined)} size="xl">
            <div className="modal-header">
                <h1 className="modal-title h5">{TimeMachineMessage.CompareVersions.niceToString()}</h1>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setShow(false)} />
            </div>
            <div className="modal-body">
                <TimeMachineTabs lite={p.lite} versionDatesUTC={p.versionDatesUTC} />
            </div>
        </Modal>
    );
}

export namespace TimeMachineCompareModal {
    export function show(lite: Lite<Entity>, versionDatesUTC: string[]): Promise<boolean | undefined> {
        return openModal<boolean | undefined>(<TimeMachineCompareModal lite={lite} versionDatesUTC={versionDatesUTC} />);
    }
}
