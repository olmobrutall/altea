import * as React from "react";
import { Link } from "react-router";
import * as AppContext from "@altea/altea/client/AppContext";
import { Navigator } from "@altea/altea/client/Navigator";
import { useAPI } from "@altea/altea/client/Hooks";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { WhatsNewEntity, WhatsNewMessage, type WhatsNewFull } from "../../data/WhatsNew";
import { WhatsNewClient } from "../WhatsNewClient";
import { HtmlViewer } from "../WhatsNewHtmlEditor";
import { htmlSubstring } from "../WhatsNewDropdown";
import "./AllNewsPage.css";

// Port of Signum.WhatsNew's Templates/AllNewsPage.tsx — the overview: one card per PUBLISHED news item,
// newest first, each marked NEW until it is read.
//
// ALTEA: the teaser cut is the dropdown's `htmlSubstring`, shared rather than copied (Signum has the same
// function twice, with 100 and 300 characters).
export default function AllNewsPage(): React.JSX.Element {
    const news = useAPI(() => WhatsNewClient.API.getAllNews(), []);

    if (news == undefined)
        return <div>{JavascriptMessage.loading.niceToString()}</div>;

    const published = news
        .filter(n => n.status === "Publish")
        // An ISO string sorts correctly lexicographically (see the DTO note in data/WhatsNew.ts).
        .sort((a, b) => (b.creationDate ?? "").localeCompare(a.creationDate ?? ""));

    return (
        <div>
            <h1 className="h2">
                {WhatsNewMessage.YourNews.niceToString()}{" "}
                <span className="sf-news-notify-badge"
                    style={{ marginTop: "6px", marginLeft: "3px", fontSize: "12px" }}>{news.length}</span>
            </h1>
            <div className="mt-3">
                <div style={{ display: "flex", flexFlow: "wrap" }}>
                    {published.map(wn => <WhatsNewCard key={wn.whatsNew.id} news={wn} />)}
                </div>
            </div>
        </div>
    );
}

export function WhatsNewCard(p: { news: WhatsNewFull }): React.JSX.Element {
    const whatsnew = p.news;
    const newsUrl = "/newspage/" + whatsnew.whatsNew.id;

    return (
        <div key={whatsnew.whatsNew.id} style={{ position: "relative", cursor: "pointer", margin: "10px" }}>
            <div className="card news-shadow" style={{ width: "500px" }}>
                {whatsnew.previewPicture &&
                    <Link to={newsUrl}
                        aria-label={`${whatsnew.title} – ${WhatsNewMessage.ReadFurther.niceToString()}`}
                        style={{ display: "inline-block", maxWidth: "10vw", marginLeft: 10 }}>
                        <div className="preview-picture-card-box">
                            <img alt={whatsnew.title}
                                src={AppContext.toAbsoluteUrl("/api/whatsnew/previewPicture/" + whatsnew.whatsNew.id)}
                                style={{ width: "100%", height: "auto" }} />
                        </div>
                    </Link>}
                <div className="card-body pt-2">
                    <h2 className="card-title h5">{whatsnew.title}</h2>
                    <small><HtmlViewer text={htmlSubstring(whatsnew.description, 300)} /></small>
                    <br />
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <Link to={newsUrl}>{WhatsNewMessage.ReadFurther.niceToString()}</Link>
                        {!Navigator.isReadOnly(WhatsNewEntity) && whatsnew.status === "Draft" &&
                            <small style={{ color: "var(--bs-danger)" }}>{whatsnew.status}</small>}
                    </div>
                    {whatsnew.attachments > 0 &&
                        <div>
                            <hr />
                            <h3 className="h5">
                                {WhatsNewMessage.Downloads.niceToString()} ({whatsnew.attachments})
                            </h3>
                        </div>}
                </div>
            </div>
            {!whatsnew.read &&
                <span className="sf-news-notify-badge" style={{ right: 0, top: 0 }}>
                    {WhatsNewMessage.New.niceToString()}
                </span>}
        </div>
    );
}
