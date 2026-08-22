import * as React from 'react';
import { Link } from 'react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { ajaxGet } from '@altea/altea/client/Services';
import type { ClientBuilder } from '@altea/altea/client/ClientBuilder';
import { Navigator } from '@altea/altea/client/Navigator';
import { Finder } from '@altea/altea/client/Finder';
import * as AppContext from '@altea/altea/client/AppContext';
import { ImportComponent } from '@altea/altea/client/ImportComponent';
import { QuickLinkClient, QuickLinkLink } from '@altea/altea/client/QuickLinkClient';
import { SearchControlOptions } from '@altea/altea/client/SearchControl/SearchControl';
import { TimeMachineColors } from '@altea/altea/client/Lines/TimeMachineIcon';
import { tryGetTypeInfo, getTypeName } from '@altea/altea/client/Reflection';
import { Entity } from '@altea/altea/data/entity';
import { Lite } from '@altea/altea/data/lite';
import { Temporal } from '@altea/altea/data/basics';
import { EntityControlMessage, JavascriptMessage } from '@altea/altea/data/uiMessages';
import { AuthClient } from '@altea/altea-auth/client/AuthClient';
import { TimeMachineMessage, TimeMachinePermission } from '../data/TimeMachine';

// Port of Signum.TimeMachine's TimeMachineClient.tsx — the module's client registration: the quick link
// onto every system-versioned entity, the "Time Machine" toggle in every SearchControl's menu, the page
// route, and the three search-result formatters that mark a row version as created / deleted / unchanged.
//
// altea divergences:
//  - **`AppContext.isPermissionAuthorized` lives in altea-auth**, not core (see CLAUDE.md), so the gate is
//    `AuthClient.isPermissionAuthorized`. Signum reads the permission ONCE at start; here the check is
//    inside the callbacks, because a permission flag follows `onCurrentUserChanged` (the lesson from the
//    auth-directory ports) and a start-time snapshot would be wrong after a re-login.
//  - **the quick link drops Signum's `getTypeInfo(entityType).operations` condition.** altea's TypeInfo has
//    no `operations` (they live on the per-request metadata blob), and the condition was redundant anyway:
//    what it really gated on was `Finder.isFindable(OperationLogEntity)`, which is kept.
//  - `ti.isSystemVersioned` → `ti.systemVersioned != null` (altea keeps the descriptor, not a flag).
//  - luxon `DateTime.fromISO` → `Temporal.PlainDateTime.from` (altea's period bounds are tz-naive).
//  - the "LiteNoFill_TM" rule is not ported, matching core's FinderRules, which likewise skips Signum's
//    "LiteNoFill" (an `avoidFillSearchColumnWidth` width tweak).
export namespace TimeMachineClient {

    export function start(cb: ClientBuilder): void {

        QuickLinkClient.registerGlobalQuickLink(entityType => Promise.resolve(
            !AuthClient.isPermissionAuthorized(TimeMachinePermission.ShowTimeMachine) ||
                tryGetTypeInfo(entityType)?.systemVersioned == null ? [] :
                [
                    new QuickLinkLink("TimeMachine", () => TimeMachineMessage.TimeMachine.niceToString(),
                        ctx => timeMachineRoute(ctx.lite), {
                        icon: "clock-rotate-left",
                        iconColor: "blue",
                        color: "success",
                    }),
                ]));

        SearchControlOptions.showSystemTimeButton = () =>
            AuthClient.isPermissionAuthorized(TimeMachinePermission.ShowTimeMachine);

        cb.routes.push(
            { path: "/timeMachine/:type/:id", element: <ImportComponent onImport={() => import("./TimeMachinePage")} /> },
        );

        // The row's "view" button, replaced while a system-time query is showing: it opens the TIME
        // MACHINE for that row instead of the entity, and carries the created / deleted markers.
        Finder.entityFormatRules.push({
            name: "ViewHistory",
            isApplicable: sc => sc != null && sc.props.findOptions.systemTime != null
                && Finder.isSystemVersioned(sc.props.queryToken?.type),
            formatter: new Finder.EntityFormatter(ctx => {
                const sc = ctx.searchControl;
                const { icon, deleted } = versionMarker(ctx.columns, ctx.row.columns, sc?.state.resultFindOptions?.systemTime);

                if (sc?.state.resultFindOptions?.groupResults)
                    return (
                        <a className="sf-line-button sf-view" href="#"
                            onClick={(e: React.MouseEvent) => { e.preventDefault(); sc.openRowGroup(ctx.row, e); }}
                            title={JavascriptMessage.ShowGroup.niceToString()}
                            style={{ whiteSpace: "nowrap", opacity: deleted ? .5 : undefined }}>
                            <FontAwesomeIcon aria-hidden={true} icon="layer-group" />
                            {icon}
                        </a>
                    );

                const lite = ctx.row.entity;
                if (lite == null || !Navigator.isViewable(lite.entityType, { isSearch: "main" }))
                    return icon;

                return (
                    <TimeMachineLink lite={lite} inSearch="main" style={{ whiteSpace: "nowrap", opacity: deleted ? .5 : undefined }}>
                        {EntityControlMessage.View.niceToString()}
                        {icon}
                    </TimeMachineLink>
                );
            }),
        });

        // A Lite CELL inside a system-time query also links to the Time Machine, not to the entity: the
        // row being shown is a past version, so "view" should keep the reader in history.
        Finder.formatRules.push({
            name: "Lite_TM",
            isApplicable: (qt, sc) => qt.filterType == "Lite" && sc != null
                && sc.props.findOptions.systemTime != null && Finder.isSystemVersioned(qt.type),
            formatter: () => new Finder.CellFormatter((cell: Lite<Entity> | undefined) =>
                cell == null ? undefined : <TimeMachineLink lite={cell} />, true),
        });
    }

