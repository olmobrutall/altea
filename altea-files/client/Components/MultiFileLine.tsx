import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import { BaseEntity, Entity } from "@altea/altea/data/entity";
import { EntityControlMessage } from "@altea/altea/data/uiMessages";
import type { FieldInfo, TypeReference } from "@altea/altea/data/reflection";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { EntityListBaseController, type EntityListBaseProps } from "@altea/altea/client/Lines/EntityListBase";
import { EntityBaseController } from "@altea/altea/client/Lines/EntityBase";
import { useController, genericMemo } from "@altea/altea/client/Lines/LineBase";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { ErrorBoundary } from "@altea/altea/client/Components";
import { FileEmbedded, FileMessage, FilePathEmbedded } from "../../data/Files";
import type { FileTypeSymbol } from "../../data/Files";
import { FileDownloader, type DownloadBehaviour } from "./FileDownloader";
import { FileUploader } from "./FileUploader";
import { memberPath, rootEntity } from "./FileLine";
import "./Files.css";

// Port of Signum.Files' Components/MultiFileLine.tsx — the line for a COLLECTION of files: one downloader per
// element (plus remove / reorder), and an uploader underneath that appends the files the user picks.
//
// altea divergences, documented inline:
//  - In Signum an MList element could BE the file (`MList<FileEmbedded>`), and `getFileFromElement` was the
//    exception for a richer element. altea has no MList: a collection is a plain array of `@part` ROW
//    entities, and a file holder is an EMBEDDED — so the row always WRAPS the file, and the only interesting
//    question is WHICH member holds it. That member is `fileField`, and it DEFAULTS to the row's single
//    file-typed field, so the common case still needs no configuration.
//  - Signum passes that member as a LAMBDA (`getFileFromElement`) and recovers the property route from it with
//    `PropertyRoute.addLambda`. Here it is a member NAME (dots allowed for a nested embedded) because altea's
//    quote-transformer does not rewrite lambdas in JSX attributes — and a name is all the route needs, both to
//    read the value and to build the download URL.
//  - `defaultFileTypeInfo` (Signum ships each property's file type / onlyImages / maxSize in its reflection
//    metadata, so the line can default `fileType` / `accept` / `maxSizeInBytes`) has no altea counterpart:
//    pass `fileType` explicitly, exactly like FileLine.

export interface MultiFileLineProps<R extends BaseEntity> extends EntityListBaseProps<R> {
    /** The ROW member holding the file — a name, dotted for a nested embedded ("attachment.file"). Defaults
     *  to the row type's only FilePathEmbedded / FileEmbedded field (its `@valueField` when that is one). */
    fileField?: string;
    /** How a picked file becomes a row. Defaults to `RowType.create({ <fileField>: file })` — override it
     *  when the row needs more than the file set (Signum's createElementFromFile). */
    createElementFromFile?: (file: FilePathEmbedded | FileEmbedded) => Promise<NoInfer<R> | undefined> | NoInfer<R> | undefined;
    /** The store NEW FilePathEmbedded files go to (required for FilePathEmbedded, ignored for FileEmbedded). */
    fileType?: FileTypeSymbol;
    /** The entity that holds this collection — the downloader needs it to build each file's URL. */
    containerEntity?: Entity;
    accept?: string;
    maxSizeInBytes?: number | null;
    dragAndDrop?: boolean;
    dragAndDropMessage?: string;
    download?: DownloadBehaviour;
    showFileIcon?: boolean;
    /** Keep the uploader visible even when the list is not empty (Signum's forceShowUploader). */
    forceShowUploader?: boolean;
    // (Signum declared `ref?: React.Ref<MultiFileLineController<V>>`. Dropped for the same reason
    // altea-dashboard's EntityGridRepeater drops it: a self-referential `ref` makes useController's props
    // constraint unsatisfiable across the two @types/react resolutions in this workspace.)
}

export class MultiFileLineController<R extends BaseEntity> extends EntityListBaseController<MultiFileLineProps<R>, R> {

    forceShowUploader!: boolean;
    setForceShowUploader!: React.Dispatch<boolean>;

    override init(p: MultiFileLineProps<R>): void {
        super.init(p);
        // Start expanded when there is nothing to show yet — otherwise the line would be an empty box.
        [this.forceShowUploader, this.setForceShowUploader] =
            React.useState<boolean>(() => this.getMListItemContext(p.ctx).length === 0);
    }

    override overrideProps(p: MultiFileLineProps<R>, overridenProps: MultiFileLineProps<R>): void {
        // Signum's rule: a row is worth VIEWING only when the caller said it is more than a file wrapper
        // (i.e. it named the file member itself). A row that is just a file gets no view button.
        p.view = p.view === true && overridenProps.fileField != null;

        super.overrideProps(p, overridenProps);
    }

