import * as React from "react";
import { Modal } from "react-bootstrap";
import type { Entity } from "@altea/altea/data/entity";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import { ajaxGetRaw } from "@altea/altea/client/Services";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { FileEmbedded, FilePathEmbedded } from "../../data/Files";
import { FilesClient } from "../FilesClient";
import { FileImage } from "./FileImage";
import "./Files.css";

// Port of Signum.Files' Components/ImageModal.tsx — the full-size view of an image behind a thumbnail
// (FileImageLine). Ctrl-click / middle-click opens it in a new tab instead of the modal, like Signum.
//
// altea divergences: the file is one of the two EMBEDDED holders, and its URL comes from
// `FilesClient.fileUrl` (Signum resolved one from its per-type `configurations` registry) — so the new-tab
// path carries the same optional owner + route fallback the other file components take; and the modal has a
// close button in the header only (Signum's markup, minus its `data-dismiss` leftover from Bootstrap 4).

export interface ImageModalProps extends IModalProps<undefined> {
    file: FilePathEmbedded | FileEmbedded;
    containerEntity?: Entity;
    propertyRoute?: string;
    rowId?: string | number;
    title?: string;
    imageHtmlAttributes?: React.ImgHTMLAttributes<HTMLImageElement>;
}

export function ImageModal(p: ImageModalProps): React.JSX.Element {

    const [show, setShow] = React.useState(true);

    return (
        <Modal onHide={() => setShow(false)} show={show} className="message-modal" size="xl"
            onExited={() => p.onExited!(undefined)}>
            <div className="modal-header">
                <h1 className="modal-title h4">
                    {p.title ?? p.file.fileName}
                </h1>
                <button type="button" className="btn-close" aria-label={JavascriptMessage.Close.niceToString()}
                    onClick={() => setShow(false)} />
            </div>
            <div className="modal-body">
                <FileImage file={p.file}
                    containerEntity={p.containerEntity}
                    propertyRoute={p.propertyRoute}
                    rowId={p.rowId}
                    style={{ maxWidth: "100%", marginLeft: "auto", marginRight: "auto", display: "block" }}
                    {...p.imageHtmlAttributes} />
            </div>
        </Modal>
    );
}

export namespace ImageModal {
    export function show(
        p: Omit<ImageModalProps, "onExited">,
        event: React.MouseEvent<HTMLImageElement>,
    ): void {
        // Ctrl-click / middle-click: hand the image to a new tab. The window has to be opened SYNCHRONOUSLY
        // (inside the click) or the popup blocker kills it; the bytes are written into it once fetched.
        if (event.ctrlKey || event.button === 1) {
            const win = window.open("");
            if (win == null)
                return;

            const url = FilesClient.fileUrl(p.file, p.containerEntity, p.propertyRoute, p.rowId);
            if (url == null)
                return;

            void ajaxGetRaw({ url, cache: "default" })
                .then(resp => resp.blob())
                .then(blob => {
                    const image = new Image();
                    image.src = URL.createObjectURL(blob);
                    win.document.title = document.title;
                    win.document.body.appendChild(image);
                });

            return;
        }

        void openModal(<ImageModal {...p} />);
    }
}
