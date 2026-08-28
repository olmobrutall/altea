// Ported from Signum.React/Operations/MultiPropertySetter.tsx — copy-paste + fix. The "bulk
// modifications" dialog a contextual operation opens over a SearchControl selection: a table of
// property SETTERS (property · operation · value), each of which may nest a CONDITION and further
// setters for a collection / part reference. Its output is the `setters` array the three
// `/api/operation/*Multiple` routes apply to each retrieved entity before running the operation
// (server half: ../../server/multiSetter).
//
// altea fixes (this file is where the stub's TODO(port) list is discharged):
//   - name-based client type resolution is GONE: `tryGetTypeInfos(name)` / `getTypeInfos` →
//     `TypeReference.typeInfos()`, `type.name == IsByAll` → `type.isByAll()`, `type.isCollection` →
//     `.array`, `type.isEmbedded` → `.is(EmbeddedEntity)`, `type.isLite` → `.lite`, and
//     `tis[0].kind == "Enum"` → `type.getEnum() != null` (altea attaches no TypeInfo to an enum).
//   - PropertyRoute deltas: `typeReference()` → `type`, `propertyPath()` → `propertyString()` (which
//     THROWS on a Root route, hence the guard), `member` is the FieldInfo (`.niceToString()`, not
//     `.niceName`), `addMember("Indexer", "Item", true)` → `add("Item")`, and `allParents()` is a local
//     walk (altea has no such method).
//   - `PropertyRoute.parse(rootType, member.name)` → `parentRoute.add(member.name)`: Signum keys a
//     TypeInfo's members by their FULL dotted path from the root, altea's `fields` by the simple name.
//   - `PropertyOperation.niceToString(op)` / `FilterOperation.niceToString(op)` → `Enum.niceName(…Enum, op)`.
//   - `member.isIgnoredEnum` → `Enum.mappedValues` (Signum's notIgnoredValues) fed to EnumLine's
//     `optionItems`, which maps each member NAME to the ordinal a bound enum field actually holds.
//   - `getNiceTypeName` is not re-declared: altea already routes that job through
//     `Finder.getTypeNiceName` (see SearchControl/ColumnEditor's header).
//
// TWO DIVERGENCES worth knowing:
//   1. A setter's `property` path NEVER crosses an entity reference. altea's `PropertyRoute.add`
//      RE-ROOTS at the referenced concrete type (Signum's AddImp), so "supplier.companyName" is not a
//      representable route string — the prefix is lost. Nothing is given up: a reference is edited
//      through `ModifyEntity` / `CreateNewEntity`, whose nested setters are rooted at the referenced
//      type, which is the same mechanism a collection already uses. Signum's own PropertyPart tried to
//      allow the in-path form for a Part and got the condition wrong
//      (`ti.entityKind == "Part" || ti?.entityKind != "SharedPart"` — true for BOTH branches it meant to
//      admit), so a Part could not be drilled into there either.
//   2. MList is gone, so a collection's element is a `@part` row ENTITY, never an embedded — Signum's
//      `isCollection && (isEmbedded || isPart(name))` collapses to "the element is a part entity".
import * as React from 'react'
import { Modal } from 'react-bootstrap'
import { DropdownList } from 'react-widgets-up'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Dic, classes } from '../../data/globals'
import { Enum } from '../../data/enum'
import { EmbeddedEntity } from '../../data/entity'
import type { Entity } from '../../data/entity'
import type { Lite } from '../../data/lite'
import { TypeReference } from '../../data/reflection'
import { PropertyRoute, PropertyRouteType } from '../../data/propertyRoute'
import { cleanTypeName, resolveCleanType } from '../../data/registration'
import { tryGetFilterType } from '../../data/dynamicQuery/queryUtils'
import { PropertyOperationEnum } from '../../data/operations'
import type { PropertyOperation } from '../../data/operations'
import { FilterOperationEnum } from '../../data/dynamicQueries'
import type { FilterOperation } from '../../data/dynamicQueries'
import { EntityControlMessage, JavascriptMessage, OperationMessage, SearchMessage } from '../../data/uiMessages'
import type { MemberInfo, TypeInfo, OperationMetadata } from '../Reflection'
import { filterOperations } from '../FindOptions'
import { StyleContext, TypeContext } from '../TypeContext'
import { Binding } from '../binding'
import { openModal, type IModalProps } from '../Modals'
import { ErrorBoundary } from '../Components'
import { LinkButton } from '../Basics/LinkButton'
import { useForceUpdate } from '../Hooks'
import { Finder } from '../Finder'
import SelectorModal from '../SelectorModal'
import { AutoLine } from '../Lines/AutoLine'
import { EnumLine } from '../Lines/EnumLine'
import { EntityLine } from '../Lines/EntityLine'
import { EntityCombo } from '../Lines/EntityCombo'
import type { Operations } from '../Operations'
import './MultiPropertySetter.css';

