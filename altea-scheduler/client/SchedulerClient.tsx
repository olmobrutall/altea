import * as React from "react";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import {
    ScheduledTaskEntity, ScheduledTaskLogEntity, SchedulerTaskExceptionLineEntity,
    ScheduleRuleMinutelyEntity, ScheduleRuleWeekDaysEntity, ScheduleRuleMonthsEntity,
    SimpleTaskSymbol,
} from "../data/Scheduler";
import { HolidayCalendarEntity } from "../data/HolidayCalendar";
import type { SchedulerState } from "../data/SchedulerState";

// Port of Signum.Scheduler's SchedulerClient.tsx — the panel route, the entity editors, and the typed HTTP
// client the panel calls.
//
// altea divergences:
//  - Signum's `Navigator.addSettings(new EntitySettings(T, view))` → `cb.configure(T).withView(...)`, and
//    its `.WithQuery(() => st => new { … })` server projection becomes `withQuerySettings({ defaultColumns })`
//    here (altea resolves query columns client-side — there is no QueryDescription).
//  - The Omnibox special action, the ChangeLog module and the `ScheduledTaskLogDatesDTO` bar-chart column
//    formatter are NOT ported: the first two have no altea counterpart on this path, and the third needs
//    `buildDateScale` from Signum's D3Utils.
//  - `Constructor.registerConstructor(ScheduleRuleWeekDaysEntity, ...)` — which pre-fills the default holiday
//    calendar on a NEW weekday rule — is deferred with it; pick the calendar in the editor instead.

export namespace SchedulerClient {

    export function start(cb: ClientBuilder): void {
        cb.routes.push(
            { path: "/scheduler/view", element: <ImportComponent onImport={() => import("./SchedulerPanelPage")} /> },
        );

        cb.configure(ScheduledTaskEntity)
            .withView(() => import("./Templates/ScheduledTask"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(t => t.id),
                    token(t => t.task),
                    token(t => t.rule),
                    token(t => t.suspended),
                    token(t => t.machineName),
                    token(t => t.applicationName),
                ],
            }));

        cb.configure(ScheduleRuleMinutelyEntity).withView(() => import("./Templates/ScheduleRuleMinutely"));
        cb.configure(ScheduleRuleWeekDaysEntity).withView(() => import("./Templates/ScheduleRuleWeekDays"));
        cb.configure(ScheduleRuleMonthsEntity).withView(() => import("./Templates/ScheduleRuleMonths"));
        cb.configure(HolidayCalendarEntity)
            .withView(() => import("./Templates/HolidayCalendar"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(c => c.id),
                    token(c => c.name),
                    token(c => c.isDefault),
                ],
            }));

        cb.configure(ScheduledTaskLogEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(l => l.id),
                    token(l => l.task),
                    token(l => l.scheduledTask),
                    token(l => l.startTime),
                    token(l => l.endTime),
                    token(l => l.machineName),
                    token(l => l.user),
                    token(l => l.exception),
                ],
            }));

        cb.configure(SchedulerTaskExceptionLineEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(l => l.id),
                    token(l => l.exception),
                    token(l => l.schedulerTaskLog),
                ],
            }));

        cb.configure(SimpleTaskSymbol)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(t => t.id),
                    token(t => t.key),
                ],
            }));
    }

    export namespace API {

        export function view(): Promise<SchedulerState> {
            // `avoidNotifyPendingRequests` like Signum: the panel polls twice a second and must not make the
            // global loading indicator flicker.
            return ajaxGet({ url: "/api/scheduler/view", avoidNotifyPendingRequests: true });
        }

        export function start(): Promise<SchedulerState> {
            return ajaxPost({ url: "/api/scheduler/start" }, undefined);
        }

        export function stop(): Promise<SchedulerState> {
            return ajaxPost({ url: "/api/scheduler/stop" }, undefined);
        }
    }
}
