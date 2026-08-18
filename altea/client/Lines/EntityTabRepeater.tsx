// Ported from Signum.React/Lines/EntityTabRepeater.tsx onto altea's EntityListBase. A row-editing line like
// EntityRepeater, but the rows are TABS: one tab per row, its title the row's toString (or `getTitle`), plus
// a trailing "create" tab. Use it when the rows are alternatives the user looks at ONE at a time (an email
// template's per-culture messages, a per-language text) rather than a list they read together.
//
// altea fixes vs Signum:
//  - MListElement is gone: the rows are a plain array, so `addElement`/`removeElement` take the ROW itself and
//    the selected index is computed with `indexOf(row)` rather than off an MList wrapper.
//  - `needsValue=false` (super(false)) — the whole row is the element, so a @valueField on it is IGNORED
//    (exactly as EntityRepeater does).
//  - `p.type!.isLite` → `p.ctx.memberType!.lite` for the add-element guard.
//  - `mountOnEnter`/`unmountOnExit` are kept: a tab's editor is built only when it is first shown, which is
//    the point of tabs for a heavy per-row editor.
import * as React from 'react'
import { Tabs, Tab } from 'react-bootstrap'
import { classes } from '../../data/globals'
import type { TypeContext } from '../TypeContext'
import { BaseEntity } from '../../data/entity'
import { Lite } from '../../data/lite'
import { EntityControlMessage } from '../../data/uiMessages'
import { EntityBaseController } from './EntityBase'
import { EntityListBaseController, type EntityListBaseProps } from './EntityListBase'
import { RenderEntity } from './RenderEntity'
import { useController } from './LineBase'
import { getTimeMachineIcon } from './TimeMachineIcon'
import { GroupHeader, type HeaderType } from './GroupHeader'

export interface EntityTabRepeaterProps<R extends BaseEntity> extends EntityListBaseProps<R> {
  createAsLink?: boolean | ((er: EntityTabRepeaterController<R>) => React.ReactElement);
  createMessage?: string;
  avoidFieldSet?: boolean | HeaderType;
  getTitle?: (ctx: TypeContext<R>) => React.ReactElement | string;
  extraTabs?: (c: EntityTabRepeaterController<R>) => React.ReactNode;
  /** Controlled selection: pass BOTH or neither (Signum's invariant). */
  selectedIndex?: number;
  onSelectTab?: (newIndex: number) => void;
  ref?: React.Ref<EntityTabRepeaterController<R>>
}

function isControlled(p: EntityTabRepeaterProps<any>): boolean {
  if ((p.selectedIndex != null) != (p.onSelectTab != null))
    throw new Error("selectedIndex and onSelectTab should be set together");

  return p.selectedIndex != null;
}

export class EntityTabRepeaterController<R extends BaseEntity> extends EntityListBaseController<EntityTabRepeaterProps<R>, R> {

  selectedIndex!: number;
  setSelectedIndex!: (index: number) => void;
  initialIsControlled!: boolean;

  // Row-editing line: the whole row is the element (ignore any @valueField).
  constructor() {
    super(false);
  }

  override init(p: EntityTabRepeaterProps<R>): void {
    super.init(p);

    // Controlled-ness is fixed for the component's lifetime (the hook count must not change).
    this.initialIsControlled = React.useMemo(() => isControlled(p), []);
    const currentIsControlled = isControlled(p);
    if (currentIsControlled != this.initialIsControlled)
      throw new Error(`selectedIndex was isControlled=${this.initialIsControlled} but now is ${currentIsControlled}`);

    if (!this.initialIsControlled) {
      [this.selectedIndex, this.setSelectedIndex] = React.useState(0);
    } else {
      this.selectedIndex = p.selectedIndex!;
      this.setSelectedIndex = p.onSelectTab!;
    }
  }

  override getDefaultProps(p: EntityTabRepeaterProps<R>): void {
    super.getDefaultProps(p);
    p.viewOnCreate = false;
    p.createAsLink = true;
  }

  // Removing the tab left of the selected one shifts the selection left, so the SAME row stays open.
  override removeElement(row: R): void {
    const list = this.props.ctx.value!;
    const deleteIndex = list.indexOf(row);

    list.remove(row);
    this.setSelectedIndex(coerce(deleteIndex < this.selectedIndex ? this.selectedIndex - 1 : this.selectedIndex, list.length));
    this.setValue(list);
  }

  // A newly created row becomes the selected tab — otherwise "create" appears to do nothing.
  override addElement(row: R): void {
    if ((row instanceof Lite) != (this.props.ctx.memberType?.lite ?? false))
      throw new Error("the row should already be converted to the field's element kind");

    const list = this.props.ctx.value!;
    list.push(row);
    this.setSelectedIndex(list.length - 1);
    this.setValue(list);
  }
}

