import * as React from "react";
import { Link, useParams } from "react-router";
import { Operations } from "@altea/altea/client/Operations";
import { useAPIWithReload } from "@altea/altea/client/Hooks";
import { useTitle } from "@altea/altea/client/AppContext";
import { Dic } from "@altea/altea/data/globals";
import { TranslationMessage } from "../../data/Translation";
import { TranslationClient, encodePackage, decodePackage } from "../TranslationClient";
import { TranslationTypeTable } from "./TranslationTypeTable";
import "../Translation.css";

// Port of Signum.Translation's Code/TranslationCodeSync.tsx — the page you actually translate on: every
// type that is missing something in this culture, with the machine suggestions pre-filled.
export default function TranslationCodeSync(): React.JSX.Element {
    const params = useParams() as { culture: string; package: string; folder?: string };
    const packageName = decodePackage(params.package);
    const culture = params.culture;
    const folder = params.folder == undefined ? undefined : decodeURIComponent(params.folder);

    const [result, reload] = useAPIWithReload(
        () => TranslationClient.API.sync(packageName, culture, folder), [packageName, culture, folder]);

    const message = result?.totalTypes === 0
        ? TranslationMessage._0AlreadySynchronized.niceToString(folder ?? packageName)
        : TranslationMessage.Synchronize0In1.niceToString(folder ?? packageName, culture)
        + (result != undefined ? ` [${Dic.getKeys(result.types).length}/${result.totalTypes}]` : " …");

    useTitle(message);

    function handleSave(): void {
        void TranslationClient.API.save(packageName, culture, result!)
            .then(() => Operations.notifySuccess())
            .then(() => reload());
    }

    return (
        <div>
            <h1 className="h2">
                <Link to="/translation/status">{TranslationMessage.CodeTranslations.niceToString()}</Link>
                {" > "}{message}
            </h1>
            <br />
            {result != undefined && result.totalTypes > 0 &&
                <div>
                    {Dic.getValues(result.types).map(type =>
                        <TranslationTypeTable key={type.type} type={type} result={result} currentCulture={culture} />)}
                    <button type="button" className="btn btn-primary" onClick={handleSave}>
                        {TranslationMessage.Save.niceToString()}
                    </button>
                </div>}
            {result != undefined && result.totalTypes === 0 &&
                <Link to={`/translation/syncFolders/${encodePackage(packageName)}/${culture}`}>
                    {TranslationMessage.BackToSyncPackage0.niceToString(packageName)}
                </Link>}
        </div>
    );
}
