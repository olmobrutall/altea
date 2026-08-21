import * as React from "react";
import { Popover, OverlayTrigger } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useAPI } from "@altea/altea/client/Hooks";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import type { Lite } from "@altea/altea/data/lite";
import type { UserEntity } from "@altea/altea-auth/data/User";
import { RemoteEmailsClient } from "./RemoteEmailsClient";
import { RemoteEmailRenderer } from "./RemoteEmailMessage";

// Port of Signum.Mailing.MicrosoftGraph/RemoteEmails' RemoteEmailPopover.tsx — the envelope icon in the
// Subject cell, which on hover previews the whole message body without leaving the search page.
//
// altea divergence: the mailbox is addressed by the USER's own lite id (the routes resolve the directory
// object id server-side), where Signum reads `UserLiteModel.externalId`.
export default function RemoteEmailPopover(p: {
    subject: string;
    user: Lite<UserEntity>;
    remoteEmailId: string;
    isRead: boolean;
}): React.JSX.Element {

    const [show, setShow] = React.useState(false);
    const ref = React.useRef(null);

    const popover = (
        <Popover id="remote-email-popover" style={{ "--bs-popover-max-width": "unset" } as React.CSSProperties}
            onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
            <Popover.Header as="h3">{p.subject}</Popover.Header>
            <Popover.Body>
                <RemoteEmailSnippet user={p.user} remoteEmailId={p.remoteEmailId} />
            </Popover.Body>
        </Popover>
    );

    return (
        <OverlayTrigger show={show} placement="right" overlay={popover}>
            <span ref={ref} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
                <FontAwesomeIcon aria-hidden={true} className="me-1"
                    icon={p.isRead ? ["far", "envelope-open"] : ["far", "envelope"]} />
            </span>
        </OverlayTrigger>
    );
}

export function RemoteEmailSnippet(p: { user: Lite<UserEntity>; remoteEmailId: string }): React.JSX.Element {

    const email = useAPI(() => RemoteEmailsClient.API.getRemoteEmail(p.user.id!, p.remoteEmailId),
        [p.user, p.remoteEmailId]);

    return (
        <div style={{ minWidth: "500px" }}>
            {email == undefined
                ? <span>{JavascriptMessage.loading.niceToString()}</span>
                : <RemoteEmailRenderer remoteEmail={email} />}
        </div>
    );
}