export function EntityTabRepeater<R extends BaseEntity>(props: EntityTabRepeaterProps<R>): React.JSX.Element | null {
  const c = useController<EntityTabRepeaterController<R>, EntityTabRepeaterProps<R>, R[]>(EntityTabRepeaterController, props);
  const p = c.props;

  if (c.isHidden)
    return null;

  const ctx = p.ctx;

  return (
    <GroupHeader className={classes("sf-repeater-field sf-control-container", c.getErrorClass("border"))}
      label={p.label}
      labelIcon={p.labelIcon}
      avoidFieldSet={p.avoidFieldSet}
      buttons={renderButtons()}
      htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes, ...c.errorAttributes() }} >
      {renderTabs()}
    </GroupHeader >
  );

  function renderButtons(): React.ReactElement | undefined {
    const buttons = (
      <span className="ms-2">
        {p.extraButtonsBefore && p.extraButtonsBefore(c)}
        {p.createAsLink == false && c.renderCreateButton(false, p.createMessage)}
        {c.renderFindButton(false)}
        {p.extraButtons && p.extraButtons(c)}
      </span>
    );

    return EntityBaseController.hasChildrens(buttons) ? buttons : undefined;
  }

  function handleSelectTab(eventKey: string | null): void {
    const num = parseInt(eventKey ?? "");
    if (!isNaN(num)) // the "create" tab's key is not a number — it is handled by its own onClick
      c.setSelectedIndex(num);
  }

  function renderTabs(): React.ReactElement {
    const readOnly = ctx.readOnly;

    return (
      <Tabs activeKey={c.selectedIndex || 0} onSelect={handleSelectTab} id={ctx.prefix + "_tab"}
        transition={false} mountOnEnter unmountOnExit>
        {c.getMListItemContext(ctx).map((mlec, i) => {
          const drag = c.canMove(mlec.value) && p.moveMode == "DragIcon" && !readOnly ? c.getDragConfig(mlec.index!, "h") : undefined;
          const move = c.canMove(mlec.value) && p.moveMode == "MoveIcons" && !readOnly ? c.getMoveConfig(false, mlec.index!, "h") : undefined;

          return (
            <Tab eventKey={i} key={c.keyGenerator.getKey(mlec.value)}
              {...EntityBaseController.entityHtmlAttributes(mlec.value)}
              className="sf-repeater-element"
              title={(
                <div
                  className={classes("item-group", "sf-tab-dropable", drag?.dropClass)}
                  onDragEnter={drag?.onDragOver}
                  onDragOver={drag?.onDragOver}
                  onDrop={drag?.onDrop}>
                  {/* altea's getTimeMachineIcon takes no translateX (Signum nudged the tab icon horizontally). */}
                  {getTimeMachineIcon({ ctx: mlec, translateY: "-65%" })}
                  {p.getTitle ? p.getTitle(mlec) : mlec.value?.toString()}
                  {c.canRemove(mlec.value) && !readOnly &&
                    <span className={classes("sf-line-button", "sf-remove", "ms-2")}
                      onClick={e => { e.stopPropagation(); void c.handleRemoveElementClick(e, mlec.index!); }}
                      title={ctx.titleLabels ? EntityControlMessage.Remove.niceToString() : undefined}>
                      {EntityBaseController.getTrashIcon()}
                    </span>}
                  {drag && <span className={classes("sf-line-button", "sf-move", "ms-2")}
                    onClick={e => { e.preventDefault(); e.stopPropagation(); }}
                    draggable={true}
                    onDragStart={drag.onDragStart}
                    onKeyDown={drag.onKeyDown}
                    onDragEnd={drag.onDragEnd}
                    title={drag.title}>
                    {EntityBaseController.getMoveIcon()}
                  </span>}
                  {move?.renderMoveUp()}
                  {move?.renderMoveDown()}
                </div>
              ) as unknown as string /* react-bootstrap types `title` as a string; Signum passes a node too */}>
              {/* getComponent/getViewPromise are R-typed; RenderEntity types them over AsEntity<R>, which
                  equals R for an entity row but TS won't reduce the deferred conditional for a generic R. */}
              <RenderEntity ctx={mlec} getComponent={p.getComponent as any} getViewPromise={p.getViewPromise as any}
                onRefresh={c.forceUpdate} />
            </Tab>
          );
        })}

        {p.createAsLink && p.create && !readOnly &&
          (typeof p.createAsLink == "function" ? p.createAsLink(c) :
            <Tab eventKey="create-new" title={(
              <span className="sf-line-button sf-create" onClick={c.handleCreateClick}
                title={ctx.titleLabels ? EntityControlMessage.Create.niceToString() : undefined}>
                {EntityBaseController.getCreateIcon()}&nbsp;{p.createMessage ?? EntityControlMessage.Create.niceToString()}
              </span>
            ) as unknown as string} />)}

        {p.extraTabs && p.extraTabs(c)}
      </Tabs>
    );
  }
}

/** Clamp a selected index into a list that just shrank (Signum's `coerce`). */
function coerce(index: number, length: number): number {
  if (length <= index)
    index = length - 1;

  return index < 0 ? 0 : index;
}
