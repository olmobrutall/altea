import * as React from "react";
import { Link } from "react-router";
import { Toast } from "react-bootstrap";
import { useRootClose } from "@restart/ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Navigator } from "@altea/altea/client/Navigator";
import * as AppContext from "@altea/altea/client/AppContext";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useAPIWithReload, useForceUpdate, useUpdatedRef } from "@altea/altea/client/Hooks";
import { classes } from "@altea/altea/data/globals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { HtmlViewer } from "./WhatsNewHtmlEditor";
import { WhatsNewEntity, WhatsNewLogEntity, WhatsNewMessage, type NumWhatsNews, type WhatsNewShort } from "../data/WhatsNew";
import { WhatsNewClient } from "./WhatsNewClient";
import "./WhatsNewDropdown.css";

// Port of Signum.WhatsNew's Dropdown/WhatsNewDropdown.tsx — the navbar BULLHORN: a badge with the unread
// count, and a panel of toasts, each closable (which marks the item read).
//
// altea divergences:
//  - luxon's `DateTime.fromISO(x).toRelative()` becomes `Intl.RelativeTimeFormat` over a Temporal
//    difference, the same helper @altea/altea-alert's bell uses (there is no luxon in altea, and Intl is
//    culture-aware for free).
//  - `react-router-dom` → `react-router`; `@framework/Globals` → `@altea/altea/data/globals`.
//  - Signum's `WhatsNewToast.icons` registry is declared and never read by anything (its own file assigns
//    an empty object and no code indexes it), so it is not ported.
//  - `Type.niceCount(n)` has no counterpart, so the button's tooltip is the plural type name.
//  - the count is decremented by the number of items actually closed, not by 1: Signum's optimistic update
//    subtracts one even from "Close all", so the badge was wrong until the refetch landed.
const MaxNumberOfNews = 3;

export default function WhatsNewDropdown(): React.JSX.Element | null {
    if (!Navigator.isViewable(WhatsNewEntity))
        return null;

    return <WhatsNewDropdownImp />;
}

function WhatsNewDropdownImp(): React.JSX.Element {

    const forceUpdate = useForceUpdate();
    const [isOpen, setIsOpen] = React.useState(false);
    const isOpenRef = useUpdatedRef(isOpen);
    const [whatsNew, setNews] = React.useState<WhatsNewShort[] | undefined>(undefined);

    const [countResult, reloadCount] = useAPIWithReload<NumWhatsNews>(
        () => WhatsNewClient.API.myNewsCount().then(res => {
            // While the panel is open a refreshed count also refreshes what it lists.
            if (isOpenRef.current)
                void WhatsNewClient.API.myNews().then(setNews);
            return res;
        }), [], { avoidReset: true });

    Navigator.useEntityChanged(WhatsNewLogEntity, () => reloadCount(), []);

    function handleOnToggle(): void {
        if (!isOpen)
            void WhatsNewClient.API.myNews().then(setNews);

        setIsOpen(!isOpen);
    }

    function handleClickAll(): void {
        setIsOpen(false);
        AppContext.navigate("/news");
    }

    function handleOnCloseNews(toRemove: WhatsNewShort[]): void {
        // Optimistic, then authoritative — Signum's two phases.
        let wasClosed = false;
        if (whatsNew) {
            whatsNew.extract(a => toRemove.some(r => r.whatsNew.is(a.whatsNew)));
            if (whatsNew.length === 0) {
                setIsOpen(false);
                wasClosed = true;
            }
        }
        if (countResult)
            countResult.numWhatsNews = Math.max(0, countResult.numWhatsNews - toRemove.length);
        forceUpdate();

        void WhatsNewClient.API.setNewsLogRead(toRemove.map(r => r.whatsNew)).then(() => {
            void WhatsNewClient.API.myNews().then(wn => {
                if (wasClosed && wn.length > 0)
                    setIsOpen(true);
                setNews(wn);
            });
            reloadCount();
        });
    }

    const newsInOrder = whatsNew == undefined ? null
        // An ISO string sorts correctly lexicographically, which is why the DTO keeps it a string.
        : [...whatsNew].sort((a, b) => b.creationDate.localeCompare(a.creationDate));

    const divRef = React.useRef<HTMLDivElement>(null);
    useRootClose(divRef as never, () => setIsOpen(false), { disabled: !isOpen });

    return (
        <>
            <button className="nav-link sf-news-container" onClick={handleOnToggle}
                style={{ border: 0, backgroundColor: "var(--bs-transparent)" }}
                title={WhatsNewEntity.nicePluralName()}>
                <FontAwesomeIcon aria-hidden={true} icon="bullhorn"
                    className={classes("sf-newspaper", isOpen && "open", countResult && countResult.numWhatsNews > 0 && "active")} />
                {countResult && countResult.numWhatsNews > 0 &&
                    <span className="badge bg-danger badge-pill sf-news-badge">{countResult.numWhatsNews}</span>}
            </button>
            {isOpen && <div className="sf-news-toasts mt-2" ref={divRef}
                style={{ backdropFilter: "blur(10px)", transition: "transform .4s ease" }}>
                {newsInOrder == null ? <Toast><Toast.Body>{JavascriptMessage.loading.niceToString()}</Toast.Body></Toast> :
                    <>
                        {newsInOrder.length === 0 &&
                            <Toast><Toast.Body>{WhatsNewMessage.YouDoNotHaveAnyUnreadNews.niceToString()}</Toast.Body></Toast>}

                        {newsInOrder.filter((_, i) => i < MaxNumberOfNews)
                            .map(a => <WhatsNewToast key={a.whatsNew.id} whatsnew={a}
                                onClose={handleOnCloseNews} setIsOpen={setIsOpen} />)}

                        {newsInOrder.length > MaxNumberOfNews &&
                            <Toast onClose={() => handleOnCloseNews([...whatsNew!])}>
                                <Toast.Header>
                                    <small>{WhatsNewMessage.CloseAll.niceToString()}</small>
                                </Toast.Header>
                            </Toast>}

                        <Toast>
                            <Toast.Body style={{ textAlign: "center" }}>
                                <LinkButton title={undefined} style={{ color: "var(--bs-primary)" }}
                                    onClick={handleClickAll}>{WhatsNewMessage.AllMyNews.niceToString()}</LinkButton>
                            </Toast.Body>
                        </Toast>
                    </>}
            </div>}
        </>
    );
}

