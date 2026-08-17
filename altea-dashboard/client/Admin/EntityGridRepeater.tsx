import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import { BaseEntity } from "@altea/altea/data/entity";
import { EntityControlMessage } from "@altea/altea/data/uiMessages";
import { toInt } from "@altea/altea/data/basics";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { EntityListBaseController, type EntityListBaseProps } from "@altea/altea/client/Lines/EntityListBase";
import { useController } from "@altea/altea/client/Lines/LineBase";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useSize } from "@altea/altea/client/Hooks";
import type { IGridEntity } from "../../data/Dashboard";

// Port of Signum's Signum.Dashboard/Admin/EntityGridRepeater.tsx — the 12-column drag-and-drop grid line the
// dashboard editor uses: drag a part's header to move it (within a row, or onto a row separator to re-row it),
// drag its side handles to resize it, and the create button appends a new full-width part on a new row.
//
// altea divergences (mechanical, from altea's line model):
//  - altea has NO MList: the bound value is a plain `R[]` of row entities, so `newMListElement(e)` /
//    `a.element` are gone — a row IS the element (`list.push(ge)`, `ctx.value.row`).
//  - `propertyRoute.addLambda(a => a[0])` → `propertyRoute.add("Item")`.
//  - EntityListBaseProps is generic on the ROW type only (no value generic), and the geometry fields are
//    altea `int`s (branded numbers), hence the `toInt(...)` casts.
//  - Signum flagged each moved row with `a.modified = true`; altea tracks changes by snapshot (isDirty()),
//    so those assignments simply disappear.

export interface EntityGridRepeaterProps<R extends BaseEntity & IGridEntity> extends EntityListBaseProps<R> {
    createAsLink?: boolean;
    resize?: boolean;
    // (Signum declared `ref?: React.Ref<EntityGridRepeaterController<V>>`. Dropped: nothing needs the
    // controller from outside, and a self-referential `ref` here makes useController's props constraint
    // unsatisfiable across the two @types/react resolutions in this workspace.)
}

export interface EntityGridRepaterDragging<R extends BaseEntity & IGridEntity> {
    dragMode: "move" | "left" | "right";
    initialPageX?: number;
    originalStartColumn?: number;
    currentItem: R;
    currentRow?: number;
}

export class EntityGridRepeaterController<R extends BaseEntity & IGridEntity> extends EntityListBaseController<EntityGridRepeaterProps<R>, R> {

    drag!: EntityGridRepaterDragging<R> | undefined;
    setDrag!: React.Dispatch<EntityGridRepaterDragging<R> | undefined>;

    override init(p: EntityGridRepeaterProps<R>): void {
        super.init(p);
        [this.drag, this.setDrag] = React.useState<EntityGridRepaterDragging<R> | undefined>(undefined);
    }

    override getDefaultProps(state: EntityGridRepeaterProps<R>): void {
        super.getDefaultProps(state);
        state.viewOnCreate = false;
        state.move = true;
        state.resize = true;
        state.remove = true;
    }

    override handleCreateClick = async (event: React.SyntheticEvent<any>): Promise<void> => {

        event.preventDefault();

        const p = this.props;
        const pr = p.ctx.propertyRoute!.add("Item");
        const e = p.onCreate ? await p.onCreate(pr) : await this.defaultCreate(pr);

        if (!e)
            return;

        const ge = e as R;

        const list = p.ctx.value!;
        if (ge.row == undefined)
            ge.row = list.length == 0 ? toInt(0) : toInt(list.map(a => a.row as number).max()! + 1);
        if (ge.startColumn == undefined)
            ge.startColumn = toInt(0);
        if (ge.columns == undefined)
            ge.columns = toInt(12);

        list.push(ge);
        this.setValue(list);
    };

    handleRowDragOver = (e: React.DragEvent<any>, row: number): void => {
        e.dataTransfer.dropEffect = "move";
        e.preventDefault();
        if (this.drag!.currentRow != row)
            this.setDrag({ ...this.drag!, currentRow: row });
    };

    handleRowDragLeave = (): void => {
        this.setDrag({ ...this.drag!, currentRow: undefined });
    };

    handleRowDrop = (e: React.DragEvent<any>, row: number): void => {
        e.preventDefault();

        const list = this.props.ctx.value!;
        const c = this.drag!.currentItem;

        list.filter(a => a != c && (a.row as number) >= row).forEach(a => { a.row = toInt((a.row as number) + 1); });

        c.row = toInt(row);
        c.startColumn = toInt(0);
        c.columns = toInt(12);

        if (!list.find(a => a == c))
            list.push(c);

        this.setValue(list);
        this.setDrag(undefined);
    };

