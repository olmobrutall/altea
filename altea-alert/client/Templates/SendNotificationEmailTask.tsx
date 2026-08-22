import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import SearchValueLine from "@altea/altea/client/SearchControl/SearchValueLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { Clock } from "@altea/altea/data/utils/clock";
import {
    AlertEntity, AlertState, SendAlertTypeBehavior, SendNotificationEmailTaskEntity,
} from "../../data/Alert";

// Port of Signum.Alerts' Templates/SendNotificationEmailTask.tsx — the task's settings plus a live count of
// what it WOULD send right now, built from the same filters the task itself runs.
//
// altea divergences:
//  - Signum edits the alert types with `EntityCheckboxList` over an `MList<AlertTypeSymbol>`; altea's
//    collection is @part ROWS (see data/Alert.ts), which EntityCheckboxList does not edit — so it is an
//    EntityTable of one column, the shape every other altea symbol collection uses.
//  - luxon → Temporal for the two derived bounds.
export default function SendNotificationEmailTask(p: { ctx: TypeContext<SendNotificationEmailTaskEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    const forceUpdate = useForceUpdate();

    const maxValue = React.useMemo(() => ctx.value.sendNotificationsOlderThan == null ? null
        : Clock.now.subtract({ minutes: Number(ctx.value.sendNotificationsOlderThan) }),
        [ctx.value.sendNotificationsOlderThan]);

    const minValue = React.useMemo(() => ctx.value.ignoreNotificationsOlderThan == null ? null
        : Clock.now.subtract({ days: Number(ctx.value.ignoreNotificationsOlderThan) }),
        [ctx.value.ignoreNotificationsOlderThan]);

    const byType = ctx.value.sendBehavior !== SendAlertTypeBehavior.All;

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(n => n.sendNotificationsOlderThan)} labelColumns={4} valueColumns={2} onChange={forceUpdate} />
            <AutoLine ctx={ctx.subCtx(n => n.ignoreNotificationsOlderThan)} labelColumns={4} valueColumns={2} onChange={forceUpdate} />
            <AutoLine ctx={ctx.subCtx(n => n.sendBehavior)} labelColumns={4} onChange={forceUpdate} />

            {byType && <EntityTable ctx={ctx.subCtx(n => n.alertTypes)} onChange={forceUpdate} />}

            <SearchValueLine ctx={ctx} findOptions={AlertEntity.findOptions(token => ({
                filterOptions: [
                    token(a => a.state).filter("EqualTo", AlertState.Saved),
                    token(a => a.emailNotificationsSent).filter("EqualTo", false),
                    token(a => a.recipient).filter("DistinctTo", null),
                    maxValue == null ? null : token(a => a.alertDate).filter("LessThan", maxValue),
                    minValue == null ? null : token(a => a.alertDate).filter("GreaterThan", minValue),
                ],
                groupResults: true,
                columnOptions: [
                    token(a => a.recipient),
                ],
                columnOptionsMode: "ReplaceAll",
            }))} />
        </div>
    );
}
