import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import { Entity } from "@altea/altea/data/entity";
import { EntityControlMessage } from "@altea/altea/data/uiMessages";
import type { AjaxOptions } from "@altea/altea/client/Services";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { LineBaseController, type LineBaseProps, useController } from "@altea/altea/client/Lines/LineBase";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { FileEntity, FileEmbedded, FilePathEmbedded, FileMessage } from "../../data/Files";
import type { FileTypeSymbol } from "../../data/Files";
import { FileUploader } from "./FileUploader";
import { FileImage } from "./FileImage";
import { ImageModal } from "./ImageModal";
import { memberPath, rootEntity } from "./FileLine";
import "./Files.css";

// Port of Signum.Files' Components/FileImageLine.tsx — see docs/port/Files.md.
//
// FileLine for an IMAGE: the uploader while the field is empty, and once it holds a file a THUMBNAIL
// (click → ImageModal) with the remove button floating over it. Structurally FileLine with an <img>
// instead of a downloader.
//
// Pass `fileType` explicitly: there is no per-property file-type metadata to default it from.

export interface FileImageLineProps<V extends FilePathEmbedded | FileEmbedded | FileEntity | null> extends LineBaseProps<V> {
    /** The store a NEW FilePathEmbedded goes to (required for FilePathEmbedded, ignored for FileEmbedded). */
    fileType?: FileTypeSymbol;
    /** The entity that holds this field — the image needs it to fetch a file that is already stored. */
    containerEntity?: Entity;
    accept?: string;
    maxSizeInBytes?: number | null;
    dragAndDrop?: boolean;
    dragAndDropMessage?: string;
    remove?: boolean;
    imageHtmlAttributes?: React.ImgHTMLAttributes<HTMLImageElement>;
    ajaxOptions?: Omit<AjaxOptions, "url">;
    onFileLoaded?: (file: FilePathEmbedded | FileEmbedded | FileEntity) => void;
}

export class FileImageLineController<V extends FilePathEmbedded | FileEmbedded | FileEntity | null>
    extends LineBaseController<FileImageLineProps<V>, V> {

    override getDefaultProps(p: FileImageLineProps<V>): void {
        super.getDefaultProps(p);
        p.accept = "image/*";
        p.dragAndDrop = true;
    }

    /** Which file holder this member is bound to — decides what the uploader builds (as in FileLine). */
    kind(): "FilePathEmbedded" | "FileEmbedded" | "FileEntity" {
        // One case per file shape, keyed on the bound member's own type — FileLine's same switch, and
        // for its reason: a two-way default sent a FileEntity (which this line already declares it
        // accepts) to the uploader as a FilePathEmbedded, looking for a store a row-held file has no
        // need of.
        switch (this.props.ctx.memberType?.getTypeName()) {
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

export function FileImageLine<V extends FilePathEmbedded | FileEmbedded | FileEntity | null>(props: FileImageLineProps<V>): React.JSX.Element | null {
    const c = useController<FileImageLineController<V>, FileImageLineProps<V>, V>(FileImageLineController, props);
    const p = c.props;

    if (c.isHidden)
        return null;

    const file = p.ctx.value;
    const container = c.container();
    const propertyRoute = memberPath(p.ctx.propertyRoute?.toString());

    function handleRemove(e: React.MouseEvent<unknown>): void {
        e.preventDefault();
        c.setValue(null as V);
    }

    // A "Basic" form group stacks the label above, so the thumbnail becomes a block.
    const display = p.ctx.formGroupStyle === "Basic" ? "block" : undefined;

    const image =
        file == null ? null :
            <FileImage file={file}
                containerEntity={container}
                propertyRoute={propertyRoute}
                ajaxOptions={p.ajaxOptions}
                style={{ maxWidth: "100px", display }}
                onClick={e => ImageModal.show({ file, containerEntity: container, propertyRoute }, e)}
                {...p.imageHtmlAttributes} />;

    const removable = (p.remove ?? true) && !p.ctx.readOnly;

    return (
        <FormGroup ctx={p.ctx} label={p.label} helpText={typeof p.helpText === "function" ? p.helpText(c) : p.helpText}
            htmlAttributes={{ ...c.errorAttributes() }}>
            {() => file == null
                ? (p.ctx.readOnly ? null :
                    <FileUploader
                        kind={c.kind()}
                        fileType={p.fileType}
                        accept={p.accept}
                        maxSizeInBytes={p.maxSizeInBytes}
                        dragAndDrop={p.dragAndDrop}
                        dragAndDropMessage={p.dragAndDropMessage}
                        fileDropCssClass={c.mandatoryClass ?? undefined}
                        divHtmlAttributes={{ className: "sf-file-line-new" }}
                        onFileLoaded={f => {
                            c.setValue(f as V);
                            p.onFileLoaded?.(f);
                        }} />)
                : !removable ? image :
                    <div className={classes("sf-file-image-container", c.getErrorClass())}>
                        <LinkButton className="sf-line-button sf-remove" onClick={handleRemove}
                            title={p.ctx.titleLabels ? EntityControlMessage.Remove.niceToString() : FileMessage.RemoveFile.niceToString()}>
                            <FontAwesomeIcon icon="xmark" />
                        </LinkButton>
                        {image}
                    </div>}
        </FormGroup>
    );
}
