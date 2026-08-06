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
import { PropertyRoute } from '../../data/propertyRoute'
import { isNumberType } from '../numberFormat'
import { Entity, EmbeddedEntity } from '../../data/entity'
import { FieldInfo, type TypeReference } from '../../data/reflection'
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

export interface AutoLineProps extends LineBaseProps<any> {
  propertyRoute?: PropertyRoute; //For AutoLineModal
  valueHtmlAttributes?: React.HTMLAttributes<any>;
}


export function AutoLine(p: AutoLineProps): React.ReactElement | null {
  const pr = p.ctx.propertyRoute;

  // ALTEA DIVERGENCE: Signum's empty check is `p.ctx.value == ""` (loose). Signum dates are ISO STRINGS,
  // so that's a plain string compare. altea dates are Temporal.PlainDate OBJECTS (luxon→Temporal), and a
  // loose `object == ""` forces ToPrimitive → Temporal.PlainDate.valueOf(), which throws "Cannot use
  // valueOf" by design. Use strict `=== ""` (an empty-string sentinel never needs coercion) — `== undefined`
  // still catches null/undefined without coercing.
  var isHidden = p.ctx.memberType == null && pr == null || p.visible == false || p.hideIfNull && (p.ctx.value == undefined || p.ctx.value === "");
  if (isHidden)
    return null;

  const fi = p.ctx.memberType ?? pr!.fieldInfo!;
  const factory = React.useMemo(() => AutoLine.getComponentFactory(fi, p.propertyRoute ?? pr), [(p.propertyRoute ?? pr)?.toString(), fi.getTypeName()]);

  return factory(p);
}

export interface AutoLineFactoryRule {
  name: string;
  factory: (fi: TypeReference, pr?: PropertyRoute) => undefined | ((p: AutoLineProps) => React.ReactElement);
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

  export function registerComponent(type: string, factory: (fi: TypeReference, pr?: PropertyRoute) => undefined | ((p: AutoLineProps) => React.ReactElement), name?: string): void {
    (customTypeComponent[type] ??= []).push({ name: name ?? type, factory });
  }

  export function getComponentFactory(fi: TypeReference, pr?: PropertyRoute): (props: AutoLineProps) => React.ReactElement {

    const customs = customTypeComponent[fi.getTypeName() ?? fi.typeName]?.map(rule => rule.factory(fi, pr)).notNull().first();

    if (customs != null)
      return customs

    // Collection (R[]): altea has no MList — the array holds ROW entities. Branch on whether the row
    // type declares a @valueField (FieldInfo.isValueField):
    //   - value collection whose value is a reference (entity/Lite) → EntityStrip (the value line);
    //   - value collection whose value is a scalar → MultiValueLine (not ported yet);
    //   - no @valueField (owned 1-N part rows) → EntityTable / EntityRepeater (not ported yet).
    if (fi.array) {
      // Owned polymorphic rows (@implementedBy / @implementedByAll) have no uniform @valueField or
      // column set → per-row EntityRepeater. Checked FIRST so the single-row-type `typeInfo()` below
      // never sees a multi-type reference.
      if (fi.implementations != null)
        return p => <EntityRepeater {...p} />;

      // Single concrete row type: a @valueField (resolved off the row's TypeInfo) means it's a value
      // collection (junction / 1-N value); otherwise the whole row is an owned part → EntityTable grid.
      const vf = fi.typeInfo().valueField;
      if (vf != null) {
        const valueIsReference = vf.lite || vf.is(Entity);
        if (valueIsReference) {
          // Low-population value type (few rows) → a checkbox list of all options; else the chip strip.
          const tis = vf.typeInfos();
          if (tis.length > 0 && tis.every(t => t.lowPopulation))
            return p => <EntityCheckboxList {...p} />;
          return p => <EntityStrip {...p} />;
        }
        return p => <MultiValueLine {...p} />;
      }
      return p => <EntityTable {...p} />;
    }

    // Embedded entity → EntityDetail. ALTEA: detect via the field's actual class (EmbeddedEntity
    // subclass), NOT the string `kind` (undefined for embeddeds) or `typeName` (absent for thunks).
    if (fi.is(EmbeddedEntity))
      return p => <EntityDetail {...p} />;

    // Entity / Lite reference (incl. @implementedBy interface [typeName-only] / @implementedByAll).
    // A single low-population target → EntityCombo (a dropdown of all rows); else EntityLine.
    if (fi.isByAll() || fi.lite || fi.is(Entity) || fi.implementations != null) {
      const tis = fi.typeInfos();
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
      // format / isMultiline are FieldInfo display members (not on a bare TypeReference — those come
      // from a real field). A bare TypeReference String falls through to the plain TextBox.
      const field = fi instanceof FieldInfo ? fi : undefined;
      if (field?.format == "Password")
        return p => <PasswordLine {...p} />;

      if (field?.format == "Color")
        return p => <ColorLine {...p} />;

      if (field?.isMultiline)
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
