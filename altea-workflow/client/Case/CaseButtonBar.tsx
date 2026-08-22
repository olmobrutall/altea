import * as React from "react";
import { TypeContext } from "@altea/altea/client/TypeContext";
import type { EntityFrame } from "@altea/altea/client/TypeContext";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { ReadonlyBinding } from "@altea/altea/client/binding";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { ButtonBar } from "@altea/altea/client/Frames/ButtonBar";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import type { EntityPack } from "@altea/altea/data/entityPack";
import { CaseActivityEntity, CaseActivityMessage } from "../../data/CaseActivity";
import { WorkflowActivityEntity } from "../../data/WorkflowNodes";

// Port of Signum.Workflow's Case/CaseButtonBar.tsx — the strip UNDER a case activity: its workflow buttons
// (Next / Jump / Undo) plus the note the sender leaves for the next actor, or — once the activity is done —
// who finished it and when. Plus the collapsible per-activity user help.
//
// altea divergence: luxon's formatted + relative done-date becomes the stored instant's own toString.

interface CaseButtonBarProps {
    frame: EntityFrame;
    pack: EntityPack<CaseActivityEntity>;
}

export default function CaseButtonBar(p: CaseButtonBarProps): React.JSX.Element {
    const ca = p.pack.entity;

    if (ca.doneDate != null) {
        return (
            <div className="workflow-buttons">
                {CaseActivityMessage.DoneBy0On1.niceToString().formatHtml(
                    <strong>{ca.doneBy?.toString()}</strong>,
                    <strong>{ca.doneDate.toString()}</strong>)}
            </div>
        );
    }

    const ctx = new TypeContext<CaseActivityEntity>(undefined, undefined,
        PropertyRoute.root(CaseActivityEntity), new ReadonlyBinding(ca, "act"));

    const userHelp = (ca.workflowActivity as WorkflowActivityEntity).userHelp;

    return (
        <div>
            <div className="workflow-buttons">
                <ButtonBar frame={p.frame} pack={p.pack} />
                <AutoLine ctx={ctx.subCtx(a => a.note)} formGroupStyle="None" placeholderLabels={true} />
            </div>
            {userHelp && <UserHelpComponent userHelp={userHelp} />}
        </div>
    );
}

export function UserHelpComponent(p: { userHelp: string }): React.JSX.Element {

    const [open, setOpen] = React.useState(false);

    return (
        <div style={{ marginTop: "10px" }}>
            <LinkButton title={undefined} onClick={() => setOpen(!open)} className="case-help-button">
                {open ? CaseActivityMessage.HideHelp.niceToString() : CaseActivityMessage.ShowHelp.niceToString()}
            </LinkButton>
            {open && <div dangerouslySetInnerHTML={{ __html: p.userHelp }} />}
        </div>
    );
}
