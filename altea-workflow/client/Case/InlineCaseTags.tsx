import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals/helpers";
import { Navigator } from "@altea/altea/client/Navigator";
import { Operations } from "@altea/altea/client/Operations";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import type { Lite } from "@altea/altea/data/lite";
import { CaseEntity, CaseMessage, CaseOperation, CaseTagsModel, type CaseTagTypeEntity } from "../../data/Case";
import { WorkflowClient } from "../WorkflowClient";
import Tag from "./Tag";
import "./Tag.css";

// Port of Signum.Workflow's Case/InlineCaseTags.tsx — the tag chips beside a case, and the dialog that edits
// them. `defaultTags` short-circuits the fetch; without it the component asks the server, which is the path
// altea's Inbox uses (its query does not project the tags — see CaseActivityLogic's header).

export interface InlineCaseTagsProps {
    case: Lite<CaseEntity>;
    defaultTags?: CaseTagTypeEntity[];
    avoidHideIcon?: boolean;
    wrap?: boolean;
}

export default function InlineCaseTags(p: InlineCaseTagsProps): React.JSX.Element {

    const [tags, setTags] = React.useState<CaseTagTypeEntity[]>(() => p.defaultTags ?? []);

    React.useEffect(() => {
        if (p.defaultTags)
            setTags(p.defaultTags);
        else
            void WorkflowClient.API.fetchCaseTags(p.case).then(t => setTags(t));
    }, [p.case.key(), ...(p.defaultTags ?? [])]);

    function handleTagsClick(): void {
        const model = CaseTagsModel.create({
            caseTags: [...tags],
            oldCaseTags: [...tags],
        });

        void Navigator.view(model, { title: p.case.toString() ?? "" }).then(cm => {
            if (!cm)
                return;

            void Operations.API.executeLite(p.case, CaseOperation.SetTags, cm)
                .then(() => WorkflowClient.API.fetchCaseTags(p.case))
                .then(t => setTags(t));
        });
    }

    return (
        <LinkButton title={undefined} onClick={handleTagsClick}
            className={classes("case-icon", tags.length === 0 && !p.avoidHideIcon && "case-icon-ghost")}
            style={{ flexWrap: p.wrap ? "wrap" : undefined }}>
            {tags.length === 0
                ? <FontAwesomeIcon icon={"tags"} title={CaseMessage.SetTags.niceToString()} />
                : tags.map((t, i) => <Tag key={i} tag={t} />)}
        </LinkButton>
    );
}
