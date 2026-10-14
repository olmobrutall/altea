import * as React from "react";
import { useLocation } from "react-router";
import { Tab, Tabs } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import * as AppContext from "@altea/altea/client/AppContext";
import { useTitle } from "@altea/altea/client/AppContext";
import { useAPIWithReload, useInterval } from "@altea/altea/client/Hooks";
import SearchValueLine from "@altea/altea/client/SearchControl/SearchValueLine";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import EntityLink from "@altea/altea/client/SearchControl/EntityLink";
import { StyleContext } from "@altea/altea/client/TypeContext";
import { classes } from "@altea/altea/data/globals/helpers";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import type { FilterConditionOption } from "@altea/altea/data/dynamicQuery/queryOptions";
import TypeScriptMonaco from "@altea/altea-monaco/client/TypeScriptMonaco";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { EvalClient } from "@altea/altea-eval/client/EvalClient";
import { EvalPanelPermission } from "@altea/altea-eval/data/EvalPanelPermission";
import type { EvalEntityError } from "@altea/altea-eval/data/EvalDtos";
import { DynamicClient } from "./DynamicClient";
import {
    DynamicPanelMessage, DynamicPanelPermission,
    type DynamicCompilationStatus, type DynamicCompileResult,
} from "../data/DynamicPanel";
import { DynamicTypeEntity } from "../data/DynamicType";
import { DynamicMixinConnectionEntity } from "../data/DynamicMixinConnection";
import { DynamicExpressionEntity } from "../data/DynamicExpression";
import { DynamicValidationEntity } from "../data/DynamicValidation";
import { DynamicTypeConditionEntity } from "../data/DynamicTypeCondition";
import { DynamicApiEntity } from "../data/DynamicApi";
import { DynamicViewEntity } from "../data/DynamicView";
import { DynamicCSSOverrideEntity } from "../data/DynamicCSSOverride";
import { DynamicSqlMigrationEntity } from "../data/DynamicSqlMigration";

// Port of Signum.Dynamic's DynamicPanelCodeGenPage.tsx (+ Signum.Eval's SearchPanel / CheckEvalsStep): the
// steps an author walks after editing a definition — compile, restart, migrate, check evals, refresh.
//
// altea divergences:
//  - "is a restart needed" is the list of generated FILES that differ from what this process loaded
//    (DynamicLogic.pendingChanges), where Signum compares four timestamps.
//  - Compile never writes nor loads: it is Signum's in-memory "Check". The real compile is the restart.
//  - Restart exists only when the APP said how its host comes back (DynamicLogic.restartApplication).

type DynamicPanelStep = "search" | "compile" | "restart" | "migrations" | "checkEvals" | "refreshClients";

export default function DynamicPanelPage(): React.JSX.Element {
    useTitle(DynamicPanelMessage.DynamicPanel.niceToString());
    AuthClient.assertPermissionAuthorized(EvalPanelPermission.ViewDynamicPanel);

    const location = useLocation();
    const step = (new URLSearchParams(location.search).get("step") ?? "compile") as DynamicPanelStep;

    const [status, reloadStatus] = useAPIWithReload(() => DynamicClient.API.compilationStatus(), []);

    return (
        <div>
            <h2 className="text-display-6 font-light">{DynamicPanelMessage.DynamicPanel.niceToString()}</h2>

            {status == null ? <p>{JavascriptMessage.loading.niceToString()}</p> : <StatusAlert status={status} />}

            <Tabs activeKey={step} id="dynamicPanelTabs" className="mt-4" mountOnEnter
                onSelect={k => AppContext.navigate("/dynamic/panel?step=" + k, { replace: true })}>
                <Tab eventKey="search" title={DynamicPanelMessage.Search.niceToString()}>
                    <SearchStep />
                </Tab>
                <Tab eventKey="compile" title={DynamicPanelMessage.EditAndCompile.niceToString()}>
                    {status && <CompileStep status={status} />}
                </Tab>
                <Tab eventKey="restart" title={DynamicPanelMessage.RestartServer.niceToString()}>
                    {status && <RestartStep status={status} onRestarted={reloadStatus} />}
                </Tab>
                <Tab eventKey="migrations" title={DynamicPanelMessage.SqlMigrations.niceToString()}>
                    <MigrationsStep />
                </Tab>
                <Tab eventKey="checkEvals" title={DynamicPanelMessage.CheckEvals.niceToString()}>
                    <CheckEvalsStep />
                </Tab>
                <Tab eventKey="refreshClients" title={DynamicPanelMessage.RefreshClients.niceToString()}>
                    <p className="mt-4">{DynamicPanelMessage.YouNeedToRefreshManually.niceToString()}</p>
                    <button type="button" className="btn btn-warning" onClick={() => window.location.reload()}>
                        {DynamicPanelMessage.RefreshThisClient.niceToString()}
                    </button>
                </Tab>
            </Tabs>
        </div>
    );
}

