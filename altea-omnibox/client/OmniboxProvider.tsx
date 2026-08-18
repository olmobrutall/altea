import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import type { OmniboxMatch, OmniboxResult } from "../data/OmniboxResults";

// Port of Signum's `OmniboxProvider<T>` (Signum.Omnibox/OmniboxProvider.tsx): the renderer half of one
// omnibox result SHAPE. The server produces `{ resultTypeName, … }` rows; the client registry
// (OmniboxClient.providers) maps each `resultTypeName` to one of these.
//
// A provider answers four questions about its results: how to draw the row, where to go on Enter, what
// text to put back in the input on Tab, and which icon identifies it.
export abstract class OmniboxProvider<T extends OmniboxResult> {
    abstract getProviderName(): string;
    abstract renderItem(result: T): React.ReactNode[];
    abstract navigateTo(result: T): Promise<string | undefined> | undefined;
    abstract toString(result: T): string;
    abstract icon(): React.ReactNode;

    // Signum's renderMatch: walk the '#' runs of the bold mask and emit <strong> for the matched
    // characters, <span> for the rest — so the user sees exactly which letters their pattern hit.
    renderMatch(match: OmniboxMatch, array: React.ReactNode[]): void {

        const regex = /#+/g;

        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(match.boldMask)) != null) {
            if (m.index > last)
                array.push(<span>{match.text.substring(last, m.index)}</span>);

            array.push(<strong>{match.text.substring(m.index, m.index + m[0].length)}</strong>);

            last = m.index + m[0].length;
        }

        if (last < match.text.length)
            array.push(<span>{match.text.substring(last)}</span>);
    }

    coloredSpan(text: string | undefined, colorName: string): React.ReactElement {
        return <span style={{ color: colorName, lineHeight: "1.6em" }}>{text}</span>;
    }

    coloredIcon(icon: IconProp, color: string): React.ReactElement {
        return <FontAwesomeIcon aria-hidden={true} icon={icon} color={color} className="icon" />;
    }
}