interface MultiPropertySetterModalProps extends IModalProps<boolean | undefined> {
  typeInfo: TypeInfo;
  lites: Lite<Entity>[];
  operationInfo: OperationMetadata;
  setters: Operations.API.PropertySetter[];
}

export function MultiPropertySetterModal(p: MultiPropertySetterModalProps): React.ReactElement {

  const [show, setShow] = React.useState(true);
  const answerRef = React.useRef<boolean | undefined>(undefined);
  const forceUpdate = useForceUpdate();

  function handleOkClicked() {
    answerRef.current = true;
    setShow(false);
  }

  function handleCancelClicked() {
    setShow(false);
  }

  function handleOnExited() {
    p.onExited!(answerRef.current);
  }

  return (
    <Modal onHide={handleCancelClicked} show={show} className="message-modal" size="xl" onExited={handleOnExited}>
      <div className="modal-header">
        <h1 className="modal-title h5">{OperationMessage.BulkModifications.niceToString()}</h1>
        <button type="button" className="btn-close" data-dismiss="modal" aria-label={EntityControlMessage.Close.niceToString()} onClick={handleCancelClicked} />
      </div>
      <div className="modal-body">
        <ErrorBoundary>
          <MultiPropertySetter setters={p.setters} root={PropertyRoute.root(p.typeInfo.ctor!)} isPredicate={false} onChange={forceUpdate} />
        </ErrorBoundary>
      </div>
      <div className="modal-footer">
        <p>
          {OperationMessage.PleaseConfirmThatYouWouldLikeToApplyTheAboveChangesAndExecute0Over12.niceToString().formatHtml(
            <strong>{p.operationInfo.niceName}</strong>,
            <strong>{p.lites.length}</strong>,
            <strong>{p.lites.length == 1 ? p.typeInfo.getNiceName() : p.typeInfo.getNicePluralName()}</strong>
          )}
        </p>
        <br />
        <button className="btn btn-primary sf-entity-button sf-ok-button"
          disabled={p.setters.some(s => !isValid(s))} onClick={handleOkClicked}>
          {JavascriptMessage.ok.niceToString()}
        </button>
        <button className="btn btn-tertiary sf-entity-button sf-close-button" onClick={handleCancelClicked}>
          {JavascriptMessage.cancel.niceToString()}
        </button>
      </div>
    </Modal>
  );

  function isValid(setter: Operations.API.PropertySetter) {
    return setter.property != null;
  }
}

export namespace MultiPropertySetterModal {
  export function show(typeInfo: TypeInfo, lites: Lite<Entity>[], operationInfo: OperationMetadata, setters?: Operations.API.PropertySetter[]): Promise<Operations.API.PropertySetter[] | undefined> {
    var settersOrDefault = setters ?? [{ property: null!, operation: null! } as Operations.API.PropertySetter];
    return openModal<boolean | undefined>(<MultiPropertySetterModal typeInfo={typeInfo} lites={lites} operationInfo={operationInfo} setters={settersOrDefault} />).then(a => a ? settersOrDefault : undefined);
  };
}