    handleOnDrop = (): void => {
        this.setDrag(undefined);
    };

    handleResizeDragStart: (resizer: "left" | "right", e: React.DragEvent<any>, row: R) => void = (resizer, e, row) => {
        e.dataTransfer.effectAllowed = "move";
        this.setDrag({ currentItem: row, dragMode: resizer });
    };

    handleMoveDragStart = (e: React.DragEvent<any>, row: R): void => {
        e.dataTransfer.effectAllowed = "move";
        const de = e.nativeEvent as DragEvent;

        this.setDrag({ dragMode: "move", initialPageX: de.pageX, originalStartColumn: row.startColumn as number, currentItem: row });
    };

    handleMoveDragEnd = (e: React.DragEvent<any>): void => {
        e.dataTransfer.effectAllowed = "move";
        this.setDrag(undefined);
    };

    handleItemsRowDragOver = (e: React.DragEvent<any>, row: number): void => {
        if (this.drag == null)
            return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const de = e.nativeEvent as DragEvent;
        const list = this.props.ctx.value!;
        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const d = this.drag!;
        const item = d.currentItem;

        if (d.dragMode == "move") {
            const offset = de.pageX - d.initialPageX!;
            const dCol = Math.round((offset / rect.width) * 12);
            let newCol = d.originalStartColumn! + dCol;
            let start = list.filter(a => a != item && (a.row as number) == row && (a.startColumn as number) <= newCol)
                .map(a => (a.startColumn as number) + (a.columns as number)).max();
            if (start == null)
                start = 0;

            let end = list.filter(a => a != item && (a.row as number) == row && (a.startColumn as number) > newCol)
                .map(a => (a.startColumn as number) - (item.columns as number)).min();
            if (end == null)
                end = 12 - (item.columns as number);

            if (start > end) {
                e.dataTransfer.dropEffect = "none";
                return; // Doesn't fit
            }

            newCol = Math.max(start, Math.min(newCol, end));

            if (newCol != (item.startColumn as number) || (item.row as number) != row) {
                item.startColumn = toInt(newCol);
                item.row = toInt(row);
                this.forceUpdate();
            }
        } else {
            const offsetX = (de.pageX + (d.dragMode == "right" ? 15 : -15)) - rect.left;
            let col = Math.round((offsetX / rect.width) * 12);

            if (d.dragMode == "left") {
                const max = list.filter(a => a != item && (a.row as number) == (item.row as number) && (a.startColumn as number) < (item.startColumn as number))
                    .map(a => (a.startColumn as number) + (a.columns as number)).max();
                col = max == null ? col : Math.max(col, max);

                const cx = (item.startColumn as number) - col;
                if (cx != 0) {
                    item.startColumn = toInt(col);
                    item.columns = toInt((item.columns as number) + cx);
                    this.forceUpdate();
                }
            }
            else if (d.dragMode == "right") {
                const min = list.filter(a => a != item && (a.row as number) == (item.row as number) && (a.startColumn as number) > (item.startColumn as number))
                    .map(a => a.startColumn as number).min();
                col = min == null ? col : Math.min(col, min);
                if (col != (item.startColumn as number) + (item.columns as number)) {
                    item.columns = toInt(col - (item.startColumn as number));
                    this.forceUpdate();
                }
            }
        }
    };
}