    /** The member path from the ROW to its file, plus that member's FieldInfo (which file holder it is).
     *  Explicit `fileField` wins; otherwise the row's `@valueField` when it is a file, else its single
     *  file-typed field. */
    fileMember(): { path: string[]; fieldInfo: FieldInfo } {
        const rowType = this.props.ctx.memberType!;

        if (this.props.fileField != null) {
            const path = this.props.fileField.split(".");
            return { path, fieldInfo: resolvePath(rowType, path) };
        }

        const typeInfo = rowType.typeInfo();
        const valueField = typeInfo.valueField;
        if (valueField != null && isFileType(valueField))
            return { path: [valueField.name], fieldInfo: valueField };

        const candidates = Object.values(typeInfo.fields).filter(fi => isFileType(fi));
        if (candidates.length !== 1)
            throw new Error(`MultiFileLine: row type '${rowType.getTypeName()}' has ${candidates.length} file fields`
                + ` — name the one to use with the 'fileField' prop`);

        return { path: [candidates[0].name], fieldInfo: candidates[0] };
    }

    /** Which file holder the rows carry — decides what the uploader builds (FileLine's `kind`). */
    kind(): "FilePathEmbedded" | "FileEmbedded" {
        return this.fileMember().fieldInfo.getTypeName() === "FileEmbedded" ? "FileEmbedded" : "FilePathEmbedded";
    }

    /** Signum's getFileFromElement — the file held by one row. */
    getFileFromElement(row: R): FilePathEmbedded | FileEmbedded | null {
        let current: unknown = row;
        for (const step of this.fileMember().path) {
            if (current == null)
                return null;
            current = (current as Record<string, unknown>)[step];
        }
        return (current ?? null) as FilePathEmbedded | FileEmbedded | null;
    }

    /** Signum's createElementFromFile — wrap a picked file in a new row (cf. MultiValueLine.createRow). */
    async createElementFromFile(file: FilePathEmbedded | FileEmbedded): Promise<R | undefined> {
        if (this.props.createElementFromFile != null)
            return await this.props.createElementFromFile(file);

        const { path } = this.fileMember();
        if (path.length > 1)
            throw new Error("MultiFileLine: a nested 'fileField' cannot be built automatically — pass createElementFromFile");

        const ctor = this.props.ctx.memberType!.getFunction();
        if (ctor == null)
            throw new Error(`MultiFileLine: row type '${this.props.ctx.memberType!.getTypeName()}' is not registered`);

        return (ctor as unknown as { create(values: Record<string, unknown>): R }).create({ [path[0]]: file });
    }

    handleFileLoaded = (file: FilePathEmbedded | FileEmbedded): void => {
        this.setForceShowUploader(false);
        void this.createElementFromFile(file).then(row => row != null && this.addElement(row));
    }

    handleDeleteValue = (index: number): void => {
        const list = this.props.ctx.value;
        list.removeAt(index);
        this.setValue(list);
    }

    /** Signum's renderElementViewButton — the per-row "open it" button (EntityListBase has no such
     *  renderer of its own; every list line draws its own row chrome). */
    renderElementViewButton(btn: boolean, row: R, index: number): React.JSX.Element | undefined {
        if (!this.canView(row))
            return undefined;

        return (
            <LinkButton className={classes("sf-line-button", "sf-view", btn ? "input-group-text" : undefined)}
                onClick={e => void this.handleViewElement(e, index)}
                title={this.props.ctx.titleLabels ? EntityControlMessage.View.niceToString() : undefined}>
                {EntityBaseController.getViewIcon()}
            </LinkButton>
        );
    }

    /** The FALLBACK address for a row whose file the server has not stamped yet (a row just added in this
     *  form): walk member names from the entity holding the collection, using the row's id for the collection
     *  step — "<collection>.<file member>" + rowId. A row that came from the database needs none of this: its
     *  file carries its own routing (rootType = the @part ROW type, entityId = the row's id), which
     *  FilesClient.fileUrl prefers. */
    filePropertyRoute(): string | undefined {
        const collection = memberPath(this.props.ctx.propertyRoute?.toString());
        return collection == null ? undefined : [collection, ...this.fileMember().path].join(".");
    }
}

