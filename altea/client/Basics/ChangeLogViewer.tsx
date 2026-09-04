import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Temporal } from "../../data/basics";
import { ChangeLogMessage } from "../../data/changeLog";
import { ConnectionMessage } from "../../data/uiMessages";
import { useAPI, useAPIWithReload } from "../Hooks";
import MessageModal from "../Modals/MessageModal";
import * as AppContext from "../AppContext";
import { LinkButton } from "./LinkButton";
import { ChangeLogClient } from "./ChangeLogClient";
import type { ChangeItem } from "./changeLogMerge";
import "./ChangeLog.css";

// Port of Signum's React/Basics/ChangeLogViewer.tsx — the navbar button that opens the change log, with a
// badge counting the deployments the user has not read yet.
//
// altea divergences:
//  - **Signum's `VersionChangedAlert` is not ported**, so neither is the `VersionInfo` /
//    `VersionInfoTooltip` pair this hangs off there. In Signum this component IS the version-info navbar
//    item (it falls back to `<VersionInfo/>` with no user, and wraps its own button in a tooltip showing
//    the build). altea has no build/version surface to show, so the button stands alone and renders
//    NOTHING without a user — there is no per-user read state to badge, and the login screen has no
//    changelog to offer.
//  - luxon → `Temporal.PlainDateTime`. The dates arrive as ISO strings and only ever get compared, so the
//    comparison goes through `Temporal.PlainDateTime.compare` (altea's own idiom — Temporal has no
//    relational operators).
//  - `MessageModal.show` takes no `autoFocusonTitle` in altea; focus returns to the trigger afterwards,
//    which is the part that mattered.
export default function ChangeLogViewer(): React.ReactElement | null {
    const hasUser = AppContext.currentUser != null;

    const [lastDateString, reloadLastDate] = useAPIWithReload(
        () => hasUser ? ChangeLogClient.API.getLastDate() : Promise.resolve(null),
        [hasUser],
        { avoidReset: true });

    const logs = useAPI(
        () => hasUser ? ChangeLogClient.getChangeLogs() : Promise.resolve(null),
        [hasUser]);

    const triggerRef = React.useRef<HTMLAnchorElement | null>(null);

    if (!hasUser || logs == null)
        return null;

    const lastDate = parseDate(lastDateString);
    const unread = logs.filter(l => isAfter(l.deployDate, lastDate)).length;

    async function handleOpen(): Promise<void> {
        await MessageModal.show({
            title: ChangeLogMessage.ChangeLogs.niceToString(),
            size: "md",
            message: <ShowLogs logs={logs!} lastDate={lastDate} />,
            buttons: "ok",
        });

        triggerRef.current?.focus();

        await ChangeLogClient.API.updateLastDate();
        reloadLastDate();
    }

    return (
        <LinkButton title={ConnectionMessage.VersionInfo.niceToString()}
            ref={triggerRef}
            className="sf-pointer nav-link"
            aria-haspopup="dialog"
            onClick={() => { void handleOpen(); }}>
            <FontAwesomeIcon icon="circle-info" />
            {unread > 0 && (
                <span className="badge text-bg-info badge-pill sf-change-log-badge">{unread}</span>
            )}
        </LinkButton>
    );
}

function ShowLogs(p: { logs: ChangeItem[]; lastDate: Temporal.PlainDateTime | undefined }): React.ReactElement {
    // Signum shows two deployments and grows by two per click.
    const [seeMore, setSeeMore] = React.useState(2);

    const byDate = p.logs.orderByDescending(l => l.deployDate).groupBy(l => l.deployDate);
    const shown = byDate.slice(0, seeMore);

    return (
        <div role="region" aria-label={ChangeLogMessage.ChangeLogEntries.niceToString()}>
            {shown.map(gr => {
                const isNew = isAfter(gr.key, p.lastDate);
                return (
                    <section key={gr.key} aria-labelledby={`deployed-${gr.key}`}>
                        <h2 className="h3" id={`deployed-${gr.key}`}>
                            <time dateTime={gr.key} title={ChangeLogMessage.DeployedOn0.niceToString(gr.key)}>
                                {isNew ? <strong>{gr.key}</strong> : gr.key}
                            </time>
                        </h2>
                        <ul className="mb-2 p-0" role="list">
                            {gr.elements
                                .flatMap(e => e.changeLog.map((line: string) => ({ module: e.module, implDate: e.implDate, line })))
                                .map((a, i) => (
                                    <li className="ms-5 pb-1" key={i} tabIndex={0} role="article"
                                        aria-label={ChangeLogMessage._0ImplementedOn1WithFollowingChanges2
                                            .niceToString(a.module, a.implDate, a.line)}>
                                        <strong><samp>{a.module} &gt; </samp></strong>
                                        <span>{a.line}</span>
                                    </li>
                                ))}
                        </ul>
                    </section>
                );
            })}

            {byDate.length > seeMore && (
                <button type="button" className="btn btn-link p-0"
                    onClick={() => setSeeMore(prev => prev + 2)}
                    aria-label={ChangeLogMessage.SeeMoreChangeLogEntries.niceToString()}>
                    {ChangeLogMessage.SeeMore.niceToString()}
                </button>
            )}
        </div>
    );
}

function parseDate(iso: string | null | undefined): Temporal.PlainDateTime | undefined {
    if (iso == null || iso === "")
        return undefined;
    try {
        return Temporal.PlainDateTime.from(iso);
    } catch {
        return undefined;
    }
}

/** Is this deploy date after the user's last read? Unread when they have never read it. */
function isAfter(deployDate: string, lastDate: Temporal.PlainDateTime | undefined): boolean {
    if (lastDate == undefined)
        return true;
    const deployed = parseDate(deployDate);
    return deployed == undefined || Temporal.PlainDateTime.compare(deployed, lastDate) > 0;
}
