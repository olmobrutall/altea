import * as React from "react";
import { Overlay, Tooltip } from "react-bootstrap";
import { useInterval } from "@altea/altea/client/Hooks";
import { FrameMessage } from "@altea/altea/data/uiMessages";
import { HelpMessage } from "../../data/Help";

// Port of Signum.Help's `Shortcut` (declared inside TypeHelpPage.tsx). It shows the `[t:Order]` LINK TOKEN
// for whatever the reader is looking at, and copies it on click — which is how a description gets a
// cross-link without anybody memorising the syntax. It lives in its own file here because four pages use
// it, and importing a page for a helper drags that page's chunk in.
//
// One real fix over Signum's: it calls `useRef` / `useState` / `useInterval` AFTER an early `return` for
// the no-clipboard case, so the hook order changes with the environment. The check moves below the hooks.
export function Shortcut(p: { text: string }): React.JSX.Element {

    const linkRef = React.useRef<HTMLElement>(null);
    const [showTooltip, setShowTooltip] = React.useState(false);
    const elapsed = useInterval(showTooltip ? 1000 : null, 0, d => d + 1);

    React.useEffect(() => {
        setShowTooltip(false);
    }, [elapsed]);

    const supportsClipboard = Boolean(navigator.clipboard) && window.isSecureContext;

    if (!supportsClipboard)
        return <code className="shortcut">{p.text}</code>;

    function handleCopy(e: React.MouseEvent<HTMLElement>): void {
        e.preventDefault();
        navigator.clipboard.writeText(p.text).then(() => setShowTooltip(true));
    }

    return (
        <span>
            <code className="shortcut" ref={linkRef} onClick={handleCopy} title={HelpMessage.CopyLinkToken.niceToString()}>
                {p.text}
            </code>
            <Overlay target={linkRef.current} show={showTooltip} placement="bottom">
                <Tooltip>{FrameMessage.Copied.niceToString()}</Tooltip>
            </Overlay>
        </span>
    );
}

/** Signum's `useHash` — re-render when the URL fragment changes, so a `#p-shipDate` jump highlights. */
export function useHash(): string | undefined {
    const [hash, setHash] = React.useState<string | undefined>(() => window.location.hash.tryAfter("#"));

    React.useEffect(() => {
        const onChange = (): void => setHash(window.location.hash.tryAfter("#"));
        window.addEventListener("hashchange", onChange);
        return () => window.removeEventListener("hashchange", onChange);
    }, []);

    return hash;
}
