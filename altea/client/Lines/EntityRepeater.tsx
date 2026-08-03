// Ported from Signum.React/Lines/EntityRepeater.tsx onto altea's EntityListBase. A row-editing line:
// each row R is rendered in place via RenderEntity, so `needsValue=false` (super(false)) — a @valueField
// on the row is IGNORED (the whole row is the element). altea fixes: MListElement gone → iterate
// `getMListItemContext` (row contexts); `ctx.propertyRoute.typeReference().name`→`p.ctx.memberType.typeName` for
// the showType impl-count; getComponent/getViewPromise are R-typed; TypeBadge accepts BaseEntity.
import * as React from 'react'
import { classes } from '../../data/globals'
import { ViewPromise } from '../EntitySettings'
import type { TypeContext } from '../TypeContext'
import { BaseEntity, Entity } from '../../data/entity'
import type { Lite } from '../../data/lite'
import { EntityControlMessage } from '../../data/uiMessages'
import { EntityBaseController } from './EntityBase'
import { EntityListBaseController, type EntityListBaseProps, type DragConfig, type MoveConfig } from './EntityListBase'
import { RenderEntity } from './RenderEntity'
import { useController } from './LineBase'
import { TypeBadge } from './AutoCompleteConfig'
import { getTimeMachineIcon } from './TimeMachineIcon'
import { GroupHeader, type HeaderType } from './GroupHeader'
import { LinkButton } from '../Basics/LinkButton'

export interface EntityRepeaterProps<R extends BaseEntity> extends EntityListBaseProps<R> {
  createAsLink?: boolean | ((er: EntityRepeaterController<R>) => React.ReactElement);
  avoidFieldSet?: boolean | HeaderType;
  createMessage?: string;
  getTitle?: (ctx: TypeContext<R>) => React.ReactElement | string;
  itemExtraButtons?: (er: EntityRepeaterController<R>, index: number) => React.ReactElement;
  elementHtmlAttributes?: (ctx: TypeContext<NoInfer<R>>) => React.HTMLAttributes<any> | null | undefined;
  ref?: React.Ref<EntityRepeaterController<R>>
}

export class EntityRepeaterController<R extends BaseEntity> extends EntityListBaseController<EntityRepeaterProps<R>, R> {

  // Row-editing line: the whole row is the element (ignore any @valueField).
  constructor() {
    super(false);
  }

  override getDefaultProps(p: EntityRepeaterProps<R>): void {
    super.getDefaultProps(p);
    p.viewOnCreate = false;
    p.createAsLink = true;
  }
}


export function EntityRepeater<R extends BaseEntity>(props: EntityRepeaterProps<R>): React.JSX.Element | null {
  var c = useController<EntityRepeaterController<R>, EntityRepeaterProps<R>, R[]>(EntityRepeaterController, props);
  var p = c.props;

  if (c.isHidden)
    return null;

  let ctx = p.ctx;

  return (
    <GroupHeader className={classes("sf-repeater-field sf-control-container", c.getErrorClass("border"))}
      label={p.label}
      labelIcon={p.labelIcon}
      avoidFieldSet={p.avoidFieldSet}
      buttons={renderButtons()}
      htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes, ...c.errorAttributes() }} >
      {renderElements()}
    </GroupHeader >
  );

  function renderButtons() {
    const buttons = (
      <span>
        {p.extraButtonsBefore && p.extraButtonsBefore(c)}
        {p.createAsLink == false && c.renderCreateButton(false, p.createMessage)}
        {c.renderFindButton(false)}
        {p.extraButtons && p.extraButtons(c)}
      </span>
    );

    return EntityBaseController.hasChildrens(buttons) ? buttons : undefined;
  }

  function renderElements() {
    const readOnly = ctx.readOnly;
    const showType = p.ctx.memberType!.typeInfos().length > 1;
    return (
      <div className="sf-repater-elements">
        {
          c.getMListItemContext(ctx).map((mlec, i) =>
          <EntityRepeaterElement<R> key={c.keyGenerator.getKey(mlec.value)}
            onRemove={c.canRemove(mlec.value) && !readOnly ? e => c.handleRemoveElementClick(e, mlec.index!) : undefined}
            ctx={mlec}
            move={c.canMove(mlec.value) && p.moveMode == "MoveIcons" && !readOnly ? c.getMoveConfig(false, mlec.index!, "v") : undefined}
            drag={c.canMove(mlec.value) && p.moveMode == "DragIcon" && !readOnly ? c.getDragConfig(mlec.index!, "v") : undefined}
            itemExtraButtons={p.itemExtraButtons ? (() => p.itemExtraButtons!(c, mlec.index!)) : undefined}
            htmlAttributes={p.elementHtmlAttributes ? (() => p.elementHtmlAttributes!(mlec)) : undefined}
            getComponent={p.getComponent}
            getViewPromise={p.getViewPromise}
            title={p.getTitle || showType ? <>{p.getTitle?.(mlec)}{showType && p.getTitle && '\xa0'}{showType ? <TypeBadge entity={mlec.value} /> : undefined}</> : undefined}
            />
        )}
        {
          p.createAsLink && p.create && !readOnly &&
          (typeof p.createAsLink == "function" ? p.createAsLink(c) :
            <LinkButton title={ctx.titleLabels ? EntityControlMessage.Create.niceToString() : undefined}
              className="sf-line-button sf-create"
              onClick={c.handleCreateClick}>
              {EntityBaseController.getCreateIcon()}&nbsp;{p.createMessage ?? EntityControlMessage.Create.niceToString()}
            </LinkButton>)
        }
      </div>
    );
  }
}


