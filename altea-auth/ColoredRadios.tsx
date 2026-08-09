import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import { classes } from "@altea/altea/data/globals";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { AuthAdminMessage } from "./AuthMessages.data";

// Port of Signum's ColoredRadios (Rules/ColoredRadios.tsx): the coloured circle "radio" used by the
// rule-pack controls (green Write / orange Read / red None), plus the gray override checkbox. The
// AuthAdmin.css classes (sf-auth-chooser / sf-auth-checkbox / sf-not-allowed) are inlined as minimal
// styles here rather than a separate stylesheet.

interface ColorRadioProps {
    checked: boolean;
    readOnly: boolean;
    onClicked: (e: React.MouseEvent<HTMLAnchorElement>) => void;
    color: string;
    title?: string;
    icon?: IconProp;
}

export function ColorRadio(p: ColorRadioProps): React.JSX.Element {
    return (
        <LinkButton
            title={p.title}
            role="radio"
            onClick={e => { if (!p.readOnly) p.onClicked(e); }}
            className={classes("sf-auth-chooser", p.readOnly && "sf-not-allowed")}
            style={{ color: p.checked ? p.color : "var(--bs-secondary-color)", cursor: p.readOnly ? "not-allowed" : "pointer", fontSize: "1.1rem", textDecoration: "none" }}>
            <FontAwesomeIcon aria-hidden={true} icon={p.icon ?? ["far", (p.checked ? "circle-dot" : "circle")]} />
        </LinkButton>
    );
}

export function GrayCheckbox(p: { checked: boolean; onUnchecked: () => void; readOnly: boolean }): React.JSX.Element {
    return (
        <span
            className={classes("sf-auth-checkbox", p.readOnly && "sf-not-allowed")}
            role="checkbox"
            aria-checked={p.checked}
            style={{ color: "var(--bs-secondary-color)", cursor: p.checked && !p.readOnly ? "pointer" : "default" }}
            onClick={p.checked && !p.readOnly ? p.onUnchecked : undefined}>
            <FontAwesomeIcon role="img" icon={["far", p.checked ? "square-check" : "square"]}
                title={p.checked ? AuthAdminMessage.Uncheck.niceToString() : AuthAdminMessage.Check.niceToString()} />
        </span>
    );
}