export const MultiFileLine: <R extends BaseEntity>(props: MultiFileLineProps<R>) => React.ReactNode | null =
    genericMemo(function MultiFileLine<R extends BaseEntity>(props: MultiFileLineProps<R>): React.JSX.Element | null {

        const c = useController<MultiFileLineController<R>, MultiFileLineProps<R>, R[]>(MultiFileLineController, props);
        const p = c.props;

        if (c.isHidden)
            return null;

        const helpText = typeof p.helpText === "function" ? p.helpText(c) : p.helpText;
        const helpTextOnTop = typeof p.helpTextOnTop === "function" ? p.helpTextOnTop(c) : p.helpTextOnTop;

        const ctxs = c.getMListItemContext(p.ctx.subCtx({ formGroupStyle: "None" }));
        const container = p.containerEntity ?? rootEntity(p.ctx);
        const propertyRoute = c.filePropertyRoute();

        return (
            <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon}
                htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }}
                helpText={helpText}
                helpTextOnTop={helpTextOnTop}
                labelHtmlAttributes={p.labelHtmlAttributes}>
                {() => <table className="sf-multi-value">
                    <tbody>
                        {ctxs.map(rowCtx => {
                            const index = rowCtx.index!;
                            const drag = c.canMove(rowCtx.value) && p.moveMode === "DragIcon" && !p.ctx.readOnly
                                ? c.getDragConfig(index, "v") : undefined;
                            const file = c.getFileFromElement(rowCtx.value);

                            return (
                                <ErrorBoundary key={c.keyGenerator.getKey(rowCtx.value)}>
                                    <tr onDragEnter={drag?.onDragOver}
                                        onDragOver={drag?.onDragOver}
                                        onDrop={drag?.onDrop}
                                        className={classes(drag?.dropClass)}>
                                        <td className="item-group">
                                            {drag &&
                                                <LinkButton className={classes("sf-line-button", "sf-move")}
                                                    onClick={e => { e.stopPropagation(); }}
                                                    draggable={true}
                                                    onKeyDown={drag.onKeyDown}
                                                    onDragStart={drag.onDragStart}
                                                    onDragEnd={drag.onDragEnd}
                                                    title={drag.title}>
                                                    {EntityBaseController.getMoveIcon()}
                                                </LinkButton>}

                                            {!p.ctx.readOnly &&
                                                <LinkButton title={EntityControlMessage.Remove.niceToString()}
                                                    className="sf-line-button sf-remove"
                                                    onClick={() => c.handleDeleteValue(index)}>
                                                    <FontAwesomeIcon aria-hidden={true} icon="xmark" />
                                                </LinkButton>}
                                        </td>
                                        <td style={{ width: "100%" }}>
                                            {p.getComponent ? p.getComponent(rowCtx) :
                                                file == null ? null :
                                                    p.download === "None" ?
                                                        <span className={classes(rowCtx.formControlClass, "file-control")}>
                                                            {file.toString()}
                                                        </span> :
                                                        <FileDownloader
                                                            file={file}
                                                            containerEntity={container}
                                                            propertyRoute={propertyRoute}
                                                            rowId={(rowCtx.value as Partial<Entity>).id ?? undefined}
                                                            showFileIcon={p.showFileIcon ?? true}
                                                            download={p.download ?? "ViewOrSave"}
                                                            htmlAttributes={{ className: classes(rowCtx.formControlClass, "file-control") }} />
                                            }
                                        </td>
                                        {p.view === true && <td>{c.renderElementViewButton(false, rowCtx.value, index)}</td>}
                                    </tr>
                                </ErrorBoundary>
                            );
                        })}

                        <tr>
                            <td colSpan={3}>
                                {p.ctx.readOnly ? undefined :
                                    ctxs.length === 0 || c.forceShowUploader || p.forceShowUploader ?
                                        <FileUploader
                                            kind={c.kind()}
                                            fileType={p.fileType}
                                            accept={p.accept}
                                            multiple={true}
                                            maxSizeInBytes={p.maxSizeInBytes}
                                            dragAndDrop={p.dragAndDrop ?? true}
                                            dragAndDropMessage={p.dragAndDropMessage}
                                            onFileLoaded={c.handleFileLoaded}
                                            buttonCss={p.ctx.buttonClass}
                                            fileDropCssClass={c.mandatoryClass ?? undefined}
                                            divHtmlAttributes={{ className: "sf-file-line-new" }} /> :
                                        <button type="button" className="btn btn-link p-0 ms-3 sf-line-button sf-create"
                                            onClick={() => c.setForceShowUploader(true)}>
                                            {FileMessage.AddMoreFiles.niceToString()}
                                        </button>
                                }
                            </td>
                        </tr>
                    </tbody>
                </table>}
            </FormGroup>
        );
    });

// ---- helpers -------------------------------------------------------------------------------------------

function isFileType(fi: FieldInfo): boolean {
    return !fi.array && (fi.getTypeName() === "FilePathEmbedded" || fi.getTypeName() === "FileEmbedded");
}

/** Walk a dotted member path through the reflection metadata to the FieldInfo it names. */
function resolvePath(rowType: TypeReference, path: string[]): FieldInfo {
    let current: TypeReference = rowType;
    let fieldInfo: FieldInfo | undefined = undefined;

    for (const step of path) {
        fieldInfo = current.typeInfo().fields[step];
        if (fieldInfo == null)
            throw new Error(`MultiFileLine: '${current.getTypeName()}' has no member '${step}'`);
        current = fieldInfo;
    }

    if (fieldInfo == null || !isFileType(fieldInfo))
        throw new Error(`MultiFileLine: '${path.join(".")}' is not a FilePathEmbedded / FileEmbedded member`);

    return fieldInfo;
}
