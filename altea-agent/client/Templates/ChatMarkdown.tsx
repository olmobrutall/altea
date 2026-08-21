import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { toAbsoluteUrl } from "@altea/altea/client/AppContext";

// Port of Signum.Agent's Templates/ChatMarkdown.tsx — the markdown renderer, with two overrides that matter:
// a LOCAL link becomes a react-router <Link> (so a `/view/Order/42` answer navigates in-app instead of
// reloading), and a table gets Bootstrap's classes.
//
// altea divergences: Signum's `debugger;` statement in renderLink is dropped, and the same-origin check uses
// `toAbsoluteUrl("~/")`'s resolved origin as it does there.
export default function ChatMarkdown(p: { content: string }): React.JSX.Element {
    return <Markdown remarkPlugins={[remarkGfm]} components={{ a: renderLink, table: renderTable }}>{p.content}</Markdown>;
}

function renderTable({ children, ...props }: React.PropsWithChildren<React.TableHTMLAttributes<HTMLTableElement>>): React.ReactNode {
    return <table className="table table-sm table-bordered" {...props}>{children}</table>;
}

export function renderLink({ href, children, ...props }: React.PropsWithChildren<React.AnchorHTMLAttributes<HTMLAnchorElement>>): React.ReactNode {
    if (href && href.startsWith("/"))
        return <Link to={href}>{children}</Link>;

    const origin = document.location.origin + toAbsoluteUrl("~/");
    if (href && href.startsWith(origin))
        return <Link to={href.substring(origin.length - 1)}>{children}</Link>;

    return (
        <a href={href} target="_blank" rel="noreferrer" {...props}>
            {children} <FontAwesomeIcon icon="external-link" />
        </a>
    );
}