export function MultiPropertySetter({ root, setters, onChange, isPredicate }: { root: PropertyRoute, setters: Operations.API.PropertySetter[], isPredicate: boolean, onChange: () => void }): React.ReactElement {

  function handleNewPropertySetter(e: React.MouseEvent) {
    e.preventDefault();
    setters.push({ property: null!, operation: null! });
    onChange();
  }

  function handleDeletePropertySetter(ps: Operations.API.PropertySetter) {
    setters.remove(ps);
    onChange();
  }

  var addElement = isPredicate ?
    SearchMessage.AddFilter.niceToString() :
    OperationMessage.AddSetter.niceToString()

  return (
    <table className="table-sm">
      <thead>
        <tr>
          <th style={{ minWidth: "24px" }}></th>
          <th>{SearchMessage.Field.niceToString()}</th>
          <th>{OperationMessage.Operation.niceToString()}</th>
          <th style={{ paddingRight: "20px" }}>{SearchMessage.Value.niceToString()}</th>
        </tr>
      </thead>
      <tbody>
        {setters.map((ps, i) =>
          <PropertySetterComponent
            key={i} setter={ps} onDeleteSetter={handleDeletePropertySetter}
            root={root}
            isPredicate={isPredicate}
            onSetterChanged={() => onChange()} />
        )}
        {
          <tr className="sf-property-create">
            <td colSpan={4}>
              <LinkButton
                title={StyleContext.default.titleLabels ? addElement : undefined}
                className="sf-line-button sf-create sf-create-condition"
                onClick={e => handleNewPropertySetter(e)}>
                <FontAwesomeIcon aria-hidden={true} icon="plus" className="sf-create me-1" />{addElement}
              </LinkButton>
            </td>
          </tr>
        }
      </tbody>
    </table>
  );
}

// The concrete part-entity TypeInfos a reference/collection targets (Signum's `isPart` + the
// `entityKind == "Part" || "SharedPart"` filter its three call sites repeat).
function partTypeInfos(type: TypeReference): TypeInfo[] {
  return type.typeInfos().filter(ti => ti.entityKind == "Part" || ti.entityKind == "SharedPart");
}

export function getPropertyOperations(type: TypeReference): PropertyOperation[] {

  // A collection is `@part` child ROWS in altea (MList is gone), so "the element is owned" is exactly
  // "the element type is a part entity" — Signum's separate isEmbedded branch cannot occur.
  if (type.array)
    return partTypeInfos(type).length > 0 ?
      ["AddNewElement", "ChangeElements", "RemoveElementsWhere"] :
      ["AddElement", "RemoveElement"];

  if (type.is(EmbeddedEntity))
    return ["Set", "CreateNewEntity", "ModifyEntity"];

  if (type.isByAll())
    return ["Set"];

  var typeInfos = type.typeInfos();
  if (typeInfos.length == 0)   // a value / enum property
    return ["Set"];

  if (partTypeInfos(type).length == 0)
    return ["Set"];

  return ["Set", "CreateNewEntity", "ModifyEntity"];
}

export interface PropertySetterComponentProps {
  root: PropertyRoute;
  setter: Operations.API.PropertySetter;
  onDeleteSetter: (pi: Operations.API.PropertySetter) => void;
  isPredicate: boolean;
  onSetterChanged: () => void;
}