export function WhatsNewToast(p: {
    whatsnew: WhatsNewShort;
    onClose: (e: WhatsNewShort[]) => void;
    setIsOpen: (isOpen: boolean) => void;
    className?: string;
}): React.JSX.Element {

    const newsUrl = "/newspage/" + p.whatsnew.whatsNew.id;

    function openIt(e: React.MouseEvent): void {
        e.preventDefault();
        p.onClose([p.whatsnew]);
        p.setIsOpen(false);
        AppContext.navigate(newsUrl);
    }

    return (
        <Toast onClose={() => p.onClose([p.whatsnew])} className={p.className} aria-atomic={true}>
            <Toast.Header closeLabel={WhatsNewMessage.Close0WhatsNew.niceToString(p.whatsnew.title)}>
                <strong className="me-auto" role="heading" aria-level={3}>
                    {p.whatsnew.title}{" "}
                    {!Navigator.isReadOnly(WhatsNewEntity) && p.whatsnew.status === "Draft" &&
                        <small style={{ color: "var(--bs-danger)" }}>{p.whatsnew.status}</small>}
                </strong>
                <small>{toRelative(p.whatsnew.creationDate)}</small>
            </Toast.Header>
            <Toast.Body style={{ whiteSpace: "pre-wrap" }}>
                <Link to={newsUrl} onClick={openIt}
                    aria-label={`${p.whatsnew.title} – ${WhatsNewMessage.ReadFurther.niceToString()}`}
                    style={{ display: "inline-block", maxWidth: "10vw", marginLeft: 10 }}>
                    <img src={AppContext.toAbsoluteUrl("/api/whatsnew/previewPicture/" + p.whatsnew.whatsNew.id)}
                        alt={p.whatsnew.title}
                        style={{ maxHeight: "30vh", maxWidth: "100%", borderRadius: 4, display: "block" }} />
                </Link>
                <HtmlViewer text={htmlSubstring(p.whatsnew.description, 100)} />
                <br />
                <Link to={newsUrl} onClick={openIt} aria-label={WhatsNewMessage.ReadFurther.niceToString()}>
                    {WhatsNewMessage.ReadFurther.niceToString()}
                </Link>
            </Toast.Body>
        </Toast>
    );
}

/**
 * Signum's `HTMLSubstring` — a teaser cut out of the stored HTML. Truncating markup is inherently lossy;
 * this keeps Signum's rule (drop a `<p>` wrapper, and cut BEFORE a half-included `<img>` rather than after)
 * because the viewer that renders the result tolerates the same shapes Signum's does.
 */
export function htmlSubstring(text: string, length: number): string {
    let substring = text.substring(0, length).replace("<p>", "").replace("</p>", "");
    if (substring.includes("<img")) {
        const fullImageTag = substring.match(/(<img[^>]*)(\/>)/gmi);
        if (fullImageTag == undefined || fullImageTag.length === 0)
            return substring.substring(0, substring.indexOf("<img")) + "...";
    }
    return substring + "...";
}

/** luxon's `DateTime.toRelative()`, over Temporal + Intl — @altea/altea-alert's helper, same reasoning. */
function toRelative(isoDate: string | null | undefined): string {
    if (isoDate == null || isoDate === "")
        return "";

    const date = Temporal.PlainDateTime.from(isoDate);
    const minutes = Math.round(date.since(Clock.now).total({ unit: "minutes" }));
    const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

    const abs = Math.abs(minutes);
    if (abs < 60) return format.format(minutes, "minute");
    if (abs < 60 * 24) return format.format(Math.round(minutes / 60), "hour");
    if (abs < 60 * 24 * 30) return format.format(Math.round(minutes / (60 * 24)), "day");
    if (abs < 60 * 24 * 365) return format.format(Math.round(minutes / (60 * 24 * 30)), "month");
    return format.format(Math.round(minutes / (60 * 24 * 365)), "year");
}