export function EntityGridRepeater<R extends BaseEntity & IGridEntity>(props: EntityGridRepeaterProps<R>): React.JSX.Element | null {
    const c = useController<EntityGridRepeaterController<R>, EntityGridRepeaterProps<R>, R[]>(EntityGridRepeaterController, props);
    const p = c.props;

    if (c.isHidden)
        return null;

    function renderSeparator(rowIndex: number): React.JSX.Element {
        return (
            <div className={classes("row separator-row", c.drag?.currentRow == rowIndex ? "sf-over" : undefined)} key={"sep" + rowIndex}
                onDragOver={e => c.handleRowDragOver(e, rowIndex)}
                onDragEnter={e => c.handleRowDragOver(e, rowIndex)}
                onDragLeave={() => c.handleRowDragLeave()}
                onDrop={e => c.handleRowDrop(e, rowIndex)} />
        );
    }

    return (
        <fieldset className={classes("sf-grid-repeater-field sf-control-container", c.getErrorClass())} {...c.errorAttributes()}>
            <legend>
                <div>
                    <span>{p.label}</span>
                    <span className="float-end ms-2">
                        {p.extraButtonsBefore && p.extraButtonsBefore(c)}
                        {c.renderCreateButton(false)}
                        {c.renderFindButton(false)}
                        {p.extraButtons && p.extraButtons(c)}
                    </span>
                </div>
            </legend>
            <div className="row sf-rule">
                {Array.range(0, 12).map(i =>
                    <div className="col-sm-1" key={i}>
                        <div className="sf-rule-item">Col {i}</div>
                    </div>
                )}
            </div>
            <div className={classes("sf-grid-container", c.drag?.dragMode == "move" ? "sf-dragging" : undefined)} onDrop={c.handleOnDrop}>
                {(!p.ctx.value || p.ctx.value.length == 0) && renderSeparator(1)}
                {
                    c.getMListItemContext(p.ctx)
                        .groupBy(ctx => (ctx.value.row as number).toString())
                        .orderBy(gr => parseInt(gr.key))
                        .flatMap((gr, i, groups) => [
                            renderSeparator(parseInt(gr.key)),
                            <div className="row items-row" key={"row" + gr.key} onDragOver={e => c.handleItemsRowDragOver(e, parseInt(gr.key))}>
                                {gr.elements.orderBy(ctx => ctx.value.startColumn as number).map((ctx, j, list) => {
                                    let item = p.getComponent!(ctx);
                                    item = React.cloneElement(item, {
                                        onResizerDragStart: ctx.readOnly || !p.resize ? undefined : (resizer: "left" | "right", e: React.DragEvent<any>) => c.handleResizeDragStart(resizer, e, ctx.value),
                                        onTitleDragStart: ctx.readOnly || !p.move ? undefined : (e: React.DragEvent<any>) => c.handleMoveDragStart(e, ctx.value),
                                        onTitleDragEnd: ctx.readOnly || !p.move ? undefined : (e: React.DragEvent<any>) => c.handleMoveDragEnd(e),
                                        onRemove: ctx.readOnly || !p.remove ? undefined : (e: React.MouseEvent<any>) => c.handleRemoveElementClick(e, ctx.index!),
                                    } as EntityGridItemProps);

                                    const last = j == 0 ? undefined : list[j - 1].value;
                                    const offset = (ctx.value.startColumn as number) - (last ? ((last.startColumn as number) + (last.columns as number)) : 0);

                                    return (
                                        <div key={j} className={`sf-grid-element col-sm-${ctx.value.columns} offset-sm-${offset}`}>
                                            {item}
                                        </div>
                                    );
                                })}
                            </div>,
                            i == groups.length - 1 && renderSeparator(parseInt(gr.key) + 1),
                        ])
                }
            </div>
        </fieldset>
    );
}

export interface EntityGridItemProps {
    title?: (smallMode: boolean) => React.ReactElement;
    children?: (smallMode: boolean) => React.ReactNode;
    customColor?: string;
    sizeDeps?: React.DependencyList;
    onResizerDragStart?: (resizer: "left" | "right", e: React.DragEvent<any>) => void;
    onTitleDragStart?: (e: React.DragEvent<any>) => void;
    onTitleDragEnd?: (e: React.DragEvent<any>) => void;
    onRemove?: (e: React.MouseEvent<any>) => void;
}

export function EntityGridItem(p: EntityGridItemProps): React.JSX.Element {
    const style = p.customColor == null ? "light" : "customColor";

    const { size, setContainer } = useSize({ deps: p.sizeDeps, avoidReset: true });
    const smallMode = size != null && size.width < 500;

    return (
        <div className={classes("card", "shadow-sm")} ref={setContainer}>
            <div className={classes("card-header", style != "customColor" && ("bg-" + style))}
                style={{ backgroundColor: p.customColor ?? undefined }}
                draggable={!!p.onTitleDragStart}
                onDragStart={p.onTitleDragStart}
                onDragEnd={p.onTitleDragEnd}>
                {p.onRemove &&
                    <LinkButton className="sf-line-button sf-remove float-end" onClick={p.onRemove}
                        title={EntityControlMessage.Remove.niceToString()}>
                        <FontAwesomeIcon aria-hidden={true} icon="xmark" />
                    </LinkButton>
                }
                {p.title?.(smallMode)}
            </div>
            <div className="card-body">
                {p.children?.(smallMode)}
            </div>
            {p.onResizerDragStart &&
                <div className="sf-leftHandle" draggable={true} onDragStart={e => p.onResizerDragStart!("left", e)} />
            }
            {p.onResizerDragStart &&
                <div className="sf-rightHandle" draggable={true} onDragStart={e => p.onResizerDragStart!("right", e)} />
            }
        </div>
    );
}
