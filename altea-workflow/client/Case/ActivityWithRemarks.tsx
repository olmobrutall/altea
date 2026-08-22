import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals/helpers";
import { Operations } from "@altea/altea/client/Operations";
import RemarksModal from "./RemarksModal";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { CaseActivityMessage } from "../../data/CaseActivity";
import type { ActivityWithRemarks } from "../../data/CaseActivity";
import { CaseNotificationEntity, CaseNotificationOperation } from "../../data/CaseNotification";
import InlineCaseTags from "./InlineCaseTags";

// Port of Signum.Workflow's Case/ActivityWithRemarks.tsx — the Inbox's "Activity" cell: the activity's name,
// a personal-remarks button, and the case's tags.
//
// altea divergences: the remarks prompt is a local RemarksModal (altea has no AutoLineModal). Signum also
// shows an ALERT count (a bell linking to the user's alerts on this activity);
// there is no altea counterpart of Signum.Alerts, so the DTO has no `alerts` and the bell is gone. The tags
// arrive empty from the Inbox query (see CaseActivityLogic's header), so InlineCaseTags fetches them.

export default function ActivityWithRemarksComponent(p: { data: ActivityWithRemarks }): React.JSX.Element {

    const [remarks, setRemarks] = React.useState<string | null>(p.data.remarks);

    React.useEffect(() => setRemarks(p.data.remarks), [p.data.remarks]);

    function handleRemarksClick(): void {
        void RemarksModal.show({
            title: CaseNotificationEntity.nicePropertyName(a => a.remarks),
            message: CaseActivityMessage.PersonalRemarksForThisNotification.niceToString(),
            initialValue: remarks,
        }).then(newRemarks => {
            if (newRemarks === undefined)
                return;

            void Operations.API.executeLite(p.data.notification!, CaseNotificationOperation.SetRemarks, newRemarks)
                .then(n => setRemarks((n.entity as CaseNotificationEntity).remarks));
        });
    }

    return (
        <span>
            {p.data.workflowActivity?.toString()}
            &nbsp;
            <LinkButton onClick={handleRemarksClick}
                title={CaseNotificationEntity.nicePropertyName(a => a.remarks)}
                className={classes("case-icon", !remarks && "case-icon-ghost")}>
                <FontAwesomeIcon icon={remarks ? "comment-dots" : ["far", "comment"]} />
            </LinkButton>
            &nbsp;
            <InlineCaseTags case={p.data.case} defaultTags={p.data.tags.length > 0 ? p.data.tags : undefined} wrap />
        </span>
    );
}
