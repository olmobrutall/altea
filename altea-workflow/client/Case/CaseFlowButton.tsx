import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Navigator } from "@altea/altea/client/Navigator";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { WorkflowActivityMessage } from "../../data/WorkflowNodes";
import type { CaseActivityEntity } from "../../data/CaseActivity";

// Port of Signum.Workflow's Case/CaseFlowButton.tsx — opens the CASE (whose view is the flow diagram),
// pointing it at the activity we came from. Verbatim.

export default function CaseFlowButton(p: { caseActivity: CaseActivityEntity }): React.JSX.Element {
    return (
        <LinkButton title={undefined} className="btn btn-info btn-xs px-2"
            onClick={() => void Navigator.view(p.caseActivity.case, { extraProps: { caseActivity: p.caseActivity } })}>
            <FontAwesomeIcon icon="shuffle" color="green" /> {WorkflowActivityMessage.CaseFlow.niceToString()}
        </LinkButton>
    );
}
