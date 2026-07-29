// Ported from Signum.React/Lines/AutoLine.tsx — copy-paste + fix. altea fixes:
//   - dispatch is over a FieldInfo (Signum's TypeReference is gone): `.name`→`.typeName`,
//     `.isCollection`→`.array`, `.isLite`→`.lite`, `.isEmbedded`→`.kind=="Embedded"`,
//     `.isNotNullable`→`!.isNullable`; altea value typeNames (String/Number/Decimal/Boolean/
//     PlainDate/PlainDateTime/Guid/Duration/PlainTime); enum via `fieldInfo.isEnum`.
//   - ENTITY + COLLECTION branches are STUBBED: the entity lines (EntityLine/Combo/Detail/Strip/
//     Table/Repeater/CheckboxList/MultiSelect) and MultiValueLine aren't ported yet (they need
//     Typeahead / Navigator.view / Constructor / SelectorModal). They render a TODO placeholder;
//     restore the real dispatch once those land.
import * as React from 'react'
import { IsByAll, PropertyRoute, isNumberType, tryGetTypeInfos } from '../Reflection'
import type { FieldInfo } from '../../entities/reflection'
import { LineBaseController, type LineBaseProps } from './LineBase'
import { CheckboxLine } from './CheckboxLine'
import { DateTimeLine } from './DateTimeLine'
import { EnumLine } from './EnumLine'
import { NumberLine } from './NumberLine'
import { TextAreaLine } from './TextAreaLine'
import { TextBoxLine, PasswordLine, GuidLine, ColorLine } from './TextBoxLine'
import { TimeLine } from './TimeLine'

export interface AutoLineProps extends LineBaseProps<any> {
  propertyRoute?: PropertyRoute; //For AutoLineModal
  valueHtmlAttributes?: React.HTMLAttributes<any>;
}


export function AutoLine(p: AutoLineProps): React.ReactElement | null {
  const pr = p.ctx.propertyRoute;

  var isHidden = p.type == null && pr == null || p.visible == false || p.hideIfNull && (p.ctx.value == undefined || p.ctx.value == "");
  if (isHidden)
    return null;

  const fi = p.type ?? pr!.fieldInfo!;
  const factory = React.useMemo(() => AutoLine.getComponentFactory(fi, p.propertyRoute ?? pr), [(p.propertyRoute ?? pr)?.toString(), fi?.typeName]);

  return factory(p);
}

export interface AutoLineFactoryRule {
  name: string;
  factory: (fi: FieldInfo, pr?: PropertyRoute) => undefined | ((p: AutoLineProps) => React.ReactElement);
}

// TODO(port): the entity/collection lines (EntityLine/Combo/Detail/Strip/Table/Repeater/CheckboxList/
// MultiSelect, MultiValueLine) are not ported yet — placeholder until they land.
function notPorted(what: string): (p: AutoLineProps) => React.ReactElement {
  return () => <span className="text-danger">TODO(port): AutoLine → {what} not ported yet</span>;
}

export namespace AutoLine {
  const customTypeComponent: {
    [typeName: string]: AutoLineFactoryRule[];
  } = {};

  export function registerComponent(type: string, factory: (fi: FieldInfo, pr?: PropertyRoute) => undefined | ((p: AutoLineProps) => React.ReactElement), name?: string): void {
    (customTypeComponent[type] ??= []).push({ name: name ?? type, factory });
  }

  export function getComponentFactory(fi: FieldInfo, pr?: PropertyRoute): (props: AutoLineProps) => React.ReactElement {

    const customs = customTypeComponent[fi.typeName]?.map(rule => rule.factory(fi, pr)).notNull().first();

    if (customs != null)
      return customs

    if (fi.array)
      return notPorted("collection lines (EntityStrip / EntityTable / EntityRepeater / MultiValueLine)");

    // Entity / Lite reference (incl. @implementedBy(All)) → EntityLine / EntityCombo / EntityDetail.
    if (fi.typeName == IsByAll || fi.lite || tryGetTypeInfos(fi.typeName).notNull().length > 0)
      return notPorted("entity lines (EntityLine / EntityCombo / EntityDetail)");

    if (fi.kind == "Embedded")
      return notPorted("EntityDetail (embedded)");

    if (fi.isEnum || (fi.typeName == "Boolean" && fi.isNullable))
      return p => <EnumLine {...p} />;

    if (fi.typeName == "Boolean")
      return p => <CheckboxLine {...p} />;

    if (fi.typeName == "PlainDate" || fi.typeName == "PlainDateTime")
      return p => <DateTimeLine {...p} />;

    if (fi.typeName == "String") {
      if (fi.format == "Password")
        return p => <PasswordLine {...p} />;

      if (fi.format == "Color")
        return p => <ColorLine {...p} />;

      if (fi.isMultiline)
        return p => <TextAreaLine {...p} />;

      return p => <TextBoxLine {...p} />;
    }

    if (fi.typeName == "Guid")
      return p => <GuidLine {...p} />;

    if (isNumberType(fi.typeName) || fi.typeName == "Decimal")
      return p => <NumberLine {...p} />;

    if (fi.typeName == "Duration" || fi.typeName == "PlainTime")
      return p => <TimeLine {...p} />;

    return () => <span className="text-danger">Not supported type {fi.typeName} by AutoLine</span>;
  }
}
