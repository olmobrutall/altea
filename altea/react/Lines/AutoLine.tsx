// Ported from Signum.React/Lines/AutoLine.tsx — copy-paste + fix. altea fixes:
//   - dispatch is over a FieldInfo (Signum's TypeReference is gone): `.name`→`.typeName`,
//     `.isCollection`→`.array`, `.isLite`→`.lite`, `.isEmbedded`→`.kind=="Embedded"`,
//     `.isNotNullable`→`!.isNullable`; altea value typeNames (String/Number/Decimal/Boolean/
//     PlainDate/PlainDateTime/Guid/Duration/PlainTime); enum via `fieldInfo.isEnum`.
//   - single entity/Lite → EntityLine; embedded → EntityDetail. COLLECTION (R[], no MList): branch on
//     the row type's @valueField — reference @valueField → EntityStrip; scalar @valueField →
//     MultiValueLine; no @valueField (owned parts) → EntityRepeater if the field is @implementedBy
//     (polymorphic, per-row views), else EntityTable (grid).
import * as React from 'react'
import { PropertyRoute, isNumberType, tryGetTypeInfos } from '../Reflection'
import { Entity, EmbeddedEntity } from '../../entities/entity'
import type { FieldInfo } from '../../entities/reflection'
import { LineBaseController, type LineBaseProps } from './LineBase'
import { CheckboxLine } from './CheckboxLine'
import { DateTimeLine } from './DateTimeLine'
import { EnumLine } from './EnumLine'
import { NumberLine } from './NumberLine'
import { TextAreaLine } from './TextAreaLine'
import { TextBoxLine, PasswordLine, GuidLine, ColorLine } from './TextBoxLine'
import { TimeLine } from './TimeLine'
import { EntityLine } from './EntityLine'
import { EntityDetail } from './EntityDetail'
import { EntityStrip } from './EntityStrip'
import { EntityTable } from './EntityTable'
import { EntityRepeater } from './EntityRepeater'
import { EntityCombo } from './EntityCombo'
import { EntityCheckboxList } from './EntityCheckboxList'
import { MultiValueLine } from './MultiValueLine'
import { tryGetValueField } from './EntityListBase'

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
  const factory = React.useMemo(() => AutoLine.getComponentFactory(fi, p.propertyRoute ?? pr), [(p.propertyRoute ?? pr)?.toString(), fi.getTypeName()]);

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

    const customs = customTypeComponent[fi.getTypeName() ?? fi.typeName]?.map(rule => rule.factory(fi, pr)).notNull().first();

    if (customs != null)
      return customs

    // Collection (R[]): altea has no MList — the array holds ROW entities. Branch on whether the row
    // type declares a @valueField (FieldInfo.isValueField):
    //   - value collection whose value is a reference (entity/Lite) → EntityStrip (the value line);
    //   - value collection whose value is a scalar → MultiValueLine (not ported yet);
    //   - no @valueField (owned 1-N part rows) → EntityTable / EntityRepeater (not ported yet).
    if (fi.array) {
      // ALTEA: `fi.typeName` is undefined for thunked (`type: () => X`) array fields, so resolve the row
      // type name from the thunk (fieldTypeName) for the @valueField lookup.
      const rowTypeName = fi.getTypeName();
      const vf = rowTypeName != null ? tryGetValueField(rowTypeName) : null;
      if (vf != null) {
        const valueIsReference = vf.lite || vf.is(Entity);
        if (valueIsReference) {
          // Low-population value type (few rows) → a checkbox list of all options; else the chip strip.
          const tis = tryGetTypeInfos(vf.getTypeName() ?? "").notNull();
          if (tis.length > 0 && tis.every(t => t.lowPopulation))
            return p => <EntityCheckboxList {...p} />;
          return p => <EntityStrip {...p} />;
        }
        return p => <MultiValueLine {...p} />;
      }
      // Owned 1-N part rows: a polymorphic (@implementedBy) element has no uniform column set, so it
      // renders per-row via EntityRepeater; a single concrete row type → EntityTable's grid.
      if (fi.implementations != null)
        return p => <EntityRepeater {...p} />;
      return p => <EntityTable {...p} />;
    }

    // Embedded entity → EntityDetail. ALTEA: detect via the field's actual class (EmbeddedEntity
    // subclass), NOT the string `kind` (undefined for embeddeds) or `typeName` (absent for thunks).
    if (fi.is(EmbeddedEntity))
      return p => <EntityDetail {...p} />;

    // Entity / Lite reference (incl. @implementedBy interface [typeName-only] / @implementedByAll).
    // A single low-population target → EntityCombo (a dropdown of all rows); else EntityLine.
    if (fi.isByAll() || fi.lite || fi.is(Entity) || fi.implementations != null) {
      const tis = tryGetTypeInfos(fi.getTypeName() ?? "").notNull();
      if (tis.length > 0 && tis.every(t => t.lowPopulation))
        return p => <EntityCombo {...p} />;
      return p => <EntityLine {...p} />;
    }

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

    return () => <span className="text-danger">Not supported type {fi.getTypeName() ?? fi.typeName} by AutoLine</span>;
  }
}