export function PropertySetterComponent(p: PropertySetterComponentProps): React.ReactElement {

  const forceUpdate = useForceUpdate();

  function handleDeleteSetter(e: React.MouseEvent<any>) {
    e.preventDefault();
    p.onDeleteSetter(p.setter);
  }

  function handlePropertyChanged(newProperty: PropertyRoute | null | undefined) {
    const s = p.setter;
    s.property = newProperty == null ? undefined! : relativePath(p.root, newProperty);

    s.operation = newProperty == null || p.isPredicate ? null! : getPropertyOperations(newProperty.type).firstOrNull()!;

    const filterType = newProperty && tryGetFilterType(newProperty.type);
    s.filterOperation = newProperty == null || !p.isPredicate || filterType == null ? null! : filterOperations[filterType].firstOrNull()!;

    s.value = undefined;
    fixOperation(s, newProperty).then(() => {
      p.onSetterChanged();
      forceUpdate();
    });
  }

  function handleChangeOperation(event: React.FormEvent<HTMLSelectElement>) {
    const operation = (event.currentTarget as HTMLSelectElement).value as PropertyOperation;
    const s = p.setter;
    s.operation = operation;
    fixOperation(s, pr!).then(() => {
      p.onSetterChanged();
      forceUpdate();
    });
  }

  function handleChangeFilterOperation(event: React.FormEvent<HTMLSelectElement>) {
    const fOperation = (event.currentTarget as HTMLSelectElement).value as FilterOperation;
    const s = p.setter;
    s.filterOperation = fOperation;
  }

  function fixOperation(s: Operations.API.PropertySetter, pr: PropertyRoute | null | undefined): Promise<void> {

    s.value = undefined;
    s.predicate = s.operation && showPredicate(s.operation) ? [] : undefined;
    s.setters = s.operation && showSetters(s.operation) ? [] : undefined;
    if (pr && (s.setters || s.predicate)) {
      // Which concrete part type the nested setters build / modify. Only asked when the route can be
      // polymorphic; a mono-typed reference has exactly one answer, and SelectorModal.chooseType
      // resolves a single option without showing a modal.
      return SelectorModal.chooseType(partTypeInfos(pr.type)).then(ti => { s.entityType = ti && cleanNameOf(ti); });
    }

    s.entityType = undefined;
    return Promise.resolve(undefined);
  }

  const pr = React.useMemo(() => p.setter.property == null ? null : p.root.addMany(p.setter.property),
    [p.root, p.setter.property]);

  var operations = pr == null || p.isPredicate ? undefined : getPropertyOperations(pr.type);

  var filterType = p.isPredicate && pr ? tryGetFilterType(pr.type) : null;
  var fOperations = filterType ? filterOperations[filterType] : null;

  // The root the NESTED setters (and the condition) are written against: the collection's element for a
  // collection, the embedded itself for an embedded, and a fresh Root route for a part reference —
  // which is what makes divergence (1) above hold. `entityType` is what fixOperation just chose.
  var subRoot = pr == null ? null :
    pr.type.array ? pr.add("Item") :
      pr.type.is(EmbeddedEntity) ? pr :
        subRootOfEntityType(p.setter.entityType);

  return (
    <>
      <tr className="sf-property-setter">
        <td>
          {<LinkButton
            title={StyleContext.default.titleLabels ? SearchMessage.DeleteFilter.niceToString() : undefined}
            className="sf-line-button sf-remove"
            onClick={handleDeleteSetter}>
            <FontAwesomeIcon aria-hidden={true} icon="xmark" />
          </LinkButton>}
        </td>
        <td>
          <div className="rw-widget-xs">
            <PropertySelector
              property={pr}
              root={p.root}
              onPropertyChanged={handlePropertyChanged} />
          </div>
        </td>
        <td>
          {
            operations &&
            <select className="form-select form-select-xs" value={p.setter.operation} disabled={operations.length == 1} onChange={handleChangeOperation}>
              {operations.map((op, i) => <option key={i} value={op}>{Enum.niceName(PropertyOperationEnum, op)}</option>)}
            </select>
          }

          {
            fOperations &&
            <select className="form-select form-select-xs" value={p.setter.filterOperation} disabled={fOperations.length == 1} onChange={handleChangeFilterOperation}>
              {fOperations.map((op, i) => <option key={i} value={op}>{Enum.niceName(FilterOperationEnum, op)}</option>)}
            </select>
          }
        </td>
        <td className="sf-filter-value">
          {p.isPredicate ?
            <>
              {p.setter.property && renderValue()}
            </> :
            <>
              {p.setter.property && p.setter.operation && showValue(p.setter.operation) && renderValue()}
              {subRoot && p.setter.operation && showPredicate(p.setter.operation) && pr && <div>
                <h2 className="h5">{OperationMessage.Condition.niceToString()}</h2>
                <MultiPropertySetter onChange={p.onSetterChanged} setters={p.setter.predicate!} isPredicate={true} root={subRoot} />
              </div>
              }
              {subRoot && p.setter.operation && showSetters(p.setter.operation) && pr && <div>
                <h2 className="h5">{OperationMessage.Setters.niceToString()}</h2>
                <MultiPropertySetter onChange={p.onSetterChanged} setters={p.setter.setters!} isPredicate={false} root={subRoot} />
              </div>
              }
            </>
          }
        </td>
      </tr>
    </>
  );

  function renderValue() {

    const ctx = new TypeContext<any>(undefined, { formGroupStyle: "None", formSize: "xs" }, pr!, Binding.create(p.setter, a => a.value));

    return createSetterValueControl(ctx, handleValueChange);
  }

  function handleValueChange() {
    p.onSetterChanged();
  }
}

