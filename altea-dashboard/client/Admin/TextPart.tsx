import * as React from "react";
import Markdown from "react-markdown";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { TextAreaLine } from "@altea/altea/client/Lines/TextAreaLine";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { Enum } from "@altea/altea/data/enum";
import { TextPartEntity, TextPartTypeEnum } from "../../data/Parts";
import type { PartEditorProps } from "./PartEditor";
import HtmlViewer from "../View/HtmlViewer";

// Port of Signum's Signum.Dashboard/Admin/TextPart.tsx — pick the text kind and edit the content, with a
// preview toggle for markdown.
//
// altea divergence: HTML is edited as raw text in a TextAreaLine (Signum used its HtmlEditor, not ported) and
// previewed through the local HtmlViewer.

export default function TextPart(p: PartEditorProps<TextPartEntity>): React.JSX.Element {
    const ctx = p.ctx.subCtx(p.smallMode ? { formGroupStyle: "Basic" } : { formGroupStyle: "SrOnly", placeholderLabels: true });
    const forceUpdate = useForceUpdate();

    const type = Enum.toName(TextPartTypeEnum, p.ctx.value.textPartType);

    const [isPreview, setIsPreview] = React.useState(false);
    React.useEffect(() => {
        setIsPreview(!p.ctx.value.isNew && type == "Markdown");
    }, [p.ctx.value]);

    function editor(): React.JSX.Element {
        return <TextAreaLine ctx={ctx.subCtx(s => s.textContent)} />;
    }

    function preview(): React.JSX.Element {
        if (type == "Markdown")
            return <Markdown>{ctx.value.textContent}</Markdown>;

        if (type == "HTML" && ctx.value.textContent != null)
            return <HtmlViewer text={ctx.value.textContent} />;

        return <span>{ctx.value.textContent}</span>;
    }

    return (
        <div>
            <div className="row">
                <div className={p.smallMode ? "col-12" : "col-sm-4"}>
                    <AutoLine ctx={ctx.subCtx(s => s.textPartType)} onChange={() => forceUpdate()} />
                </div>
                <div className={p.smallMode ? "col-12" : "col-sm-4"}>
                    {type == "Markdown" || type == "HTML" ?
                        <LinkButton title={undefined} onClick={() => setIsPreview(!isPreview)}>
                            <FontAwesomeIcon aria-hidden icon={isPreview ? "pen-to-square" : "eye"} className="me-1" />
                            {isPreview ? "Edit" : "Preview"}
                        </LinkButton> : null}
                </div>
            </div>
            <div className="form-inline">
                {isPreview ? preview() : editor()}
            </div>
        </div>
    );
}
