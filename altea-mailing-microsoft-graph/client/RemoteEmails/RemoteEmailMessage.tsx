import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityStrip } from "@altea/altea/client/Lines/EntityStrip";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { saveFile } from "@altea/altea/client/Services";
import IFrameRenderer from "@altea/altea-email/client/Templates/IframeRenderer";
import { RemoteAttachmentEmbedded, type RemoteEmailMessageModel } from "../../data/RemoteEmailMessage";
import { RemoteEmailsClient } from "./RemoteEmailsClient";

// Port of Signum.Mailing.MicrosoftGraph/RemoteEmails' RemoteEmailMessage.tsx — the read-only view of ONE
// remote message: who it is from and to, its categories, its (non-inline) attachments, and the body.
//
// altea divergences, documented inline:
//  - `FilesClient.extensionInfo[…]` (an icon + colour per file extension) is not part of altea's files port,
//    so an attachment gets one generic file icon. Noted rather than reinvented.
//  - The inline images are the interesting difference. Signum rewrites each `cid:` reference to the
//    attachment route's URL and lets the browser fetch it, which needs that route to be ANONYMOUS. altea
//    authenticates with a Bearer token, which an `<img src>` cannot carry, so the bytes are fetched through
//    the app's own ajax and turned into blob URLs — the same thing altea-files' FileImage does — and the
//    route stays authenticated (see RemoteEmailsServer's header).
//  - `ctx.value.user.model as UserLiteModel).externalId` is gone: the routes take the USER's own id.
//  - Signum shows the categories in a `<MultiValueLine/>`; altea's takes `R extends BaseEntity` (its
//    scalar-collection line is not ported), and this view is read-only anyway — so they are rendered as
//    plain text under the field's own label.
export default function RemoteEmailMessage(p: { ctx: TypeContext<RemoteEmailMessageModel> }): React.JSX.Element {
    const ctx = p.ctx.subCtx({ readOnly: true });

    return (
        <div>
            <div className="row mb-3">
                <div className="col-sm-2">
                    <FontAwesomeIcon icon={["far", "envelope"]} style={{
                        color: "#d6d6d6",
                        transform: "translate(-23px, -22px) rotate(12deg)",
                        fontSize: "100px",
                        position: "absolute",
                    }} />
                </div>
                <div className="col-sm-4" />
                <div className="col-sm-6">
                    <EntityLine ctx={ctx.subCtx(f => f.user)} labelColumns={3}
                        helpText={ctx.value.webLink == null ? undefined
                            : <a href={ctx.value.webLink} target="_blank" rel="noreferrer">Outlook Web</a>} />
                </div>
            </div>

            <div className="row mb-3">
                <div className="col-sm-8">
                    <EntityLine ctx={ctx.subCtx(f => f.from)} labelColumns={3} />
                    <EntityStrip ctx={ctx.subCtx(f => f.toRecipients)} labelColumns={3} />
                    <EntityStrip ctx={ctx.subCtx(f => f.ccRecipients)} labelColumns={3} hideIfNull />
                    <EntityStrip ctx={ctx.subCtx(f => f.bccRecipients)} labelColumns={3} hideIfNull />
                </div>
                <div className="col-sm-4">
                    <AutoLine ctx={ctx.subCtx(f => f.sentDateTime)} labelColumns={6} />
                    <AutoLine ctx={ctx.subCtx(f => f.receivedDateTime)} labelColumns={6} />
                    <CategoriesLine ctx={ctx} />
                </div>
            </div>

            {ctx.value.attachments.some(a => !a.isInline) &&
                <EntityStrip ctx={ctx.subCtx(f => f.attachments)}
                    filterRows={(ctxs: TypeContext<RemoteAttachmentEmbedded>[]) => ctxs.filter(a => !a.value.isInline)}
                    onRenderItem={(item: RemoteAttachmentEmbedded) => (
                        <span>
                            <FontAwesomeIcon className="me-1" icon="file" color="grey" />
                            {item.toString()}
                        </span>
                    )}
                    onView={async (item: RemoteAttachmentEmbedded) => {
                        const response = await RemoteEmailsClient.API.getRemoteAttachment(
                            ctx.value.user.id!, ctx.value.id, item.id);
                        await saveFile(response);
                        return undefined;
                    }}
                />}

            <AutoLine ctx={ctx.subCtx(f => f.subject)} />

            {ctx.value.isBodyHtml
                ? <RemoteEmailRenderer remoteEmail={ctx.value} />
                : <pre>{ctx.value.body}</pre>}
        </div>
    );
}

/** The message's Outlook categories (see the header on why this is not a MultiValueLine). */
function CategoriesLine(p: { ctx: TypeContext<RemoteEmailMessageModel> }): React.JSX.Element {
    const ctx = p.ctx;

    return (
        <div className={ctx.formGroupClass}>
            <label className="col-form-label col-sm-3">{ctx.niceName(a => a.categories)}</label>
            <div className="col-sm-9">
                <span className="form-control-plaintext">{ctx.value.categories.join(", ")}</span>
            </div>
        </div>
    );
}

/** The body, in an iframe, with links opening in a new tab and `cid:` images resolved (see the header). */
export function RemoteEmailRenderer(p: { remoteEmail: RemoteEmailMessageModel }): React.JSX.Element {

    // Blob URLs created for the inline images, revoked when the message goes away.
    const blobUrls = React.useRef<string[]>([]);
    React.useEffect(() => () => {
        blobUrls.current.forEach(u => URL.revokeObjectURL(u));
        blobUrls.current = [];
    }, [p.remoteEmail.id]);

    function manipulateDom(doc: Document): void {
        doc.body.querySelectorAll("a").forEach(a => a.target = "_blank");

        doc.body.querySelectorAll("img").forEach(img => {
            const src = img.getAttribute("src");
            if (src == null || !src.startsWith("cid:"))
                return;

            const contentId = src.substring("cid:".length);
            // Signum also matches the part before "@": some clients append a domain to the content id.
            const bare = contentId.includes("@") ? contentId.substring(0, contentId.indexOf("@")) : null;

            const attachment = p.remoteEmail.attachments.find(a =>
                a.contentId === contentId || (bare != null && a.contentId === bare));

            if (attachment == null)
                return;

            void RemoteEmailsClient.API.getRemoteAttachment(p.remoteEmail.user.id!, p.remoteEmail.id, attachment.id)
                .then(async response => {
                    const url = URL.createObjectURL(await response.blob());
                    blobUrls.current.push(url);
                    img.src = url;
                });
        });
    }

    return <IFrameRenderer style={{ width: "100%", height: "800px" }}
        html={p.remoteEmail.body} manipulateDom={manipulateDom} />;
}
