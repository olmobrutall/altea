import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useAPI } from "@altea/altea/client/Hooks";
import { useTitle } from "@altea/altea/client/AppContext";
import SearchValueLine from "@altea/altea/client/SearchControl/SearchValueLine";
import { TypeContext, StyleContext } from "@altea/altea/client/TypeContext";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { DynamicClient } from "./DynamicClient";
import { DynamicTypeEntity } from "../data/DynamicType";
import { DynamicMixinConnectionEntity } from "../data/DynamicMixinConnection";
import { DynamicExpressionEntity } from "../data/DynamicExpression";
import { DynamicValidationEntity } from "../data/DynamicValidation";
import { DynamicTypeConditionEntity } from "../data/DynamicTypeCondition";
import { DynamicApiEntity } from "../data/DynamicApi";
import { DynamicViewEntity } from "../data/DynamicView";
import { DynamicCSSOverrideEntity } from "../data/DynamicCSSOverride";
import { DynamicSqlMigrationEntity } from "../data/DynamicSqlMigration";

// Port of Signum.Dynamic's DynamicPanelCodeGenPage.tsx — the admin page for everything defined from inside
// the running application: what compiled, what did not and why, and a count of each kind of definition.
//
// altea divergences:
//  - **the compilation STATUS is what the page is for**, and it reports files rather than assemblies:
//    Signum shows `CodeGenAssembly.dll` / `CodeGenControllerAssembly.dll` with timestamps, because it
//    compiles to assemblies and loads them; altea generates and loads MODULES, so what is worth seeing is
//    which files were written and which diagnostic stopped the load.
//  - **there is no RESTART button.** Signum's restarts the ASP.NET host in place (`IHostApplicationLifetime
//    .StopApplication` behind a supervisor that brings it back); Node has no such convention, and a button
//    that killed the process without something to restart it would be a trap. The permission
//    (`DynamicPanelPermission.RestartApplication`) is ported and the page says plainly that a restart is
//    needed — how to perform one belongs to the deployment.
//  - Signum's tabs for compiling / checking evals are folded into the single status block: with modules
//    rather than assemblies there is one compile, and it already happened at startup.
export default function DynamicPanelPage(): React.JSX.Element {
    useTitle("Dynamic panel");

    const status = useAPI(() => DynamicClient.API.compilationStatus(), []);
    const ctx = React.useMemo(() => new StyleContext(undefined, { formGroupStyle: "Basic" }), []);

    return (
        <div>
            <h2 className="display-6 h3">Dynamic panel</h2>

            {status == null ? <p>{JavascriptMessage.loading.niceToString()}</p> :
                <div className="mb-4">
                    {status.codeGenDirectory == null ?
                        <div className="alert alert-secondary">
                            This application has not configured the compiled half — no dynamic types are
                            generated. (An app opts in by calling
                            <code className="mx-1">DynamicCodeCompiler.configure</code>
                            from its Starter.)
                        </div> :
                        status.error != null ?
                            <div className="alert alert-danger">
                                <h5>
                                    <FontAwesomeIcon aria-hidden={true} icon="triangle-exclamation" />{" "}
                                    The server is running WITHOUT its dynamic types
                                </h5>
                                <pre className="mb-2" style={{ whiteSpace: "pre-wrap" }}>{status.error}</pre>
                                <small>
                                    Fix the definition and restart. Until then a schema synchronization
                                    would script the missing types as DROPs — check any generated script.
                                </small>
                            </div> :
                            <div className="alert alert-success">
                                <FontAwesomeIcon aria-hidden={true} icon="check" />{" "}
                                Dynamic code compiled and loaded.
                                {" "}<small>A change takes effect after a restart, and a new table after a
                                schema synchronization.</small>
                            </div>}

                    {status.written.length > 0 &&
                        <details className="mt-2">
                            <summary>
                                {status.written.length} generated file(s)
                                <small className="text-muted ms-2">{status.codeGenDirectory}</small>
                            </summary>
                            <ul className="mt-2">
                                {status.written.map(f => <li key={f}><code>{f}</code></li>)}
                            </ul>
                        </details>}
                </div>}

            <div className="row">
                <div className="col-sm-6">
                    <h5>Compiled</h5>
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicTypeEntity }} />
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicExpressionEntity }} />
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicTypeConditionEntity }} />
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicMixinConnectionEntity }} />
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicApiEntity }} />
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicValidationEntity }} />
                </div>
                <div className="col-sm-6">
                    <h5>Interpreted</h5>
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicViewEntity }} />
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicCSSOverrideEntity }} />
                    <SearchValueLine ctx={ctx} findOptions={{ queryName: DynamicSqlMigrationEntity }} />
                </div>
            </div>
        </div>
    );
}
