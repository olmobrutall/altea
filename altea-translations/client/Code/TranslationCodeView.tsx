import * as React from "react";
import { Link, useLocation, useParams } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Operations } from "@altea/altea/client/Operations";
import { useAPI } from "@altea/altea/client/Hooks";
import { useTitle } from "@altea/altea/client/AppContext";
import { Dic } from "@altea/altea/data/globals";
import { TranslationMessage } from "../../data/Translation";
import { TranslationClient, decodePackage } from "../TranslationClient";
import { TranslationTypeTable } from "./TranslationTypeTable";
import "../Translation.css";

// Port of Signum.Translation's Code/TranslationCodeView.tsx — read (and hand-edit) what is already
// translated, filtered by a search box. Deliberately does NOT load until you search: a package's full
// route-complete table is thousands of rows.
export default function TranslationCodeView(): React.JSX.Element {
    const params = useParams() as { culture?: string; package: string };
    const location = useLocation();

    const packageName = decodePackage(params.package);
    const culture = params.culture;

    const [filter, setFilter] = React.useState(() => new URLSearchParams(location.search).get("filter") ?? "");

    const result = useAPI(
        () => filter === "" ? Promise.resolve(undefined) : TranslationClient.API.retrieve(packageName, culture ?? "", filter),
        [packageName, culture, filter]);

    const message = TranslationMessage.View0In1.niceToString(packageName,
        culture ?? TranslationMessage.AllLanguages.niceToString());

    useTitle(message);

    function handleSave(e: React.FormEvent): void {
        e.preventDefault();
        void TranslationClient.API.save(packageName, culture ?? "", result!).then(() => Operations.notifySuccess());
    }

    return (
        <div>
            <h1 className="h2">
                <Link to="/translation/status">{TranslationMessage.CodeTranslations.niceToString()}</Link>
                {" > "}{message}
            </h1>
            <TranslateSearchBox filter={filter} setFilter={setFilter} />
            <em>{TranslationMessage.PressSearchForResults.niceToString()}</em>
            <br />
            {result != undefined && (Dic.getKeys(result.types).length === 0
                ? <strong>{TranslationMessage.NoResultsFound.niceToString()}</strong>
                : (
                    <div>
                        {Dic.getValues(result.types).map(type =>
                            <TranslationTypeTable key={type.type} type={type} result={result} currentCulture={culture} />)}
                        <input type="submit" value={TranslationMessage.Save.niceToString()} className="btn btn-primary" onClick={handleSave} />
                    </div>
                ))}
        </div>
    );
}

export function TranslateSearchBox(p: { filter: string; setFilter: (newFilter: string) => void }): React.JSX.Element {
    const [tmpFilter, setTmpFilter] = React.useState(p.filter);

    return (
        <form onSubmit={e => { e.preventDefault(); p.setFilter(tmpFilter); }} className="input-group">
            <input type="text" className="form-control"
                placeholder={TranslationMessage.Search.niceToString()}
                aria-label={TranslationMessage.Search.niceToString()}
                value={tmpFilter} onChange={e => setTmpFilter(e.currentTarget.value)} />
            <button className="btn btn-tertiary" type="submit" title={TranslationMessage.Search.niceToString()}>
                <FontAwesomeIcon aria-hidden={true} icon="magnifying-glass" />
            </button>
        </form>
    );
}
