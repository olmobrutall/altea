import "@altea/altea/data/globals/arrayExtensions";
import * as React from "react";
import { Link, useSearchParams } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import { useAPI } from "@altea/altea/client/Hooks";
import { useTitle } from "@altea/altea/client/AppContext";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import { classes } from "@altea/altea/data/globals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import {
    HelpMessage, HelpSearchMessage,
    type HelpSearchResult, type TypeSearchResult,
} from "../../data/Help";
import { HelpClient } from "../HelpClient";

// NEW in altea — Signum has the SCAN (HelpSearch.cs) and a `Urls.searchUrl`, but no endpoint, no route and
// no page, so its own omnibox "help 'text'" suggestion 404s. This is the missing page: the hits grouped by
// what they are, each linking to the exact anchor on the type / namespace / appendix page.
export default function HelpSearchPage(): React.JSX.Element {

    const [searchParams, setSearchParams] = useSearchParams();
    const query = searchParams.get("q") ?? "";

    const [text, setText] = React.useState(query);
    React.useEffect(() => setText(query), [query]);

    const response = useAPI(() => query.trim() === "" ? Promise.resolve(undefined) : HelpClient.API.search(query), [query]);

    useTitle(`${HelpMessage.Help.niceToString()} > ${HelpSearchMessage.Search.niceToString()}`);

    function onSubmit(e: React.FormEvent): void {
        e.preventDefault();
        setSearchParams({ q: text });
    }

    return (
        <div className="container">
            <h1 className="display-6">
                <Link to={HelpClient.Urls.indexUrl()}>{HelpMessage.Help.niceToString()}</Link>
                {" > "}
                {HelpSearchMessage.Search.niceToString()}
            </h1>

            <form className="row g-2 align-items-center mb-4" onSubmit={onSubmit} role="search">
                <div className="col-auto">
                    <label className="visually-hidden" htmlFor="helpSearchText">{HelpMessage.SearchText.niceToString()}</label>
                    <input id="helpSearchText"
                        type="search"
                        className="form-control"
                        placeholder={HelpMessage.SearchText.niceToString()}
                        value={text}
                        onChange={e => setText(e.currentTarget.value)} />
                </div>
                <div className="col-auto">
                    <button type="submit" className="btn btn-primary">
                        <FontAwesomeIcon aria-hidden={true} icon="magnifying-glass" /> {HelpSearchMessage.Search.niceToString()}
                    </button>
                </div>
            </form>

            {query.trim() !== "" && response == undefined && <span>{JavascriptMessage.loading.niceToString()}</span>}

            {response && <>
                <p className="text-muted">
                    {HelpSearchMessage._0ResultsFor1In2.niceToString(response.results.length, `"${response.query}"`, response.elapsedMs)}
                </p>

                {response.results.length === 0
                    ? <div className="alert alert-secondary">{HelpSearchMessage.NoResults.niceToString()}</div>
                    : <dl className="row">
                        {response.results.map((r, i) => <ResultLine key={i} result={r} />)}
                    </dl>}
            </>}
        </div>
    );
}

const kindIcon: Record<TypeSearchResult, { icon: IconProp; color: string }> = {
    Appendix: { icon: "file-lines", color: "darkviolet" },
    Namespace: { icon: "folder", color: "#0d6efd" },
    Type: { icon: "table", color: "#198754" },
    Property: { icon: "tag", color: "#6c757d" },
    Query: { icon: "magnifying-glass", color: "#0dcaf0" },
    Operation: { icon: "bolt", color: "#fd7e14" },
};

function ResultLine({ result }: { result: HelpSearchResult }): React.JSX.Element {

    const badge = kindIcon[result.typeSearchResult];

    return (
        <>
            <dt className="col-sm-3 text-end">
                <FontAwesomeIcon icon={badge.icon} color={badge.color} className="me-2" aria-hidden={true} />
                <Link to={urlOf(result)}>{result.title}</Link>
            </dt>
            <dd className={classes("col-sm-9", result.isDescription && "sf-info")}>
                {result.description}
            </dd>
        </>
    );
}

/** Each hit knows its own address: `key` is the page and `key2` (when present) the anchor within it. */
function urlOf(r: HelpSearchResult): string {
    switch (r.typeSearchResult) {
        case "Appendix": return HelpClient.Urls.appendixUrl(r.key);
        case "Namespace": return HelpClient.Urls.namespaceUrl(r.key2 ?? r.key);
        case "Type": return HelpClient.Urls.typeUrl(r.key);
        case "Property": return HelpClient.Urls.propertyUrl(r.key, r.key2!);
        case "Query": return HelpClient.Urls.queryUrl(r.key, r.key2!);
        case "Operation": return HelpClient.Urls.operationUrl(r.key, r.key2!);
    }
}
