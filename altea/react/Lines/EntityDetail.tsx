// Ported from Signum.React/Lines/EntityDetail.tsx — copy-paste + fix. altea fixes:
//   - ModifiableEntity → BaseEntity; the line's type comes from ctx.memberType (a TypeReference), and
//     Signum's `tryGetTypeInfos(type)` string round-trip → `ctx.memberType.typeInfos()` (structured).
//   - idioms: isLite(x)→x instanceof Lite; isEntity(x)→x instanceof Entity.
//   - dropped unused Signum imports (getTypeInfos / FontAwesomeIcon / GroupHeader).
import * as React from 'react'
import { classes } from '../../entities/globals'
import type { TypeContext } from '../TypeContext'
import { BaseEntity, Entity, EmbeddedEntity } from '../../entities/entity'
import { Lite } from '../../entities/lite'
import { EntityBaseController, type EntityBaseProps } from './EntityBase'
import { RenderEntity } from './RenderEntity'
import { genericMemo, useController } from './LineBase'
import { TypeBadge } from './AutoCompleteConfig'
import { getTimeMachineIcon } from './TimeMachineIcon'
import { type HeaderType, Title } from './GroupHeader'


export interface EntityDetailProps<V extends BaseEntity | Lite<Entity> | null> extends EntityBaseProps<V> {
  avoidFieldSet?: boolean | HeaderType;
  avoidFieldSetHtmlAttributes?: React.HTMLAttributes<HTMLDivElement>;
  showAsCheckBox?: boolean;
  onEntityLoaded?: () => void;
  showType?: boolean;
  ref?: React.Ref<EntityDetailController<V>>
}


export class EntityDetailController<V extends BaseEntity | Lite<Entity> | null> extends EntityBaseController<EntityDetailProps<V>, V> {
  override getDefaultProps(p: EntityDetailProps<V>): void {
    super.getDefaultProps(p);
    p.viewOnCreate = false;
    p.view = false;
  }
}

export const EntityDetail: <V extends BaseEntity | Lite<Entity> | null>(props: EntityDetailProps<V>) => React.ReactNode | null =
  genericMemo(function EntityDetail<V extends BaseEntity | Lite<Entity> | null>(props: EntityDetailProps<V>): React.JSX.Element | null {

    const c = useController<EntityDetailController<V>, EntityDetailProps<V>, V>(EntityDetailController, props);
  const p = c.props;

  if (c.isHidden)
    return null;

  var ti = p.ctx.memberType!.typeInfos().onlyOrNull();

  var showAsCheckBox = p.showAsCheckBox ??
    ((p.ctx.memberType!.is(EmbeddedEntity) || ti != null && ti.entityKind == "Part") && p.extraButtons == undefined && p.extraButtonsBefore == undefined);


  function renderType() {
    var entity = p.ctx.value;
    if (entity == null)
      return null;

    if (entity instanceof Lite || entity instanceof Entity) {
      if (p.showType ?? p.ctx.memberType!.typeInfos().length > 1)
        return <TypeBadge entity={entity!} />;
    }

  }


  if (p.avoidFieldSet)
    return (
      <div className={classes("sf-entity-line-details", c.getErrorClass(), c.mandatoryClass, p.ctx.value && "mb-4")}
        {...{ ...c.baseHtmlAttributes(), ...EntityBaseController.entityHtmlAttributes(p.ctx.value), ...p.formGroupHtmlAttributes, ...c.errorAttributes() }}>
        {getTimeMachineIcon({ ctx: p.ctx})}
        {showAsCheckBox ?
          <label><Title type={p.avoidFieldSet == true ? "lead" : p.avoidFieldSet}>
            {renderCheckBox()}
            {p.label} {renderType()}
            {p.extraButtons && p.extraButtons(c)}
          </Title>
          </label>
          :
          <Title type={p.avoidFieldSet == true ? "lead" : p.avoidFieldSet}>
            <span>{p.label} {renderType()}</span>
            {renderButtons()}
          </Title>
        }
        <div className="ms-4 mt-2" {...p.avoidFieldSetHtmlAttributes}>
          <RenderEntity ctx={p.ctx} getComponent={p.getComponent} getViewPromise={p.getViewPromise} onEntityLoaded={p.onEntityLoaded} />
        </div>
      </div>
    );

  return (
    <>
      {getTimeMachineIcon({ ctx: p.ctx, translateY:"150%" })}
      <fieldset className={classes("sf-entity-line-details", c.getErrorClass(), c.mandatoryClass)}
        {...{ ...c.baseHtmlAttributes(), ...EntityBaseController.entityHtmlAttributes(p.ctx.value), ...p.formGroupHtmlAttributes, ...c.errorAttributes() }}>
        <legend className="lead">
          {showAsCheckBox ?
            <label>
              {renderCheckBox()}
              {p.label} {renderType()}
              {p.extraButtons && p.extraButtons(c)}
            </label>
            :
            <div>
              <span>{p.label} {renderType()}</span>
              {renderButtons()}
            </div>
          }
        </legend>
        <RenderEntity ctx={p.ctx} getComponent={p.getComponent} getViewPromise={p.getViewPromise} onEntityLoaded={p.onEntityLoaded} />
      </fieldset>
    </>
  );

  function renderCheckBox() {
    const hasValue = !!p.ctx.value;
    var disabled = p.ctx.readOnly || (hasValue ? !p.remove : !p.create);

    return <input type="checkbox" className="form-check-input me-1" checked={hasValue} disabled={disabled}
      onChange={e => {
        e.preventDefault();
        e.stopPropagation();
        window.setTimeout(() => {
          if (!p.readOnly) {
            if (hasValue)
              c.handleRemoveClick(e)
            else
              c.handleCreateClick(e);
          }
        });

      }} />;
  }

  function renderButtons() {
    const hasValue = !!p.ctx.value;
    const buttons = (
      <span className="ms-1 float-end">
        {p.extraButtonsBefore && p.extraButtonsBefore(c)}
        {!hasValue && c.renderCreateButton(false)}
        {!hasValue && c.renderFindButton(false)}
        {hasValue && c.renderViewButton(false)}
        {hasValue && c.renderRemoveButton(false)}
        {p.extraButtons && p.extraButtons(c)}
      </span>
    );
    return EntityBaseController.hasChildrens(buttons) ? buttons : undefined;
  }
});
