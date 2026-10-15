import * as React from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@altea/altea/client/ui/Tooltip";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useAPI } from "@altea/altea/client/Hooks";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import type { Lite } from "@altea/altea/data/lite";
import type { UserEntity } from "@altea/altea-auth/data/User";
import { RemoteEmailsClient } from "./RemoteEmailsClient";
import { RemoteEmailRenderer } from "./RemoteEmailMessage";

// The envelope icon in the Subject cell, which on hover previews the whole message body without leaving
// the search page. The mailbox is addressed by the USER's own lite id — the routes resolve the directory
// object id server-side.
export default function RemoteEmailPopover(p: {
    subject: string;
    user: Lite<UserEntity>;
    remoteEmailId: string;
    isRead: boolean;
}): React.JSX.Element {

    const [show, setShow] = React.useState(false);

    // Opened by hover, not by a click: the icon is only an anchor, and the popup keeps itself open while
    // the pointer is over it.
    return (
        <Popover open={show}>
            <PopoverAnchor>
                <span onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
                    <FontAwesomeIcon aria-hidden={true} className="me-1"
                        icon={p.isRead ? ["far", "envelope-open"] : ["far", "envelope"]} />
                </span>
            </PopoverAnchor>
            <PopoverContent id="remote-email-popover" side="right" autoFocus={false} className="max-w-none" title={p.subject}
                onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
                <RemoteEmailSnippet user={p.user} remoteEmailId={p.remoteEmailId} />
            </PopoverContent>
        </Popover>
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