function StatusAlert(p: { status: DynamicCompilationStatus }): React.JSX.Element {
    return (
        <>
            {p.status.databaseMismatches.length > 0 &&
                <div className="alert alert-warning">
                    <h5>
                        <FontAwesomeIcon aria-hidden={true} icon="database" />{" "}
                        {DynamicPanelMessage.TheDatabaseDoesNotMatchTheCode.niceToString()}
                    </h5>
                    <pre className="mb-2" style={{ whiteSpace: "pre-wrap" }}>{p.status.databaseMismatches.join("\n\n")}</pre>
                    <small>{DynamicPanelMessage.GenerateASqlMigrationAndExecuteIt.niceToString()}</small>
                </div>}
            <CompilationAlert status={p.status} />
        </>
    );
}

function CompilationAlert(p: { status: DynamicCompilationStatus }): React.JSX.Element {
    const s = p.status;

    if (s.codeGenDirectory == null)
        return <div className="alert alert-secondary">{DynamicPanelMessage.NotConfigured.niceToString()}</div>;

    if (s.error != null)
        return (
            <div className="alert alert-danger">
                <h5>
                    <FontAwesomeIcon aria-hidden={true} icon="triangle-exclamation" />{" "}
                    {DynamicPanelMessage.TheServerIsRunningWithoutItsDynamicTypes.niceToString()}
                </h5>
                <pre className="mb-2" style={{ whiteSpace: "pre-wrap" }}>{s.error}</pre>
                <small>{DynamicPanelMessage.FixTheDefinitionAndRestart.niceToString()}</small>
            </div>
        );

    return (
        <div className={classes("alert", s.pending.length > 0 ? "alert-warning" : "alert-success")}>
            <FontAwesomeIcon aria-hidden={true} icon={s.pending.length > 0 ? "triangle-exclamation" : "check"} />{" "}
            {DynamicPanelMessage.DynamicCodeCompiledAndLoaded.niceToString()}{" "}
            {s.pending.length === 0 ? DynamicPanelMessage.NoChangesSinceTheServerStarted.niceToString() :
                <>
                    {DynamicPanelMessage.ARestartIsNeededToLoadTheseChanges.niceToString()}
                    <ul className="mb-0 mt-1">
                        {s.pending.map(c => <li key={c.fileName}><code>{c.fileName}</code> <small>({c.change})</small></li>)}
                    </ul>
                </>}
        </div>
    );
}

// ---- 1. compile ------------------------------------------------------------------------------------------

