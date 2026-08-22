import * as React from "react";
import { Navigator } from "@altea/altea/client/Navigator";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { CaseActivityEntity, CaseActivityMessage } from "../../data/CaseActivity";

// Port of Signum.Workflow's Case/CaseFromSenderInfo.tsx — the two banners above a pending activity: who sent
// it and when, and the note they left.
//
// altea divergence: luxon's `toFormat("FFF") (toRelative())` becomes the stored ISO instant's own toString —
// altea has no relative-time formatter yet, and Temporal has none built in.

export default function CaseFromSenderInfo(p: { current: CaseActivityEntity }): React.JSX.Element {

    const prev = Navigator.useFetchInState(p.current.previous);
    const c = p.current;

    return (
        <div>
            {c.previous == null || (prev != null && prev.doneType == null) ? null :
                <div className="alert alert-info case-alert">
                    {prev == null
                        ? JavascriptMessage.loading.niceToString()
                        : CaseActivityMessage.From0On1.niceToString().formatHtml(
                            <strong>{prev.doneBy?.toString()}</strong>,
                            <strong>{prev.doneDate?.toString()}</strong>)}
                </div>}
            {prev?.note &&
                <div className="alert alert-warning case-alert">
                    <strong>{CaseActivityEntity.nicePropertyName(a => a.note)}:</strong>
                    {prev.note.includes("\n") ? "\n" : null}
                    {prev.note}
                </div>}
        </div>
    );
}