// The setter's `property`: the route's path relative to the block's root (which is itself a route, so a
// nested block's paths are rootless too). `propertyString()` THROWS on a Root route, hence the branch —
// Signum reads `propertyPath()`, which answers "" there.
function relativePath(root: PropertyRoute, property: PropertyRoute): string {
  const full = property.propertyString();
  if (root.propertyRouteType == PropertyRouteType.Root)
    return full;

  const rest = full.after(root.propertyString());
  return rest.startsWith(".") ? rest.after(".") : rest;
}

// A part entity's stored `entityType` is its CLEAN type name — the key the server resolves it back by
// (Signum stores `TypeInfo.name`, which IS the clean name there).
function cleanNameOf(ti: TypeInfo): string {
  return cleanTypeName(ti.ctor!);
}

function subRootOfEntityType(entityType: string | undefined): PropertyRoute | null {
  const ctor = entityType == null ? undefined : resolveCleanType(entityType);
  return ctor == undefined ? null : PropertyRoute.root(ctor);
}

function showValue(o: PropertyOperation) {
  return o == "Set" || o == "AddElement" || o == "RemoveElement";
}

function showPredicate(o: PropertyOperation) {
  return o == "ChangeElements" || o == "RemoveElementsWhere";
}

function showSetters(o: PropertyOperation) {
  return o == "AddNewElement" || o == "ChangeElements" || o == "CreateNewEntity" || o == "ModifyEntity";
}

export function createSetterValueControl(ctx: TypeContext<any>, handleValueChange: () => void): React.ReactElement {
  var tr = ctx.propertyRoute!.type;

  if (tr.is(EmbeddedEntity))
    return <EntityLine ctx={ctx} autocomplete={null} onChange={handleValueChange} create={false} />;

  const enumObj = tr.getEnum();
  if (enumObj != null)
    return <EnumLine ctx={ctx} optionItems={Enum.mappedValues(enumObj as never)} onChange={handleValueChange} />;

  if (tr.lite)
    return <EntityLine ctx={ctx} onChange={handleValueChange} create={false} />;

  var tis = tr.typeInfos();

  if (tr.isByAll() || tis.length > 0) {
    if (tr.isByAll() || tis.some(ti => !ti.lowPopulation))
      return <EntityLine ctx={ctx} onChange={handleValueChange} />;
    else
      return <EntityCombo ctx={ctx} onChange={handleValueChange} />
  }

  return <AutoLine ctx={ctx} onChange={handleValueChange} />;
}

interface PropertySelectorProps {
  root: PropertyRoute;
  property: PropertyRoute | undefined | null;
  onPropertyChanged: (newProperty: PropertyRoute | undefined) => void;
}

export default function PropertySelector(p: PropertySelectorProps): React.ReactElement {
  var lastTokenChanged = React.useRef<string | undefined>(undefined);

  var rootList = allParents(p.root);

  let propertyList: (PropertyRoute | undefined)[] = p.property ? allParents(p.property).filter((pr, i) => i >= rootList.length) : [];

  propertyList.push(undefined);

  return (
    <div className={classes("sf-property-selector", p.property == null ? "has-error" : null)}>
      {propertyList.map((a, i) => <PropertyPart
        key={i == 0 ? "__first__" : propertyList[i - 1]!.propertyString()}
        onRouteSelected={pr => {
          p.onPropertyChanged && p.onPropertyChanged(pr);
        }}
        defaultOpen={lastTokenChanged.current && i > 0 && lastTokenChanged.current == propertyList[i - 1]!.propertyString() ? true : false}
        parentRoute={i == 0 ? p.root : propertyList[i - 1]!}
        selectedRoute={a} />)}
    </div>
  );
}

// Signum's `PropertyRoute.allParents()` (root-first, this route last) — altea has no such method.
function allParents(route: PropertyRoute): PropertyRoute[] {
  const result: PropertyRoute[] = [];
  for (let r: PropertyRoute | undefined = route; r != undefined; r = r.parent)
    result.unshift(r);
  return result;
}

interface PropertyPartProps {
  parentRoute: PropertyRoute;
  selectedRoute: PropertyRoute | undefined;
  onRouteSelected: (newRoute: PropertyRoute | undefined) => void;
  defaultOpen: boolean;
}