function CompileStep(p: { status: DynamicCompilationStatus }): React.JSX.Element {
    const [result, setResult] = React.useState<DynamicCompileResult | undefined>();
    const [compiling, setCompiling] = React.useState(false);
    const [selected, setSelected] = React.useState<number | undefined>();
    const ctx = React.useMemo(() => new StyleContext(undefined, { formGroupStyle: "Basic" }), []);

    async function handleCompile(): Promise<void> {
        setCompiling(true);
        try {
            setSelected(undefined);
            setResult(await DynamicClient.API.compile());
        } finally {
            setCompiling(false);
        }
    }

    const error = selected == null ? undefined : result?.errors[selected];
    const file = error == null ? undefined : result?.files.find(f => f.fileName === error.fileName);

    return (
        <div className="mt-4">
            <div className="row">
                <div className="col-sm-6">
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicTypeEntity }} />
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicExpressionEntity }} />
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicTypeConditionEntity }} />
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicMixinConnectionEntity }} />
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicApiEntity }} />
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicValidationEntity }} />
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicViewEntity }} />
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicCSSOverrideEntity }} />
                </div>
                <div className="col-sm-6">
                    {p.status.written.length > 0 &&
                        <details>
                            <summary>
                                {DynamicPanelMessage._0GeneratedFiles.niceToString(p.status.written.length)}
                                <small className="text-muted-foreground ms-2">{p.status.codeGenDirectory}</small>
                            </summary>
                            <ul className="mt-2">
                                {p.status.written.map(f => <li key={f}><code>{f}</code></li>)}
                            </ul>
                        </details>}
                </div>
            </div>

            <button type="button" className="btn btn-success mt-2" disabled={compiling || p.status.codeGenDirectory == null}
                onClick={() => void handleCompile()}>
                <FontAwesomeIcon aria-hidden={true} icon={compiling ? "arrows-rotate" : "gears"} spin={compiling} />{" "}
                {DynamicPanelMessage.Compile.niceToString()}
            </button>

            {result &&
                <div className="mt-4">
                    <div className={classes("alert", result.errors.length === 0 ? "alert-success" : "alert-danger")}>
                        <strong>{DynamicPanelMessage._0Errors.niceToString(result.errors.length)}</strong>{" "}
                        {result.errors.length === 0
                            ? DynamicPanelMessage.TheDynamicCodeCompiledSuccessfully.niceToString()
                            : DynamicPanelMessage.FixTheseErrorsInTheDynamicDefinitions.niceToString()}
                    </div>

                    {result.errors.length > 0 &&
                        <table className="table table-sm table-hover">
                            <thead>
                                <tr>
                                    <th>{DynamicPanelMessage.File.niceToString()}</th>
                                    <th>{DynamicPanelMessage.Line.niceToString()}</th>
                                    <th>{DynamicPanelMessage.Error.niceToString()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {result.errors.map((e, i) =>
                                    <tr key={i} onClick={() => setSelected(i)} style={{ cursor: "pointer" }}
                                        className={classes(i === selected && "table-active")}>
                                        <td><code>{e.fileName}</code></td>
                                        <td>{e.line}</td>
                                        <td className="text-destructive">
                                            {e.message}
                                            {e.sourceLine.trim() !== "" && <pre className="mb-0 mt-1"><small>{e.sourceLine.trim()}</small></pre>}
                                        </td>
                                    </tr>)}
                            </tbody>
                        </table>}

                    {file != null && error != null &&
                        <div>
                            <h5><code>{file.fileName}</code></h5>
                            <TypeScriptMonaco key={file.fileName + ":" + error.line} code={file.content} isReadOnly
                                semanticDiagnostics={false} height="30em"
                                markers={[{ line: error.line, message: error.message }]} />
                        </div>}
                </div>}
        </div>
    );
}

// ---- 2. restart ------------------------------------------------------------------------------------------

