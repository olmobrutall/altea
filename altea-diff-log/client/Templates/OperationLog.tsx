import * as React from "react";
import { Tabs, Tab } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Link } from "react-router";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { Navigator } from "@altea/altea/client/Navigator";
import { useAPI } from "@altea/altea/client/Hooks";
import { toAbsoluteUrl } from "@altea/altea/client/AppContext";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { OperationLogEntity } from "@altea/altea/data/operationLog";
import { DiffLogMessage, DiffLogMixin } from "../../data/DiffLog";
import { DiffLogClient } from "../DiffLogClient";
import { DiffDocument } from "./DiffDocument";
import "./DiffLog.css";

// Port of Signum.DiffLog's Templates/OperationLog.tsx — the operation log's view: the log's own fields, then
// a tab strip that walks the target's history. The strip is the point: previous log → the diff into this
// log's initial state → the initial state → the diff to the final state → the final state → the diff into
// the next log → the next log (or the entity as it stands now).
//
// altea divergences, documented inline:
//  - `getMixin(log, DiffLogMixin)` → `log.mixin(DiffLogMixin)` (altea inlines mixin fields onto the owner,
//    so this is a typed cast that also asserts the mixin is declared).
//  - `ctx.subCtx(DiffLogMixin)` is gone: altea dropped `subCtx`'s mixin overload (it defeated contextual
//    typing for lambdas), so the mixin step is written INSIDE the lambda — `subCtx(a => a.mixin(DiffLogMixin))`,
//    the same shape altea-email's reception tab uses. The mixin step is not optional even though the FIELDS
//    are inlined: a PropertyRoute still models the mixin, so a route built straight off the owner
//    ("initialState" on OperationLogEntity) does not resolve — which is where the tab labels come from.
//  - `LinkContainer` (react-router-bootstrap) → a react-router `<Link>` inside the tab title, which is what
//    LinkContainer produces.
//  - Signum's `simplify` checkbox and its `simplifyDump` regex are kept verbatim — the regex matches the
//    dump format, which altea's ObjectDumper preserves on purpose (see its header).
export default function OperationLog(p: { ctx: TypeContext<OperationLogEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    const ctx6 = ctx.subCtx({ labelColumns: { sm: 3 } });

    return (
        <div>
            <div className="row">
                <div className="col-sm-6">
                    <EntityLine ctx={ctx6.subCtx(f => f.target)} />
                    <EntityLine ctx={ctx6.subCtx(f => f.operation)} />
                    <EntityLine ctx={ctx6.subCtx(f => f.origin)} />
                    <EntityLine ctx={ctx6.subCtx(f => f.user)} />
                </div>
                <div className="col-sm-6">
                    <AutoLine ctx={ctx6.subCtx(f => f.start)} />
                    <AutoLine ctx={ctx6.subCtx(f => f.end)} />
                    <EntityLine ctx={ctx6.subCtx(f => f.exception)} />
                </div>
            </div>
            <div className="code-container">
                <DiffMixinTabs ctx={ctx} />
            </div>
        </div>
    );
}

export function DiffMixinTabs(p: { ctx: TypeContext<OperationLogEntity> }): React.JSX.Element {

    const [simplify, setSimplify] = React.useState(true);

    const log = p.ctx.value;
    const mixin = log.mixin(DiffLogMixin);
    const mctx = p.ctx.subCtx(a => a.mixin(DiffLogMixin));

    const prev = useAPI(() => mixin.initialState.text == null
        ? Promise.resolve(null)
        : DiffLogClient.API.getPreviousOperationLog(log.id!), [log.id]);

    const next = useAPI(() => mixin.finalState.text == null
        ? Promise.resolve(null)
        : DiffLogClient.API.getNextOperationLog(log.id!), [log.id]);

    /** Signum's renderPrev / renderNext: the tab title IS the link, and clicking it reloads the frame. */
    function logLinkTitle(lite: Lite<OperationLogEntity>, label: string, icon: "circle-arrow-left" | "circle-arrow-right",
        titleText: string): React.ReactElement {
        return (
            <Link to={Navigator.navigateRoute(lite)} title={titleText}
                onClick={e => {
                    if (!(e.ctrlKey || e.button === 1)) {
                        e.preventDefault();
                        void Navigator.API.fetchEntityPack(lite).then(ep => p.ctx.frame!.onReload(ep));
                    }
                }}>
                {icon === "circle-arrow-left"
                    ? <><FontAwesomeIcon aria-hidden icon={icon} />&nbsp;{label}</>
                    : <>{label}&nbsp;<FontAwesomeIcon aria-hidden icon={icon} /></>}
            </Link>
        );
    }

    /** Signum's two-arrow diff title; `mini` fades it when the two sides are equal. */
    function diffTitle(left: "backward-fast" | "backward-step" | "forward-step",
        right: "backward-step" | "forward-step" | "forward-fast",
        equal: boolean, titleText: string, disabled = false): React.ReactElement {
        const cls = (color: string): string => `colorIcon ${disabled ? "gray" : color} ${!disabled && equal ? "mini" : ""}`;
        return (
            <span title={titleText}>
                <FontAwesomeIcon aria-hidden icon={left} className={cls("red")} />
                <FontAwesomeIcon aria-hidden icon={right} className={cls("green")} />
            </span>
        );
    }

    const target = log.target;

    const prevSimple = React.useMemo(() => simplifyDump(prev?.dump, simplify), [prev, simplify]);
    const initialSimple = React.useMemo(() => simplifyDump(mixin.initialState.text, simplify), [mixin.initialState.text, simplify]);
    const finalSimple = React.useMemo(() => simplifyDump(mixin.finalState.text, simplify), [mixin.finalState.text, simplify]);
    const nextSimple = React.useMemo(() => simplifyDump(next?.dump, simplify), [next, simplify]);

    return (
        <div>
            <label>
                <input type="checkbox" className="form-check-input" checked={simplify}
                    onChange={e => setSimplify(e.currentTarget.checked)} />
                <span className="mx-2">{DiffLogMessage.SimplifyChanges.niceToString()}</span>
            </label>
            <Tabs id="diffTabs" defaultActiveKey="diff" key={String(log.id)} mountOnEnter>
                {prev
                    ? <Tab eventKey="prev" className="linkTab" disabled={false}
                        title={logLinkTitle(prev.operationLog, DiffLogMessage.PreviousLog.niceToString(),
                            "circle-arrow-left", DiffLogMessage.NavigatesToThePreviousOperationLog.niceToString()) as any} />
                    : <Tab eventKey="prev" disabled title={
                        <span title={DiffLogMessage.NavigatesToThePreviousOperationLog.niceToString()}>
                            <FontAwesomeIcon aria-hidden icon="circle-arrow-left" />
                            &nbsp;{DiffLogMessage.PreviousLog.niceToString()}
                        </span> as any} />}

                {prevSimple && initialSimple
                    ? <Tab eventKey="prevDiff" title={diffTitle("backward-fast", "backward-step",
                        prevSimple === initialSimple,
                        DiffLogMessage.DifferenceBetweenFinalStateOfPreviousLogAndTheInitialState.niceToString()) as any}>
                        <DiffDocument first={prevSimple} second={initialSimple} />
                    </Tab>
                    : <Tab eventKey="prevDiff" disabled title={diffTitle("backward-fast", "backward-step", false,
                        DiffLogMessage.DifferenceBetweenFinalStateOfPreviousLogAndTheInitialState.niceToString(), true) as any} />}

                {initialSimple &&
                    <Tab eventKey="initialState" title={mctx.niceName(d => d.initialState)}>
                        <pre><code>{initialSimple}</code></pre>
                    </Tab>}

                {initialSimple && finalSimple &&
                    <Tab eventKey="diff" title={diffTitle("backward-step", "forward-step",
                        initialSimple === finalSimple,
                        DiffLogMessage.DifferenceBetweenInitialStateAndFinalState.niceToString()) as any}>
                        <DiffDocument first={initialSimple} second={finalSimple} />
                    </Tab>}

                {finalSimple &&
                    <Tab eventKey="finalState" title={mctx.niceName(d => d.finalState)}>
                        <pre><code>{finalSimple}</code></pre>
                    </Tab>}

                {finalSimple && nextSimple &&
                    <Tab eventKey="nextDiff" title={diffTitle("forward-step", "forward-fast",
                        finalSimple === nextSimple,
                        DiffLogMessage.DifferenceBetweenFinalStateAndTheInitialStateOfNextLog.niceToString()) as any}>
                        <DiffDocument first={finalSimple} second={nextSimple} />
                    </Tab>}

                {next === undefined ? undefined
                    : next?.operationLog
                        ? <Tab eventKey="next" className="linkTab"
                            title={logLinkTitle(next.operationLog, DiffLogMessage.NextLog.niceToString(),
                                "circle-arrow-right", DiffLogMessage.NavigatesToTheNextOperationLog.niceToString()) as any} />
                        : target
                            ? <Tab eventKey="next" className="linkTab" title={
                                <a href={toAbsoluteUrl(Navigator.navigateRoute(target as Lite<Entity>))}
                                    target="_blank" rel="noreferrer"
                                    title={DiffLogMessage.NavigatesToTheCurrentEntity.niceToString()}>
                                    {DiffLogMessage.CurrentEntity.niceToString()}
                                    &nbsp;<FontAwesomeIcon aria-hidden icon="up-right-from-square" />
                                </a> as any} />
                            : undefined}
            </Tabs>
        </div>
    );
}

/**
 * Signum's `simplifyDump` — collapse an EXPANDED lite (`x = new LiteImp<T>(…) { Entity = new T(…) { … } }`)
 * down to `{ Entity = /* Loaded *\/ }`, so a diff shows the change and not the whole loaded graph.
 *
 * The regex is unchanged from Signum because altea's ObjectDumper keeps the same output format on purpose
 * (see its header) — the `new LiteImp<` marker and the brace/indent shape are the contract.
 */
const liteImpRegex = /^(?<space> *)(?<prop>\w[\w\d_]+) = new LiteImp</;

export function simplifyDump(text: string | null | undefined, simplifyFatLites: boolean): string | null {

    if (text == null)
        return null;

    const lines = text.replace(/\r/g, "").split("\n");

    if (!simplifyFatLites)
        return lines.join("\n");

    for (let i = 0; i < lines.length; i++) {
        const current = lines[i]!;
        if (current.includes("= new LiteImp<") && !current.endsWith(",")) {
            const match = liteImpRegex.exec(current);
            if (match) {
                const spaces = match.groups!["space"]!;
                if (lines[i + 1] === spaces + "{") {
                    const lastIndex = lines.indexOf(spaces + "},", i + 1);
                    if (lastIndex !== -1)
                        lines.splice(i + 1, lastIndex - (i + 1) + 1);

                    lines[i] = current + " { Entity = /* Loaded */ },";
                }
            }
        }
    }

    return lines.join("\n");
}