export function PropertyPart(p: PropertyPartProps): React.ReactElement | null {

  if (p.parentRoute.propertyRouteType != PropertyRouteType.Mixin &&
    p.parentRoute.propertyRouteType != PropertyRouteType.Root) {
    const tr = p.parentRoute.type;
    // Stop at every entity reference: `add` re-roots there, so the path could not be written down
    // (divergence 1 in the header). An embedded / a collection of parts keeps navigating.
    if (!tr.array && tr.typeInfos().some(ti => ti.kind == "Entity"))
      return null;
  }

  // ENGINE-OWNED members are not offered. Signum lists them (its `TypeInfo.members` carries Id / Ticks
  // and its selector filters nothing), but setting either in bulk is never meaningful: `id` would
  // repoint the row and `ticks` is the concurrency stamp — same reason the serializer excludes both.
  // `@backReference` / `@rowOrder` are filled by the save cascade, and a `@serialize(false)` field is
  // bookkeeping, not a property.
  const subMembers = Dic.getValues(p.parentRoute.subMembers())
    .filter(fi => !fi.noSerialize && !fi.isBackReference && !fi.isRowOrder && fi.name != "id" && fi.name != "ticks");

  if (subMembers.length == 0)
    return null;

  return (
    <div className="sf-property-part" onKeyUp={handleKeyUp} onKeyDown={handleKeyUp}>
      <DropdownList
        filter="contains"
        data={subMembers}
        value={p.selectedRoute?.fieldInfo}
        onChange={value => handleOnChange(value as MemberInfo)}
        dataKey={(item: unknown) => (item as MemberInfo | null)?.name}
        textField={(item: unknown) => (item as MemberInfo | null)?.niceToString() ?? ""}
        renderValue={a => <PropertyItem item={a.item as MemberInfo | null} />}
        renderListItem={a => <PropertyItemOptional item={a.item as MemberInfo | null} />}
        defaultOpen={p.defaultOpen}
      />
    </div>
  );


  function handleOnChange(value: MemberInfo) {
    // Signum re-parses from the root type (its member names ARE full paths); altea's `fields` are keyed
    // by the simple name, so the step is taken off the parent route.
    p.onRouteSelected(p.parentRoute.add(value.name));
  }

  function handleKeyUp(e: React.KeyboardEvent<any>) {
    if (e.key == "Enter") {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}

export function PropertyItem(p: { item: MemberInfo | null }): React.ReactElement | null {

  const item = p.item;

  if (item == null)
    return null;

  return (
    <span
      style={{ color: getTypeColor(item) }}
      title={StyleContext.default.titleLabels ? Finder.getTypeNiceName(item) : undefined}>
      {item.niceToString() ?? " - no member - "}
    </span>
  );
}

export function PropertyItemOptional(p: { item: MemberInfo | null }): React.ReactElement {

  const item = p.item;

  if (item == null)
    return <span> - </span>;


  return (
    <span data-member={item.name}
      style={{ color: getTypeColor(item) }}
      title={StyleContext.default.titleLabels ? Finder.getTypeNiceName(item) : undefined}>
      {item.niceToString() ?? "- no member - "}
    </span>
  );
}


// The property's type colour. Signum hardcodes hex here — including `#000000` for a plain value, which is
// invisible on a dark background. altea already moved the token tree to a theme-aware `--qt-*` palette
// (SearchControl/Search.css, read by `QueryToken.queryTokenColor`), so this reuses it: same categories,
// same variables, one place to retheme. `--qt-value` is Bootstrap's own body colour, so a value member
// follows the light/dark switch instead of staying black.
export function getTypeColor(type: TypeReference): string {

  if (type.array)
    return "var(--qt-collection)";

  switch (tryGetFilterType(type)) {
    case "Integer":
    case "Decimal":
    case "String":
    case "Guid":
    case "Boolean": return "var(--qt-value)";
    case "DateTime": return "var(--qt-date)";
    case "Time": return "var(--qt-time)";
    case "Enum": return "var(--qt-enum)";
    case "Lite": return "var(--qt-lite)";
    case "Embedded": return "var(--qt-embedded)";
    default: return "var(--qt-exotic)";
  }
}