function RestartStep(p: { status: DynamicCompilationStatus; onRestarted: () => void }): React.JSX.Element {
    const [restartingSince, setRestartingSince] = React.useState<number | undefined>();
    const seconds = useInterval(restartingSince == null ? null : 1000, 0, s => s + 1, [restartingSince]);

    async function handleRestart(): Promise<void> {
        const before = p.status.startedAt;
        await DynamicClient.API.restartServer();
        setRestartingSince(Date.now());

        // Until a DIFFERENT process answers: the old one may still be draining its last requests.
        for (; ;) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            try {
                const now = await DynamicClient.API.compilationStatus();
                if (now.startedAt !== before)
                    break;
            } catch {
                // the server is down — keep waiting
            }
        }

        setRestartingSince(undefined);
        p.onRestarted();
    }

    if (restartingSince != null)
        return (
            <div className="progress mt-4" style={{ height: "2em" }}>
                <div className="progress-bar progress-bar-striped progress-bar-animated bg-warning" style={{ width: "100%" }}>
                    {DynamicPanelMessage.Restarting0s.niceToString(seconds)}
                </div>
            </div>
        );

    return (
        <div className="mt-4">
            {p.status.canRestart ?
                AuthClient.isPermissionAuthorized(DynamicPanelPermission.RestartApplication) &&
                <button type="button" className="btn btn-danger" onClick={() => void handleRestart()}>
                    <FontAwesomeIcon aria-hidden={true} icon="power-off" />{" "}
                    {DynamicPanelMessage.RestartServerApplication.niceToString()}
                </button> :
                <div className="alert alert-secondary">{DynamicPanelMessage.RestartNotAvailable.niceToString()}</div>}

            <p className="mt-4 text-muted-foreground">{DynamicPanelMessage.AfterRestartSynchronize.niceToString()}</p>
        </div>
    );
}

// ---- 3. migrations ---------------------------------------------------------------------------------------

function MigrationsStep(): React.JSX.Element {
    return (
        <div className="mt-4">
            <h5>{DynamicSqlMigrationEntity.nicePluralName()}</h5>
            <SearchControl findOptions={{ queryName: DynamicSqlMigrationEntity }} />
        </div>
    );
}

// ---- search ------------------------------------------------------------------------------------------------

function SearchStep(): React.JSX.Element {
    const [search, setSearch] = React.useState("");
    const ctx = React.useMemo(() => new StyleContext(undefined, { labelColumns: 3 }), []);

    return (
        <div className="row mt-4">
            <div className="col-sm-6">
                <div className="input-group mb-4">
                    <span className="input-group-text"><FontAwesomeIcon aria-hidden={true} icon="magnifying-glass" /></span>
                    <input type="text" className="form-control" value={search} onChange={e => setSearch(e.currentTarget.value)} />
                </div>
                {Object.entries(DynamicClient.registeredPanelSearches).map(([typeName, columns]) =>
                    <SearchValueLine key={typeName + "|" + search} ctx={ctx} findOptions={{
                        queryName: typeName,
                        filterOptions: search === "" ? [] : [{
                            groupOperation: "Or",
                            filters: columns.map(c => ({ token: c.token, operation: "Contains", value: search }) satisfies FilterConditionOption),
                        }],
                    }} />)}
            </div>
        </div>
    );
}

// ---- 4. check evals ----------------------------------------------------------------------------------------

function CheckEvalsStep(): React.JSX.Element {
    const [state, setState] = React.useState<"initial" | "loading" | "failed" | EvalEntityError[]>("initial");

    async function handleRefresh(): Promise<void> {
        setState("loading");
        try {
            setState(await EvalClient.API.getEvalErrors());
        } catch (e) {
            setState("failed");
            throw e;
        }
    }

    return (
        <div className="mt-4">
            <button type="button" className="btn btn-success" disabled={state === "loading"} onClick={() => void handleRefresh()}>
                <FontAwesomeIcon aria-hidden={true} icon="arrows-rotate" spin={state === "loading"} />{" "}
                {DynamicPanelMessage.RefreshAll.niceToString()}
            </button>

            {Array.isArray(state) && (state.length === 0 ?
                <div className="alert alert-success mt-4">{DynamicPanelMessage.NoErrorsFound.niceToString()}</div> :
                <table className="table table-sm mt-4">
                    <tbody>
                        {state.map((e, i) =>
                            <tr key={i}>
                                <td><small className="text-muted-foreground">{e.source}</small></td>
                                <td><EntityLink lite={e.lite} /></td>
                                <td className="text-destructive"><pre className="mb-0" style={{ whiteSpace: "pre-wrap" }}>{e.error}</pre></td>
                            </tr>)}
                    </tbody>
                </table>)}
        </div>
    );
}
