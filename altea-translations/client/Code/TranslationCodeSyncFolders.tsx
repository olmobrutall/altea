import * as React from "react";
import { Link, useParams } from "react-router";
import { AccessibleTable } from "@altea/altea/client/Basics/AccessibleTable";
import { useAPI } from "@altea/altea/client/Hooks";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { TranslationMessage } from "../../data/Translation";
import { TranslationClient, encodePackage, decodePackage } from "../TranslationClient";
import "../Translation.css";

// Port of Signum.Translation's Code/TranslationCodeSyncNamespaces.tsx — "how much is left, and where?".
//
// altea divergence: the grouping level is the declaring FOLDER, not a C# namespace (see
// server/LocalizedPackage) — hence the file's name.
export default function TranslationCodeSyncFolders(): React.JSX.Element {
    const params = useParams() as { culture: string; package: string };
    const packageName = decodePackage(params.package);
    const culture = params.culture;

    const result = useAPI(() => TranslationClient.API.folderStatus(packageName, culture), [packageName, culture]);

    if (result?.length === 0)
        return (
            <div>
                <h1 className="h2">{TranslationMessage._0AlreadySynchronized.niceToString(packageName)}</h1>
                <Link to="/translation/status">{TranslationMessage.BackToTranslationStatus.niceToString()}</Link>
            </div>
        );

    return (
        <div>
            <h1 className="h2">
                <Link to="/translation/status">{TranslationMessage.CodeTranslations.niceToString()}</Link>
                {" > "}
                {TranslationMessage.Synchronize0In1.niceToString(packageName, culture)}
            </h1>
            {result == undefined
                ? <strong>{JavascriptMessage.loading.niceToString()}</strong>
                : (
                    <AccessibleTable
                        aria-label={`${TranslationMessage.Folder.niceToString()} / ${TranslationMessage.NewTranslations.niceToString()}`}
                        className="st table">
                        <thead>
                            <tr>
                                <th>{TranslationMessage.Folder.niceToString()}</th>
                                <th>{TranslationMessage.NewTypes.niceToString()}</th>
                                <th>{TranslationMessage.NewTranslations.niceToString()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr key="All">
                                <th>
                                    <Link to={`/translation/sync/${encodePackage(packageName)}/${culture}`}>
                                        {TranslationMessage.All.niceToString()}
                                    </Link>
                                </th>
                                <th>{result.sum(a => a.types)}</th>
                                <th>{result.sum(a => a.translations)}</th>
                            </tr>
                            {result.map(stats =>
                                <tr key={stats.folder}>
                                    <td>
                                        <Link to={`/translation/sync/${encodePackage(packageName)}/${culture}/${encodeURIComponent(stats.folder)}`}>
                                            {stats.folder === "" ? "/" : stats.folder}
                                        </Link>
                                    </td>
                                    <th>{stats.types}</th>
                                    <th>{stats.translations}</th>
                                </tr>)}
                        </tbody>
                    </AccessibleTable>
                )}
        </div>
    );
}