export interface EntityRepeaterElementProps<R extends BaseEntity> {
  ctx: TypeContext<R>;
  getComponent?: (ctx: TypeContext<R>) => React.ReactElement;
  getViewPromise?: (entity: R) => undefined | string | ViewPromise<R>;
  onRemove?: (event: React.MouseEvent<any>) => void;
  move?: MoveConfig;
  drag?: DragConfig;
  title?: React.ReactElement;
  itemExtraButtons?: () => React.ReactElement;
  htmlAttributes?: () => React.HTMLAttributes<any> | null | undefined;
}

export function EntityRepeaterElement<R extends BaseEntity>({ ctx, getComponent, getViewPromise, onRemove, move, drag, itemExtraButtons, title, htmlAttributes }: EntityRepeaterElementProps<R>): React.ReactElement {

  var attrs = htmlAttributes?.();

  return (
    <div
      {...attrs}
      className={classes(drag?.dropClass, attrs?.className)}
      onDragEnter={drag?.onDragOver}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}>
      {getTimeMachineIcon({ ctx: ctx, isContainer: true, translateY: "250%" })}
      <fieldset className="sf-repeater-element"
        {...EntityBaseController.entityHtmlAttributes(ctx.value)}>
        {(onRemove || move || drag || itemExtraButtons || title) &&
          <legend>
            <div className="d-flex">
              {onRemove && <LinkButton className={classes("sf-line-button", "sf-remove")}
                onClick={onRemove}
                title={ctx.titleLabels ? EntityControlMessage.Remove.niceToString() : undefined}>
                {EntityBaseController.getTrashIcon()}
              </LinkButton>}
              &nbsp;
              {move?.renderMoveUp()}
              {move?.renderMoveDown()}
              {drag && <LinkButton className={classes("sf-line-button", "sf-move")} onClick={e => { e.stopPropagation(); }}
                draggable={true}
                onDragStart={drag.onDragStart}
                onDragEnd={drag.onDragEnd}
                onKeyDown={drag.onKeyDown}
                title={drag.title}>
                {EntityBaseController.getMoveIcon()}
              </LinkButton>}
              {itemExtraButtons && itemExtraButtons()}
              {title && '\xa0'}
              {title}
            </div>
          </legend>}
        <div className="sf-line-entity">
          {/* getComponent/getViewPromise are R-typed; RenderEntity types them over AsEntity<R>, which
              equals R for an entity row but TS won't reduce the deferred conditional for a generic R. */}
          <RenderEntity ctx={ctx} getComponent={getComponent as any} getViewPromise={getViewPromise as any} />
        </div>
      </fieldset>
    </div>
  );
}
