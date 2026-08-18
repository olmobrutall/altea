import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import { Entity } from "@altea/altea/data/entity";
import { EntityControlMessage } from "@altea/altea/data/uiMessages";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { LineBaseController, type LineBaseProps, useController } from "@altea/altea/client/Lines/LineBase";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { FileEmbedded, FilePathEmbedded, FileMessage } from "../../data/Files";
import type { FileTypeSymbol } from "../../data/Files";
import { FileDownloader, type DownloadBehaviour } from "./FileDownloader";
import { FileUploader } from "./FileUploader";
import "./Files.css";

// Port of Signum.Files' Components/FileLine.tsx — the line for ONE file field: the uploader while the field is
// empty, the downloader (+ a remove button) once it holds a file.
//
// altea divergences:
//  - Signum's FileLine is generic over its four file types (FileEntity / FilePathEntity / FileEmbedded /
//    FilePathEmbedded) and creates the entity through its EntityBase machinery. altea ports the two EMBEDDED
//    types, so the line is a plain LineBase over `FilePathEmbedded | FileEmbedded | null` and the uploader
//    builds the value directly (`kind` is read off the bound member type).
//  - Signum uploads to the server as a separate step; here the picked bytes ride the entity's own save (see
//    FileUploader), so there is no progress bar / temporary file state.
//  - Signum's sibling lines live next door: MultiFileLine (a collection of files) and FileImageLine (the same
//    single file rendered as a thumbnail). MultiFileImageLine is NOT ported — it is the mechanical
//    combination of those two, and nothing needs it yet.

export interface FileLineProps<V extends FilePathEmbedded | FileEmbedded | null> extends LineBaseProps<V> {
    /** The store a NEW FilePathEmbedded goes to (required for FilePathEmbedded, ignored for FileEmbedded). */
    fileType?: FileTypeSymbol;
    /** The entity that holds this field — the downloader needs it to build the file's URL. */
    containerEntity?: Entity;
    accept?: string;
    maxSizeInBytes?: number | null;
    dragAndDrop?: boolean;
    download?: DownloadBehaviour;
    showFileIcon?: boolean;
    remove?: boolean;
    onFileLoaded?: (file: FilePathEmbedded | FileEmbedded) => void;
}

export class FileLineController<V extends FilePathEmbedded | FileEmbedded | null>
    extends LineBaseController<FileLineProps<V>, V> {

    /** Which file holder this member is bound to — decides what the uploader builds. */
    kind(): "FilePathEmbedded" | "FileEmbedded" {
        const typeName = this.props.ctx.memberType?.getTypeName();
        return typeName === "FileEmbedded" ? "FileEmbedded" : "FilePathEmbedded";
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

export function FileLine<V extends FilePathEmbedded | FileEmbedded | null>(props: FileLineProps<V>): React.JSX.Element | null {
    const c = useController<FileLineController<V>, FileLineProps<V>, V>(FileLineController, props);
    const p = c.props;

    if (c.isHidden)
        return null;

    const file = p.ctx.value;

    function handleRemove(e: React.MouseEvent<unknown>): void {
        e.preventDefault();
        c.setValue(null as V);
    }

    return (
        <FormGroup ctx={p.ctx} label={p.label} helpText={typeof p.helpText === "function" ? p.helpText(c) : p.helpText} htmlAttributes={{ ...c.errorAttributes() }}>
            {() => file == null
                ? (p.ctx.readOnly ? null :
                    <FileUploader
                        kind={c.kind()}
                        fileType={p.fileType}
                        accept={p.accept}
                        maxSizeInBytes={p.maxSizeInBytes}
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
