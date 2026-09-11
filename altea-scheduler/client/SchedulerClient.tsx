import * as React from "react";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import {
    ScheduledTaskEntity, ScheduledTaskLogEntity, SchedulerTaskExceptionLineEntity,
    ScheduleRuleMinutelyEntity, ScheduleRuleWeekDaysEntity, ScheduleRuleMonthsEntity,
    SimpleTaskSymbol, SchedulerPermission,
} from "../data/Scheduler";
import { HolidayCalendarEntity } from "../data/HolidayCalendar";
import type { SchedulerState } from "../data/SchedulerState";
import { registerSpecialAction } from "@altea/altea/client/OmniboxSpecialAction";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";

// The panel route, the entity editors, and the typed HTTP client the panel calls. Default columns are a
// CLIENT setting here, since `withQuery()` takes no projection.
//
// See port/Scheduler.md.

export namespace SchedulerClient {

    export function start(cb: ClientBuilder): void {
        cb.routes.push(
            { path: "/scheduler/view", element: <ImportComponent onImport={() => import("./SchedulerPanelPage")} /> },
        );

        registerSpecialAction({
            key: "SchedulerPanel",
            allowed: () => AuthClient.isPermissionAuthorized(SchedulerPermission.ViewSchedulerPanel),
            onClick: () => Promise.resolve("/scheduler/view"),
        });

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
            // `avoidNotifyPendingRequests`: the panel polls twice a second and must not make the
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
