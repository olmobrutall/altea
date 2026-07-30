// Ported from Signum.React/Lines/EnumCheckboxList.tsx — copy-and-fix. altea divergence: Signum's
// MList<V> is a plain `V[]` in altea (MListElement is gone — a collection is the sustaining array of
// elements), so each element IS the value: `mle.element` → the value, `newMListElement(val)` → `val`,
// and the Signum.Entities MList imports are dropped. Import paths retargeted; only the used
// getTimeMachineCheckboxIcon is imported (Signum also imported an unused getTimeMachineIcon).
import * as React from 'react'
import { classes, Dic } from '../../entities/globals'
import { mlistItemContext, TypeContext } from '../TypeContext'
import { getTypeInfo } from '../Reflection'
import { genericMemo, LineBaseController, useController } from '../Lines/LineBase'
import type { LineBaseProps } from '../Lines/LineBase'
import { getTimeMachineCheckboxIcon } from './TimeMachineIcon'
import { GroupHeader } from './GroupHeader'
import type { HeaderType } from './GroupHeader'
import type { JSX } from 'react'

export interface EnumCheckboxListProps<V extends string> extends LineBaseProps<V[]> {
  data?: V[];
  columnCount?: number;
  columnWidth?: number;
  avoidFieldSet?: boolean | HeaderType;
  ref?: React.Ref<EnumCheckboxListController<V>>
}

export class EnumCheckboxListController<V extends string> extends LineBaseController<EnumCheckboxListProps<V>, V[]> {

  override getDefaultProps(p: EnumCheckboxListProps<V>): void {
    super.getDefaultProps(p);
    p.columnWidth = 200;
    // ALTEA: the type facet comes from ctx.memberType (Signum's line `p.type`); for a collection line
    // that's the element (enum) type.
    if (p.ctx.memberType) {
      const ti = getTypeInfo(p.ctx.memberType.getTypeName()!);
      p.data = Dic.getKeys(ti.members) as V[];
    }
  }

  handleOnChange = (event: React.ChangeEvent<HTMLInputElement>, val: V): void => {

    var list = this.props.ctx.value;
    var toRemove = list.filter(v => v == val)

    if (toRemove.length) {
      toRemove.forEach(v => list.remove(v));
      this.setValue(list);
    }
    else {
      list.push(val);
      this.setValue(list);
    }
  }

}

export const EnumCheckboxList: <V extends string>(props: EnumCheckboxListProps<V>) => React.ReactNode | null =
  genericMemo(function EnumCheckboxList<V extends string>(props: EnumCheckboxListProps<V>) {
    const c = useController<EnumCheckboxListController<V>, EnumCheckboxListProps<V>, V[]>(EnumCheckboxListController, props);
    const p = c.props;

    if (c.isHidden)
      return null;

    return (
      <GroupHeader className={classes("sf-checkbox-list", c.getErrorClass("border"))}
        label={p.label}
        labelIcon={p.labelIcon}
        avoidFieldSet={p.avoidFieldSet}
        buttons={undefined}
        htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes, ...c.errorAttributes() }} >
        {renderContent()}
      </GroupHeader >
    );

    function renderContent() {
      if (p.data == null)
        return null;

      var data = [...p.data];

      p.ctx.value.forEach(val => {
        if (!data.some(d => d == val))
          data.insertAt(0, val)
      });

      var ariaAtts = p.ctx.readOnly ? c.baseAriaAttributes() : c.extendedAriaAttributes();
      const fi = p.ctx.propertyRoute?.fieldInfo;
      const requiredIndicator = fi != null && !fi.isNullable && !ariaAtts['aria-readonly'];

      const ti = getTypeInfo(p.ctx.memberType!.getTypeName()!);

      var listCtx = mlistItemContext(p.ctx);

      return (
        <div className="sf-checkbox-elements" style={getColumnStyle()}>
          {data.map((val, i) => {
            var controlId = React.useId();
            var ectx = listCtx.firstOrNull(ec => ec.value == val);
            var oldCtx = p.ctx.previousVersion == null || p.ctx.previousVersion.value == null ? null :
              listCtx.firstOrNull(el => el.previousVersion?.value == val);

            return (
              <label className="sf-checkbox-element" key={val} htmlFor={controlId}>
                {getTimeMachineCheckboxIcon({ newCtx: ectx, oldCtx: oldCtx, type: ti })}
                <input type="checkbox"
                  id={controlId}
                  className="form-check-input"
                  checked={p.ctx.value.some(val2 => val2 == val)}
                  disabled={p.ctx.readOnly}
                  name={val}
                  onChange={e => c.handleOnChange(e, val)} />
                &nbsp;
                <span>{ti.members[val].niceToString()}{requiredIndicator && <span aria-hidden="true" className="required-indicator">*</span>}</span>
            </label>);
          })}
        </div>
      );
    }

    function getColumnStyle(): React.CSSProperties | undefined {

      if (p.columnCount && p.columnWidth)
        return {
          columns: `${p.columnCount} ${p.columnWidth}px`,
        };

      if (p.columnCount)
        return {
          columnCount: p.columnCount,
        };

      if (p.columnWidth)
        return {
          columnWidth: p.columnWidth,
        };

      return undefined;
    }
  });
