import "@altea/altea/data/globals/arrayExtensions";
import "@altea/altea/data/globals/stringExtensions";
import * as React from "react";
import { Link } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Navigator } from "@altea/altea/client/Navigator";
import { useAPI } from "@altea/altea/client/Hooks";
import { useTitle } from "@altea/altea/client/AppContext";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import { AppendixHelpEntity, HelpMessage } from "../../data/Help";
import { HelpClient } from "../HelpClient";

// Port of Signum.Help's Pages/HelpIndexPage.tsx — the help home: the appendices, then every module with
// its packages and their types.
//
// altea divergences: the grouping key is the PACKAGE (`module`) rather than a C# assembly prefix, and the
// per-namespace sub-label shows the namespace's own tail rather than Signum's `namespace.after(".")`
// arithmetic (an altea namespace is a path, so its module prefix is stripped instead).
export default function HelpIndexPage(): React.JSX.Element {

    useTitle(HelpMessage.Help.niceToString());

    const index = useAPI(() => HelpClient.API.index(), []);

    return (
        <div className="container">
            <h1 className="display-5">
                {HelpMessage.Help.niceToString()}
                {index && <small className="ms-5 text-muted display-7">({index.culture.englishName})</small>}
            </h1>

            {index && <div>
                <div className="my-4 ms-4">
                    <h2 className="display-6">
                        {HelpMessage.Appendices.niceToString()}
                        {Navigator.isCreable(AppendixHelpEntity, { customComponent: true, isSearch: true }) &&
                            <Link to={HelpClient.Urls.appendixUrl(null)} style={{ fontSize: "20px" }}>
                                <FontAwesomeIcon icon="plus" className="ms-2" title={HelpMessage.Appendices.niceToString()} />
                            </Link>}
                    </h2>
                    <ul className="responsive-columns">
                        {index.appendices.map(ap =>
                            <li key={ap.uniqueName}>
                                <h4 className="display-7">
                                    <Link to={HelpClient.Urls.appendixUrl(ap.uniqueName)} className="fw-bold">{ap.title}</Link>
                                </h4>
                            </li>)}
                    </ul>
                </div>

                {index.namespaces.groupBy(a => a.module ?? "—").orderBy(gr => gr.key).map(gr =>
                    <div key={gr.key} className="my-4 ms-4">
                        <h2 className="display-6">{gr.key}</h2>
                        <ul className="responsive-columns">
                            {gr.elements.orderBy(a => a.namespace).map(nh => {
                                // The namespace tail below its module: "@altea/altea-auth/data" → "data".
                                const tail = nh.module != undefined && nh.namespace.startsWith(nh.module)
                                    ? nh.namespace.substring(nh.module.length).replace(/^\//, "")
                                    : undefined;

                                return (
                                    <li className="mb-4" key={nh.namespace}>
                                        <h3 className="display-7 h4">
                                            <Link to={HelpClient.Urls.namespaceUrl(nh.namespace)} className={nh.hasEntity ? "fw-bold" : undefined}>
                                                {nh.title}
                                            </Link>
                                            {tail && <small> {HelpMessage.In0.niceToString(tail)}</small>}
                                        </h3>
                                        <ul>
                                            {nh.allowedTypes.map(ei =>
                                                <li key={ei.cleanName}>
                                                    <Link to={HelpClient.Urls.typeUrl(ei.cleanName)} className={ei.hasEntity ? "fw-bold" : undefined}>
                                                        {tryGetTypeInfo(ei.cleanName)?.getNiceName() ?? ei.cleanName}
                                                    </Link>
                                                </li>)}
                                        </ul>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>)}
            </div>}
        </div>
    );
}
