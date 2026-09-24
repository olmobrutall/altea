import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import { Entity } from "@altea/altea/data/entity";
import { EntityControlMessage } from "@altea/altea/data/uiMessages";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { LineBaseController, type LineBaseProps, useController } from "@altea/altea/client/Lines/LineBase";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { FileEntity, FileEmbedded, FilePathEmbedded, FileMessage } from "../../data/Files";
import type { FileTypeSymbol } from "../../data/Files";
import { FileDownloader, type DownloadBehaviour } from "./FileDownloader";
import { FileUploader, uploadOptions } from "./FileUploader";
import "./Files.css";

// Port of Signum.Files' Components/FileLine.tsx — see port/Files.md.
//
// The line for ONE file field: the uploader while the field is empty, the downloader (+ a remove button)
// once it holds a file. A plain LineBase over `FilePathEmbedded | FileEmbedded | FileEntity | null` — the
// uploader builds the value directly, and `kind` is read off the BOUND MEMBER TYPE rather than defaulted,
// so a FileEntity is never handed to the uploader as a store-backed file.
//
// The sibling lines live next door: MultiFileLine (a collection of files) and FileImageLine (the same
// single file rendered as a thumbnail). MultiFileImageLine is not ported.

export interface FileLineProps<V extends FilePathEmbedded | FileEmbedded | FileEntity | null> extends LineBaseProps<V> {
    /** The store a NEW FilePathEmbedded goes to; defaults to the field's `@defaultFileType` (ignored for FileEmbedded). */
    fileType?: FileTypeSymbol;
    /** The entity that holds this field — the downloader needs it to build the file's URL. */
    containerEntity?: Entity;
    accept?: string;
    maxSizeInBytes?: number | null;
    dragAndDrop?: boolean;
    download?: DownloadBehaviour;
    showFileIcon?: boolean;
    remove?: boolean;
    onFileLoaded?: (file: FilePathEmbedded | FileEmbedded | FileEntity) => void;
}

export class FileLineController<V extends FilePathEmbedded | FileEmbedded | FileEntity | null>
    extends LineBaseController<FileLineProps<V>, V> {

    /** Which file holder this member is bound to — decides what the uploader builds. */
    kind(): "FilePathEmbedded" | "FileEmbedded" | "FileEntity" {
        const typeName = this.props.ctx.memberType?.getTypeName();
        // One case per file shape, keyed on the bound member's own type. NOT a two-way default: a
        // FileEntity read as "FilePathEmbedded" would send the uploader looking for a store that a row-held
        // file has no need of.
        switch (typeName) {
            case "FileEmbedded": return "FileEmbedded";
            case "FileEntity": return "FileEntity";
            default: return "FilePathEmbedded";
        }
    }

    /** The root entity the file hangs off — explicit prop, else the context's root entity. */
    container(): Entity | undefined {
        return this.props.containerEntity ?? rootEntity(this.props.ctx);
    }
}

/** The OUTERMOST entity of a context chain — the one a download URL is addressed by (see FilesServer: the
 *  route names the root type + id and walks a member path from there). Shared with MultiFileLine /
 *  FileImageLine. */
export function rootEntity(ctx: TypeContext<unknown>): Entity | undefined {
    let current: TypeContext<unknown> | undefined = ctx;
    let last: Entity | undefined = undefined;
    while (current != null) {
        if (current.value instanceof Entity)
            last = current.value;
        current = current.parent as TypeContext<unknown> | undefined;
    }
    return last;
}

// The member path of a property route — its toString() is "(CleanType).a.b"; the download route (see
// server/FilesServer.server.ts) walks member names only.
export function memberPath(route: string | undefined): string | undefined {
    return route?.replace(/^\([^)]*\)\.?/, "");
}

export function FileLine<V extends FilePathEmbedded | FileEmbedded | FileEntity | null>(props: FileLineProps<V>): React.JSX.Element | null {
    const c = useController<FileLineController<V>, FileLineProps<V>, V>(FileLineController, props);
    const p = c.props;

    if (c.isHidden)
        return null;

    const file = p.ctx.value;

    function handleRemove(e: React.MouseEvent<unknown>): void {
        e.preventDefault();
        c.setValue(null as V);
    }

    const upload = uploadOptions(p, p.ctx.propertyRoute?.fieldInfo);

    return (
        <FormGroup ctx={p.ctx} label={p.label} helpText={typeof p.helpText === "function" ? p.helpText(c) : p.helpText} htmlAttributes={{ ...c.errorAttributes() }}>
            {() => file == null
                ? (p.ctx.readOnly ? null :
                    <FileUploader
                        kind={c.kind()}
                        fileType={upload.fileType}
                        accept={upload.accept}
                        maxSizeInBytes={upload.maxSizeInBytes}
                        dragAndDrop={p.dragAndDrop}
                        fileDropCssClass={c.mandatoryClass ?? undefined}
                        divHtmlAttributes={{ className: "sf-file-line-new" }}
                        onFileLoaded={f => {
                            c.setValue(f as V);
                            p.onFileLoaded?.(f);
                        }} />)
                : (
                    <div className={classes("d-flex align-items-center", c.getErrorClass())}>
                        <FileDownloader
                            file={file}
                            containerEntity={c.container()}
                            propertyRoute={memberPath(p.ctx.propertyRoute?.toString())}
                            download={p.download}
                            showFileIcon={p.showFileIcon} />
                        {(p.remove ?? true) && !p.ctx.readOnly &&
                            <LinkButton className="sf-line-button sf-remove ms-2" onClick={handleRemove}
                                title={p.ctx.titleLabels ? EntityControlMessage.Remove.niceToString() : FileMessage.RemoveFile.niceToString()}>
                                <FontAwesomeIcon icon="xmark" />
                            </LinkButton>}
                    </div>
                )}
        </FormGroup>
    );
}
