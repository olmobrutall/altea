import * as React from "react";
import { Link, useParams } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import * as AppContext from "@altea/altea/client/AppContext";
import { Navigator } from "@altea/altea/client/Navigator";
import EntityLink from "@altea/altea/client/SearchControl/EntityLink";
import { useAPI } from "@altea/altea/client/Hooks";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { WhatsNewEntity, WhatsNewLogEntity, WhatsNewMessage } from "../../data/WhatsNew";
import { WhatsNewClient } from "../WhatsNewClient";
import { HtmlViewer } from "../WhatsNewHtmlEditor";
import "./NewsPage.css";

// Port of Signum.WhatsNew's Templates/NewsPage.tsx — ONE news item, full length. Fetching it is also what
// marks it read, which is why it raises `WhatsNewLogEntity` changed: that is what the navbar badge listens to.
export default function NewsPage(): React.JSX.Element {
    const params = useParams() as { newsId: string };
    const [refreshValue, setRefreshValue] = React.useState(0);

    const whatsnew = useAPI(() => WhatsNewClient.API.newsPage(params.newsId).then(w => {
        Navigator.raiseEntityChanged(WhatsNewLogEntity);
        return w;
    }), [params.newsId, refreshValue]);

    if (whatsnew == undefined)
        return <div>{JavascriptMessage.loading.niceToString()}</div>;

    return (
        <div key={whatsnew.whatsNew.id} style={{ position: "relative", margin: "10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
                <Link to="/news" style={{ textDecoration: "none" }}>
                    <FontAwesomeIcon aria-hidden={true} icon="angles-left" /> {WhatsNewMessage.BackToOverview.niceToString()}
                </Link>
                {!Navigator.isReadOnly(WhatsNewEntity) &&
                    <small className="ms-2 lead">
                        <EntityLink role="button" lite={whatsnew.whatsNew} onNavigated={() => setRefreshValue(a => a + 1)}>
                            <FontAwesomeIcon aria-hidden={true} icon="pen-to-square"
                                title={WhatsNewMessage.Preview.niceToString()} />
                        </EntityLink>
                    </small>}
            </div>

            <div className="whatsnewbody" key={whatsnew.whatsNew.id}>
                {whatsnew.previewPicture &&
                    <img src={AppContext.toAbsoluteUrl("/api/whatsnew/previewPicture/" + whatsnew.whatsNew.id)}
                        className="headerpicture headerpicture-shadow" alt={whatsnew.whatsNew.toString()} />}
                <article className="news pt-2">
                    <h1 className="news-title h3">
                        {whatsnew.title}{" "}
                        {!Navigator.isReadOnly(WhatsNewEntity) && whatsnew.status === "Draft" &&
                            <small style={{ color: "var(--bs-danger)" }}>{whatsnew.status}</small>}
                    </h1>
                    <HtmlViewer text={whatsnew.description} />
                </article>
            </div>
        </div>
    );
}
