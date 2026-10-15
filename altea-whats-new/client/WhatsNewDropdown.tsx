import * as React from "react";
import { Link } from "react-router";
import { Card, CardContent, CardHeader } from "@altea/altea/client/ui/Card";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Navigator } from "@altea/altea/client/Navigator";
import { toRelativeTimeISO } from "@altea/altea/client/Basics/RelativeTime";
import * as AppContext from "@altea/altea/client/AppContext";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useAPIWithReload, useCloseOnOutsideClick, useForceUpdate, useUpdatedRef } from "@altea/altea/client/Hooks";
import { classes } from "@altea/altea/data/globals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { HtmlViewer } from "./WhatsNewHtmlEditor";
import { WhatsNewEntity, WhatsNewLogEntity, WhatsNewMessage, type NumWhatsNews, type WhatsNewShort } from "../data/WhatsNew";
import { WhatsNewClient } from "./WhatsNewClient";
import "./WhatsNewDropdown.css";

// The navbar BULLHORN: a badge with the unread count, and a panel of toasts, each closable (which marks
// the item read).
//
// The count is decremented by the number of items actually CLOSED, not by 1 — which is what makes "Close
// all" leave the badge right before the refetch lands.
//
// Port of Signum.WhatsNew's Dropdown/WhatsNewDropdown.tsx — see port/WhatsNew.md.
const MaxNumberOfNews = 3;

/** The toasts' see-through look: 85% of the background, the page blurred behind. */
const newsCard = "bg-background/85 backdrop-blur-[5px]";

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
        // Optimistic, then authoritative.
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
    const toggleRef = React.useRef<HTMLButtonElement>(null);
    useCloseOnOutsideClick([divRef, toggleRef], () => setIsOpen(false), isOpen);

    return (
        <>
            <button ref={toggleRef} className="nav-link sf-news-container" onClick={handleOnToggle}
                style={{ border: 0, backgroundColor: "transparent" }}
                title={WhatsNewEntity.nicePluralName()}>
                <FontAwesomeIcon aria-hidden={true} icon="bullhorn"
                    className={classes("sf-newspaper", isOpen && "open", countResult && countResult.numWhatsNews > 0 && "active")} />
                {countResult && countResult.numWhatsNews > 0 &&
                    <span className="badge bg-destructive badge-pill sf-news-badge">{countResult.numWhatsNews}</span>}
            </button>
            {isOpen && <div className="sf-news-toasts mt-2 flex flex-col gap-1" ref={divRef}
                style={{ backdropFilter: "blur(10px)", transition: "transform .4s ease" }}>
                {newsInOrder == null ? <Card className={newsCard}><CardContent className="p-3">{JavascriptMessage.loading.niceToString()}</CardContent></Card> :
                    <>
                        {newsInOrder.length === 0 &&
                            <Card className={newsCard}><CardContent className="p-3">{WhatsNewMessage.YouDoNotHaveAnyUnreadNews.niceToString()}</CardContent></Card>}

                        {newsInOrder.filter((_, i) => i < MaxNumberOfNews)
                            .map(a => <WhatsNewToast key={a.whatsNew.id} whatsnew={a}
                                onClose={handleOnCloseNews} setIsOpen={setIsOpen} />)}

                        {newsInOrder.length > MaxNumberOfNews &&
                            <Card className={newsCard}>
                                <NewsCardHeader onClose={() => handleOnCloseNews([...whatsNew!])}>
                                    <small>{WhatsNewMessage.CloseAll.niceToString()}</small>
                                </NewsCardHeader>
                            </Card>}

                        <Card className={newsCard}>
                            <CardContent className="p-3" style={{ textAlign: "center" }}>
                                <LinkButton title={undefined} style={{ color: "var(--primary)" }}
                                    onClick={handleClickAll}>{WhatsNewMessage.AllMyNews.niceToString()}</LinkButton>
                            </CardContent>
                        </Card>
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
        <Card className={classes(newsCard, p.className)} role="alert" aria-live="assertive" aria-atomic={true}>
            <NewsCardHeader onClose={() => p.onClose([p.whatsnew])} closeLabel={WhatsNewMessage.Close0WhatsNew.niceToString(p.whatsnew.title)}>
                <strong className="me-auto" role="heading" aria-level={3}>
                    {p.whatsnew.title}{" "}
                    {!Navigator.isReadOnly(WhatsNewEntity) && p.whatsnew.status === "Draft" &&
                        <small style={{ color: "var(--destructive)" }}>{p.whatsnew.status}</small>}
                </strong>
                <small>{toRelativeTimeISO(p.whatsnew.creationDate)}</small>
            </NewsCardHeader>
            <CardContent className="p-3" style={{ whiteSpace: "pre-wrap" }}>
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
            </CardContent>
        </Card>
    );
}

/** What react-bootstrap's `Toast.Header` was: the header row with its close button at the end. */
function NewsCardHeader(p: { onClose: () => void, closeLabel?: string, children?: React.ReactNode }): React.JSX.Element {
    return (
        <CardHeader className="flex items-center px-3 py-2">
            {p.children}
            <button type="button" className="btn-close ms-3" aria-label={p.closeLabel ?? JavascriptMessage.Close.niceToString()}
                onClick={p.onClose} />
        </CardHeader>
    );
}

/**
 * A teaser cut out of the stored HTML. Truncating markup is inherently lossy;
 * the rule is to drop a `<p>` wrapper and cut BEFORE a half-included `<img>` rather than after, which is
 * what keeps the result something the viewer can render.
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

