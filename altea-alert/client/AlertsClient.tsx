import * as React from "react";
import { Link } from "react-router";
import { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { Operations, EntityOperationSettings } from "@altea/altea/client/Operations";
import EntityLink from "@altea/altea/client/SearchControl/EntityLink";
import { QuickLinkClient, QuickLinkExplore } from "@altea/altea/client/QuickLinkClient";
import SelectorModal from "@altea/altea/client/SelectorModal";
import { ajaxGet } from "@altea/altea/client/Services";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Enum } from "@altea/altea/data/enum";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import {
    AlertEntity, AlertMessage, AlertOperation, AlertTypeSymbol, DelayOption, SendNotificationEmailTaskEntity,
} from "../data/Alert";
import { DelayModal } from "./DelayModal";

// Port of Signum.Alerts' AlertsClient.tsx — the module's client registration, plus the two things the views
// and the dropdown share: `getTitle` (the alert-type fallback) and `format` (the placeholder expansion).
//
// altea divergences:
//  - Signum's `Navigator.addSettings(new EntitySettings(T, …))` is `cb.configure(T).withView(…)`, which is
//    also what registers the type on the client (altea has no generated registration file).
//  - luxon → `Temporal`; Signum's `DateTime.local().plus({minutes: 5})` is `Temporal.Now.plainDateTimeISO()
//    .add({ minutes: 5 })`.
//  - `AutoLineModal.show({ type: … })` has no altea counterpart (see CLAUDE.md), so the "Custom" delay asks
//    through a small local modal — the accommodation altea-workflow makes for its own date prompts.
//  - the AlertType VIEW is gone with the SemiSymbol (an alert type is code-declared — see data/Alert.ts).
export namespace AlertsClient {

    /** Signum's `showAlerts(typeName, when)` — which types offer "create an alert" / the alerts quick link. */
    export let showAlerts: (typeName: string, when: "CreateAlert" | "QuickLink") => boolean = () => true;

