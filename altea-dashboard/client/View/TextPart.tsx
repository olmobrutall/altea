import * as React from "react";
import Markdown from "react-markdown";
import { Enum } from "@altea/altea/data/enum";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { TextPartEntity, TextPartTypeEnum } from "../../data/Parts";
import { DashboardClient, type PanelPartContentProps } from "../DashboardClient";
import HtmlViewer from "./HtmlViewer";

// Port of Signum's Signum.Dashboard/View/TextPart.tsx — renders the part's text as plain text, markdown or
// HTML, after substituting the `$Variable$` placeholders from DashboardClient.GlobalVariables.
//
// altea divergences: `translated(…)` is not ported (the raw stored text is used) and HTML renders through the
// local HtmlViewer (Signum.HtmlEditor is not ported). Markdown still uses react-markdown, as Signum does.

export default function TextPart(p: PanelPartContentProps<TextPartEntity>): React.JSX.Element {
    const forceUpdate = useForceUpdate();

    React.useEffect(() => {
        if (p.content.textContent) {
            p.content.textContent = p.content.textContent.replace(/\$(\w+)\$/g, (_, key: string) =>
                DashboardClient.GlobalVariables.get(key)?.() ?? `$${key}$`); // Keep it as-is if not found
            forceUpdate();
        }
    }, []);

    const type = Enum.toName(TextPartTypeEnum, p.content.textPartType);

    return (
        <div>
            <div className="row">
                <div className="col-sm-12">
                    {type == "Markdown" ? <Markdown components={{ a: LinkRenderer }}>{p.content.textContent}</Markdown> :
                        type == "HTML" && p.content.textContent != null ? <HtmlViewer text={p.content.textContent} /> :
                            <span>{p.content.textContent}</span>}
                </div>
            </div>
        </div>
    );
}

function LinkRenderer(props: React.AnchorHTMLAttributes<HTMLAnchorElement>): React.JSX.Element {
    return (
        <a href={props.href} target="_blank" rel="noreferrer">
            {props.children}
        </a>
    );
}