    /** Signum's `EntityDump` — one version of a row plus its ObjectDumper text. */
    export interface EntityDump {
        entity: Entity;
        dump: string;
    }

    export namespace API {
        export function getEntityDump(lite: Lite<Entity>, asOf: string): Promise<EntityDump> {
            return ajaxGet({
                url: `/api/timeMachine/retrieveVersion/${getTypeName(lite)}/${lite.id}`
                    + `?asOf=${encodeURIComponent(asOf)}`,
            });
        }
    }

    export function timeMachineRoute(lite: Lite<Entity>): string {
        return "/timeMachine/" + getTypeName(lite) + "/" + lite.id;
    }
}

// Signum's inline block inside the ViewHistory formatter: read the row's SystemValidFrom/To against the
// query's system-time window and say whether this version appeared, disappeared, or merely persisted.
// The two columns are the hidden ones the SearchControl injects for a system-time query.
function versionMarker(
    columns: string[],
    values: unknown[],
    systemTime: { mode: string; startDate?: string; endDate?: string } | undefined,
): { icon: React.ReactElement | undefined; deleted: boolean } {

    const validFromIndex = columns.indexOf("systemValidFrom");
    const validToIndex = columns.indexOf("systemValidTo");
    if (systemTime == null || validFromIndex == -1 || validToIndex == -1)
        return { icon: undefined, deleted: false };

    const validFrom = parseDate(values[validFromIndex]);
    const validTo = parseDate(values[validToIndex]);
    if (validFrom == null || validTo == null)
        return { icon: undefined, deleted: false };

    const between = systemTime.mode == "Between";
    const created = between
        ? Temporal.PlainDateTime.compare(Temporal.PlainDateTime.from(systemTime.startDate!), validFrom) <= 0
        : true;
    // Signum's `validTo.year < 9999`: the open-ended sentinel the versioning tables write for the row
    // version that is still current.
    const deleted = between
        ? Temporal.PlainDateTime.compare(validTo, Temporal.PlainDateTime.from(systemTime.endDate!)) <= 0
        : validTo.year < 9999;

    const title = created && deleted ? TimeMachineMessage.ThisVersionWasCreatedAndDeleted.niceToString() :
        created ? TimeMachineMessage.ThisVersionWasCreated.niceToString() :
            deleted ? TimeMachineMessage.ThisVersionWasDeleted.niceToString() :
                TimeMachineMessage.ThisVersionDidNotChange.niceToString();

    const icon = (
        <span className="ms-2" title={title + (between ? " " + TimeMachineMessage.BetweenThisTimeRange.niceToString() : "")}>
            {created && <FontAwesomeIcon aria-hidden={true} icon="plus" color={TimeMachineColors.created} />}
            {deleted && <FontAwesomeIcon aria-hidden={true} icon="minus" color={TimeMachineColors.removed} className={created ? "ms-1" : undefined} />}
            {!created && !deleted && between && <FontAwesomeIcon aria-hidden={true} icon="equals" color={TimeMachineColors.noChange} />}
        </span>
    );

    return { icon, deleted };
}

function parseDate(value: unknown): Temporal.PlainDateTime | null {
    if (value instanceof Temporal.PlainDateTime)
        return value;
    if (typeof value === "string" && value !== "")
        try { return Temporal.PlainDateTime.from(value); } catch { return null; }
    return null;
}

export interface TimeMachineLinkProps extends React.HTMLAttributes<HTMLAnchorElement> {
    lite: Lite<Entity>;
    inSearch?: "main" | "related";
}

/** Signum's TimeMachineLink — an EntityLink that opens the Time Machine page in a new tab. */
export function TimeMachineLink(p: TimeMachineLinkProps): React.JSX.Element {
    const { lite, inSearch, children, ...htmlAtts } = p;

    if (!Navigator.isViewable(lite.entityType, { isSearch: inSearch }))
        return <span data-entity={lite.key()}>{children ?? lite.toString()}</span>;

    return (
        <Link
            to={TimeMachineClient.timeMachineRoute(lite)}
            title={lite.toString()}
            onClick={e => { e.preventDefault(); window.open(AppContext.toAbsoluteUrl(TimeMachineClient.timeMachineRoute(lite))); }}
            data-entity={lite.key()}
            {...htmlAtts}>
            {children ?? lite.toString()}
        </Link>
    );
}