    export function start(cb: ClientBuilder, options?: {
        showAlerts?: (typeName: string, when: "CreateAlert" | "QuickLink") => boolean;
    }): void {

        if (options?.showAlerts != null)
            showAlerts = options.showAlerts;

        cb.configure(AlertEntity)
            .withView(() => import("./Templates/Alert"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.alertDate),
                    token(a => a.alertType),
                    token(a => a.state),
                    token(a => a.titleField),
                    token(a => a.textField),
                    token(a => a.recipient),
                    token(a => a.createdBy),
                    token(a => a.attendedDate),
                    token(a => a.attendedBy),
                ],
                // Signum hides the columns its Text formatter READS off the row (it needs them present in
                // the result, but they are not worth a column of their own).
                hiddenColumns: [
                    { token: token(a => a.target) },
                    { token: token(a => a.targetToString) },
                    { token: token(a => a.linkTarget) },
                    { token: token(a => a.textArguments) },
                    { token: token(a => a.creationDate) },
                ],
                formatters: { "textField": textCellFormatter() },
            }));

        cb.configure(SendNotificationEmailTaskEntity)
            .withView(() => import("./Templates/SendNotificationEmailTask"));

        // "Create an alert about this entity" — the button lives on the SOURCE type, so its visibility is
        // per type (Signum's couldHaveAlerts).
        Operations.addSettings(new EntityOperationSettings(AlertOperation.CreateAlertFromEntity, {
            isVisible: ctx => showAlerts(ctx.entity.constructor.name, "CreateAlert"),
            icon: "bell",
            iconColor: "darkorange",
            color: "warning",
            contextual: { isVisible: ctx => showAlerts(ctx.context.lites[0]!.entityType.name, "CreateAlert") },
        }));

        Operations.addSettings(new EntityOperationSettings(AlertOperation.Attend, { hideOnCanExecute: true }));
        Operations.addSettings(new EntityOperationSettings(AlertOperation.Unattend, { hideOnCanExecute: true }));

        // Delay asks WHEN first, then runs with that date as the operation's argument.
        Operations.addSettings(new EntityOperationSettings(AlertOperation.Delay, {
            hideOnCanExecute: true,
            commonOnClick: eoc => chooseDate().then(d => d && eoc.defaultClick(d.toString())),
            contextualFromMany: { onClick: coc => chooseDate().then(d => d && coc.defaultClick(d.toString())) },
        }));

        // "The alerts about this entity", on every type that opts in (Signum's registerGlobalQuickLink).
        QuickLinkClient.registerGlobalQuickLink(entityType => Promise.resolve([
            new QuickLinkExplore(entityType,
                ctx => AlertEntity.findOptions(token => ({
                    filterOptions: [token(a => a.target).filter("EqualTo", ctx.lite)],
                })),
                {
                    key: "Alerts",
                    text: () => AlertEntity.nicePluralName(),
                    isVisible: Finder.isFindable(AlertEntity, false) && showAlerts(entityType, "QuickLink"),
                    icon: "clock-rotate-left",
                    iconColor: "green",
                    color: "success",
                }),
        ]));
    }

    /** The cell formatter Signum registers for the `Text` column: the placeholders become real links. */
    function textCellFormatter(): Finder.CellFormatter {
        return new Finder.CellFormatter((cell, ctx) => {
            if (cell == null)
                return undefined;

            const read = (token: string) => ctx.searchControl?.getRowValue(ctx.row, token);
            const alert: Partial<AlertEntity> = {
                createdBy: read("createdBy") as Lite<never> | undefined ?? null,
                creationDate: read("creationDate") as Temporal.PlainDateTime,
                alertDate: read("alertDate") as Temporal.PlainDateTime,
                target: read("target") as Lite<Entity> | null,
                targetToString: read("targetToString") as string | null,
                linkTarget: read("linkTarget") as Lite<Entity> | null,
                textArguments: read("textArguments") as string | null,
            };
            return format(String(cell), alert);
        }, true);
    }

    // ---- Delay ------------------------------------------------------------------------------------------

    /** Signum's `chooseDate` — one of the fixed offsets, or a date the user types. */
    export function chooseDate(): Promise<Temporal.PlainDateTime | undefined> {
        return SelectorModal.chooseElement(Enum.values(DelayOption), {
            title: AlertMessage.DelayDuration.niceToString(),
            buttonDisplay: v => Enum.niceName(DelayOption, v),
        }).then(val => {
            if (val == null)
                return undefined;

            // The delay is STORED, so it has to be in the clock's frame (UTC by default) — not the
            // browser's local time, which would land the alert hours off.
            const now = Clock.now;
            switch (val) {
                case "_5Mins": return now.add({ minutes: 5 });
                case "_15Mins": return now.add({ minutes: 15 });
                case "_30Mins": return now.add({ minutes: 30 });
                case "_1Hour": return now.add({ hours: 1 });
                case "_2Hours": return now.add({ hours: 2 });
                case "_1Day": return now.add({ days: 1 });
                case "Custom": return DelayModal.show(now);
                default: throw new Error("Unexpected " + val);
            }
        });
    }

    // ---- Title / text rendering (shared by the view, the dropdown and the cell formatter) ---------------

    /** Signum's `getTitle` — the row's own title, else the alert TYPE's nice name. */
    export function getTitle(titleField: string | null | undefined, type: AlertTypeSymbol | null | undefined): string | null {
        if (titleField)
            return titleField;
        if (type == null)
            return " - ";
        return type.niceToString();
    }

    const linkPlaceholder = /\[(?<prop>(\w|\d|\.)+)(:(?<text>.+))?\](\((?<url>.+)\))?/g;
    const textPlaceholder = /{(?<prop>(\w|\d|\.)+)}/g;
    const numericPlaceholder = /^[ \d]+$/;

    /**
     * Signum's `format(text, alert)` — expand `[property:text](url)` into a link and `{0}` / `{property}`
     * into a value. The one renderer behind the alert view, the dropdown toast and the search cell.
     */
    export function format(text: string, alert: Partial<AlertEntity>, onNavigated?: () => void): React.ReactElement {
        const nodes: (string | React.ReactElement)[] = [];
        let pos = 0;
        let key = 0;

        for (const match of Array.from(text.matchAll(linkPlaceholder))) {
            nodes.push(replacePlaceHolders(text.substring(pos, match.index), alert) ?? "");

            const groups = (match as RegExpMatchArray & { groups?: Record<string, string | undefined> }).groups ?? {};
            const prop = getPropertyValue(groups["prop"] ?? "", alert);
            const lite = prop instanceof Entity ? prop.toLite() : prop instanceof Lite ? prop : null;

            if (groups["url"]) {
                const url = replacePlaceHolders(groups["url"], alert)!;
                const linkText = replacePlaceHolders(groups["text"], alert) ?? lite?.toString() ?? url;
                if (url.startsWith("http"))
                    nodes.push(<a key={key++} href={url} target="_blank" rel="noreferrer">{linkText}</a>);
                else
                    nodes.push(<Link key={key++} to={url.startsWith("~") ? url.substring(1) : url}>{linkText}</Link>);
            }
            else if (lite != null) {
                const linkText = replacePlaceHolders(groups["text"], alert);
                nodes.push(<EntityLink key={key++} lite={lite} onNavigated={onNavigated}>{linkText}</EntityLink>);
            }

            pos = (match.index ?? 0) + match[0].length;
        }

        nodes.push(replacePlaceHolders(text.substring(pos), alert) ?? "");

        // Signum: nothing was expanded, so show the TARGET as a link of its own.
        if (nodes.length === 1 && alert.target != null) {
            nodes.push(<br key={key++} />);
            nodes.push(<EntityLink key={key++} lite={alert.target} onNavigated={onNavigated} />);
        }

        return React.createElement(React.Fragment, {}, ...nodes);
    }

    function replacePlaceHolders(value: string | null | undefined, alert: Partial<AlertEntity>): string | null {
        if (value == null)
            return null;

        return value.replace(textPlaceholder, (_all, prop: string) => {
            if (numericPlaceholder.test(prop))
                return alert.textArguments?.split("\n###\n")[parseInt(prop, 10)] ?? "";
            return String(getPropertyValue(prop, alert) ?? "");
        });
    }

    function getPropertyValue(path: string, target: unknown): unknown {
        if (target == null || path === "")
            return null;
        const dot = path.indexOf(".");
        if (dot > 0)
            return getPropertyValue(path.substring(dot + 1), getPropertyValue(path.substring(0, dot), target));
        const name = path.charAt(0).toLowerCase() + path.substring(1);
        return (target as Record<string, unknown>)[name];
    }

    // ---- The two endpoints the dropdown polls ----------------------------------------------------------

    export interface NumAlerts { numAlerts: number; lastAlert: string | null }

    export namespace API {
        export function myAlerts(): Promise<AlertEntity[]> {
            return ajaxGet({ url: "/api/alerts/myAlerts", avoidNotifyPendingRequests: true });
        }

        export function myAlertsCount(): Promise<NumAlerts> {
            return ajaxGet({ url: "/api/alerts/myAlertsCount", avoidNotifyPendingRequests: true });
        }
    }
}

export type { Navigator };
