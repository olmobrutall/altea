import * as React from 'react'
import { getTypeName, tryGetTypeInfo } from './Reflection'
import type { PseudoType, MemberInfo, IType } from './Reflection'
import { PropertyRoute, PropertyRouteType } from '../entities/propertyRoute'
import { TypeReference } from '../entities/reflection'
import { ReadonlyBinding, createBinding, getLambdaMembers, getFieldMembers, Binding } from './binding'
import type { IBinding, LambdaMember } from './binding'
import type { Quoted } from 'quote-transformer/quoted'
import { BaseEntity } from '../entities/entity'
import type { Entity, MixinEntity, ModelEntity, Type } from '../entities/entity'
import type { EntityPack } from '../entities/entityPack'
import type { ModelState } from '../entities/validation'

// --- Temporary stubs for modules not yet ported (Phase 2/3). Restore the real imports then:
//   EntityOperationContext <- ./Operations,  ViewPromise <- ./Navigator,  EmbeddedWidget <- ./Frames/Widgets
type EntityOperationContext<T> = any;
type ViewPromise<T> = any;
type EmbeddedWidget = any;

export type FormGroupStyle =
  "None" |  /// Only the value is rendered.
  "Basic" |   /// Label on top, value below.
  "BasicDown" |  /// Value on top, label below.
  "SrOnly" |    /// Label visible only for Screen-Readers.
  "LabelColumns" |
  "FloatingLabel"; /// (default) Label on the left, value on the right (exept RTL). Affected by labelColumns / valueColumns

export type FormSize =
  "xs" |
  "sm" |
  "md" |
  "lg";


export class StyleContext {
  styleOptions: StyleOptions;
  parent: StyleContext;

  constructor(parent: StyleContext | undefined, styleOptions: StyleOptions | undefined) {
    this.parent = parent || StyleContext.default;
    this.styleOptions = styleOptions || {};

    if (this.styleOptions.labelColumns && !this.styleOptions.valueColumns)
      this.styleOptions.valueColumns = StyleContext.bsColumnsInvert(toBsColumn(this.styleOptions.labelColumns));
  }

  static default: StyleContext = new StyleContext(undefined,
    {
      formGroupStyle: "LabelColumns",
      formSize: "sm",
      labelColumns: { sm: 2 },
      readOnly: false,
      placeholderLabels: false,
      titleLabels: true,
      readonlyAsPlainText: false,
      frame: undefined,
    });

  get formGroupStyle(): FormGroupStyle {
    return this.styleOptions.formGroupStyle != undefined ? this.styleOptions.formGroupStyle : this.parent.formGroupStyle;
  }

  get formSize(): FormSize {
    return this.styleOptions.formSize != undefined ? this.styleOptions.formSize : this.parent.formSize;
  }

  get formGroupClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "form-group form-group-xs";
      case "sm": return "form-group form-group-sm";
      case "md": return "form-group";
      case "lg": return "form-group form-group-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get colFormLabelClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "col-form-label col-form-label-xs";
      case "sm": return "col-form-label col-form-label-sm";
      case "md": return "col-form-label";
      case "lg": return "col-form-label col-form-label-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get labelClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "label-xs";
      case "sm": return "label-sm";
      case "md": return undefined;
      case "lg": return undefined;
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get rwWidgetClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "rw-widget-xs";
      case "sm": return "rw-widget-sm";
      case "md": return "";
      case "lg": return "rw-widget-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get inputGroupClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "input-group input-group-xs";
      case "sm": return "input-group input-group-sm";
      case "md": return "input-group";
      case "lg": return "input-group input-group-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  inputGroupVerticalClass(mode: "before" | "after"): string | undefined {
    switch (this.formSize) {
      case "xs": return "input-group-vertical " + mode + " input-group-xs";
      case "sm": return "input-group-vertical " + mode + " input-group-sm";
      case "md": return "input-group-vertical " + mode;
      case "lg": return "input-group-vertical " + mode + " input-group-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get formControlClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "form-control form-control-xs";
      case "sm": return "form-control form-control-sm";
      case "md": return "form-control form-control-md";
      case "lg": return "form-control form-control-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get formSelectClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "form-select form-select-xs";
      case "sm": return "form-select form-select-sm";
      case "md": return "form-select";
      case "lg": return "form-select form-select-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get formControlPlainTextClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "form-control-plaintext form-control-xs";
      case "sm": return "form-control-plaintext form-control-sm";
      case "md": return "form-control-plaintext form-control-md";
      case "lg": return "form-control-plaintext form-control-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get buttonClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "btn-xs";
      case "sm": return "btn-sm";
      case "md": return undefined;
      case "lg": return "btn-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get placeholderLabels(): boolean {
    return this.styleOptions.placeholderLabels != undefined ? this.styleOptions.placeholderLabels : this.parent.placeholderLabels;
  }

  get titleLabels(): boolean {
    return this.styleOptions.titleLabels != undefined ? this.styleOptions.titleLabels : this.parent.titleLabels;
  }

  get readonlyAsPlainText(): boolean {
    return this.styleOptions.readonlyAsPlainText != undefined ? this.styleOptions.readonlyAsPlainText : this.parent.readonlyAsPlainText;
  }

  get labelColumns(): BsColumns {
    return this.styleOptions.labelColumns != undefined ? toBsColumn(this.styleOptions.labelColumns) : this.parent.labelColumns;
  }

  get labelColumnsCss(): string {
    return StyleContext.bsColumnsCss(this.labelColumns);
  }

  get valueColumns(): BsColumns {
    return this.styleOptions.valueColumns != undefined ? toBsColumn(this.styleOptions.valueColumns) : this.parent.valueColumns;
  }

  get valueColumnsCss(): string {
    return StyleContext.bsColumnsCss(this.valueColumns);
  }

  get readOnly(): boolean {
    return this.styleOptions.readOnly != undefined ? this.styleOptions.readOnly :
      this.parent ? this.parent.readOnly : false;
  }

  set readOnly(value: boolean) {
    this.styleOptions.readOnly = value;
  }

  get frame(): EntityFrame | undefined {
    if (this.styleOptions.frame)
      return this.styleOptions.frame;

    if (this.parent)
      return this.parent.frame;

    return undefined;
  }


  static bsColumnsCss(bsColumns: BsColumns): string {
    return [
      (bsColumns.xs ? "col-xs-" + bsColumns.xs : ""),
      (bsColumns.sm ? "col-sm-" + bsColumns.sm : ""),
      (bsColumns.md ? "col-md-" + bsColumns.md : ""),
      (bsColumns.lg ? "col-lg-" + bsColumns.lg : ""),
    ].filter(a => a != "").join(" ");
  }

  static bsColumnsInvert(bs: BsColumns): BsColumns {
    return {
      xs: bs.xs ? (12 - bs.xs) : undefined,
      sm: (12 - bs.sm),
      md: bs.md ? (12 - bs.md) : undefined,
      lg: bs.lg ? (12 - bs.lg) : undefined,
    };
  }
}

function toBsColumn(bsColumnOrNumber: BsColumns | number): BsColumns {
  return typeof (bsColumnOrNumber) == "number" ? { sm: bsColumnOrNumber } : bsColumnOrNumber;
}

export interface StyleOptions {
  formGroupStyle?: FormGroupStyle;
  formSize?: FormSize;
  placeholderLabels?: boolean;
  titleLabels?: boolean;
  readonlyAsPlainText?: boolean;
  labelColumns?: BsColumns | number;
  valueColumns?: BsColumns | number;
  readOnly?: boolean;
  frame?: EntityFrame;
}


export interface BsColumns {
  xs?: number;
  sm: number;
  md?: number;
  lg?: number;
}


// Distinguishes an entity/mixin CONSTRUCTOR from a plain selector lambda (both are `function` in
// altea) — a ctor's prototype is a BaseEntity, a lambda's is not. Local to subCtx's arg dispatch
// (was the exported Reflection.isType — the only caller).
function isType(obj: unknown): obj is IType {
  return typeof obj === 'function' && (obj as Function).prototype instanceof BaseEntity;
}

// ALTEA sweep helpers: altea's PropertyRoute is string/route-based (add(name)), not lambda-based
// (Signum's addLambda/tryAddLambdaMember). These translate a parsed LambdaMember / a whole lambda
// into altea route navigation ("Item" for collection indexers, addMixin for mixins).
function addLambdaMember(pr: PropertyRoute, m: LambdaMember): PropertyRoute {
  switch (m.type) {
    case "Member": return pr.add(m.name);
    case "Mixin": return pr.addMixin(m.name);
    case "Indexer": return pr.add("Item");
  }
}

function tryAddLambdaMember(pr: PropertyRoute | undefined, m: LambdaMember): PropertyRoute | undefined {
  if (pr == null) return undefined;
  try { return addLambdaMember(pr, m); } catch { return undefined; }
}

function addLambda(pr: PropertyRoute, lambda: Quoted<(val: any) => any>): PropertyRoute {
  return getLambdaMembers(lambda).reduce(addLambdaMember, pr);
}

function tryAddLambda(pr: PropertyRoute, lambda: Quoted<(val: any) => any>): PropertyRoute | undefined {
  try { return addLambda(pr, lambda); } catch { return undefined; }
}


export class TypeContext<T> extends StyleContext {

  propertyRoute: PropertyRoute | undefined; /*Because of optional TypeInfo*/
  // ALTEA (Stage 4 divergence from Signum): a TypeContext carries EITHER a PropertyRoute OR a bare
  // TypeReference. The PropertyRoute path is the field/entity case (its fieldInfo is the type facet);
  // the TypeReference path is for a value with no property route — e.g. a FilterBuilder value editor
  // built off a QueryToken.type. When `typeReference` is used, unit/format must be passed manually to
  // the line (there is no route to read them from). `memberType` returns whichever applies.
  typeReference: TypeReference | undefined;
  binding: IBinding<T>; //Could be null on removed elements in Time Machine
  previousVersion?: { value: T, oldIndex?: number, isMoved?: boolean }; //Used for Time Machine
  prefix: string;

  get value(): T {
    if (this.binding == undefined)
      return undefined as any; //React Dev Tools

    return this.binding.getValue();
  }

  set value(val: T) {
    this.binding.setValue(val);
  }

  get error(): string | undefined {
    if (this.binding == undefined)
      return undefined as any; //React Dev Tools

    return this.binding.getError();
  }

  set error(val: string | undefined) {
    this.binding.setError(val);
  }

  get index(): number | undefined {
    // ALTEA: a collection element binds by numeric array index (a plain Binding), not an
    // MListElementBinding. Read the numeric member, else inherit from the parent context.
    const member = (this.binding as Binding<any> | undefined)?.member;
    return typeof member === "number" ? member : (this.parent as TypeContext<any>)?.index;
  }

  static root<T extends BaseEntity>(value: T, styleOptions?: StyleOptions, parent?: StyleContext): TypeContext<T> {
    // ALTEA: value.Type (string) -> the real constructor.
    return new TypeContext(parent, styleOptions, PropertyRoute.root(value.constructor as Type<BaseEntity>), new ReadonlyBinding<T>(value, ""));
  }

  constructor(parent: StyleContext | undefined, styleOptions: StyleOptions | undefined, route: PropertyRoute | TypeReference | undefined, binding: IBinding<T>, prefix?: string) {
    super(parent, styleOptions);
    if (route instanceof PropertyRoute)
      this.propertyRoute = route;
    else
      this.typeReference = route;
    this.binding = binding;

    this.prefix = prefix || ((parent && (parent as TypeContext<any>).prefix || "") + binding?.suffix);
  }

  // The type facet of this context: the property route's FieldInfo, or the bare TypeReference. Both
  // are TypeReferences, so lines read type facts (typeName, is(Entity), lite, array, …) uniformly.
  get memberType(): TypeReference | undefined {
    return this.propertyRoute?.fieldInfo ?? this.typeReference;
  }

  subCtx(styleOptions: StyleOptions): TypeContext<T>
  subCtx<R>(property: Quoted<(val: T) => R>, styleOptions?: StyleOptions): TypeContext<R>
  subCtx<M extends MixinEntity>(mixin: Type<M>, styleOptions?: StyleOptions): TypeContext<M> //Only id T extends Entity!
  subCtx(field: string, styleOptions?: StyleOptions): TypeContext<any>
  subCtx(arg: Quoted<(val: T) => any> | IType | string | StyleOptions, styleOptions?: StyleOptions): TypeContext<any> {
    if (typeof arg == "object" && !isType(arg)) {
      var nc = new TypeContext<T>(this, arg, this.propertyRoute ?? this.typeReference, this.binding, this.prefix);
      nc.previousVersion = this.previousVersion;

      return nc;
    }

    // ALTEA: a mixin Type is a real CONSTRUCTOR (a function), so isType(arg) must be tested BEFORE
    // the `typeof arg == "function"` lambda branch (Signum's mixin Type was a { typeName } object).
    const lambdaMembers: LambdaMember[] =
      isType(arg) ? [{ type: "Mixin", name: (arg as Function).name } as LambdaMember] :
        typeof arg == "function" ? getLambdaMembers(arg as (val: T) => any) :
          getFieldMembers(arg as string);

    const subRoute = lambdaMembers.reduce<PropertyRoute | undefined>((pr, m) => tryAddLambdaMember(pr, m), this.propertyRoute);

    const binding = createBinding(this.value, lambdaMembers);

    const result = new TypeContext<any>(this, styleOptions, subRoute, binding);

    if (this.previousVersion && this.previousVersion.value) {
      result.previousVersion = { value: createBinding(this.previousVersion.value, lambdaMembers).getValue() };
    }

    return result;
  }

  cast<R extends T & BaseEntity>(type: Type<R>): TypeContext<R>;
  cast(): TypeContext<any>;
  cast(type?: Type<any>): TypeContext<any> {
    const entity = this.value as any as Entity;

    // ALTEA: entity.Type (string) -> getTypeName(entity).
    const typeName = type != null ? getTypeName(type) : getTypeName(entity);
    if (typeName != getTypeName(entity))
      throw new Error(`Impossible to cast ${getTypeName(entity)} into ${typeName}`);

    const newPr = this.propertyRoute == null ? undefined : PropertyRoute.root(entity.constructor as Type<BaseEntity>);

    return new TypeContext<any>(this, undefined, newPr, new ReadonlyBinding(entity, ""));
  }

  as<R extends T & BaseEntity>(type: Type<R>): TypeContext<R> | undefined {

    const entity = this.value as any as Entity;

    if (getTypeName(type) != getTypeName(entity))
      return undefined;

    const newPr = PropertyRoute.root(entity.constructor as Type<BaseEntity>);

    return new TypeContext<any>(this, undefined, newPr, new ReadonlyBinding(entity, ""));
  }

  niceName(property?: Quoted<(val: T) => any>): string {

    if (this.propertyRoute == undefined)
      throw new Error("No propertyRoute");

    // ALTEA: propertyRoute.member is a MemberInfo (with niceName) in Signum; in altea the route's
    // FieldInfo carries the display name via niceToString().
    if (property == undefined)
      return this.propertyRoute.fieldInfo!.niceToString();

    return addLambda(this.propertyRoute, property).fieldInfo!.niceToString();
  }

  tryMemberInfo(property?: Quoted<(val: T) => any>): MemberInfo | undefined {

    if (this.propertyRoute == undefined)
      throw new Error("No propertyRoute");

    if (property == undefined)
      return this.propertyRoute.fieldInfo;

    return tryAddLambda(this.propertyRoute, property)?.fieldInfo;
  }

  memberInfo(property?: Quoted<(val: T) => any>): MemberInfo {

    if (this.propertyRoute == undefined)
      throw new Error("No propertyRoute");

    if (property == undefined)
      return this.propertyRoute.fieldInfo!;

    return addLambda(this.propertyRoute, property).fieldInfo!;
  }

  getUniqueId(suffix?: string): string {
    var path = suffix == null ? this.prefix : (this.prefix + "." + suffix);

    return path.replace(/.\[\]/, "_");
  }

  tryFindRootEntity(): TypeContext<ModelEntity | Entity> | undefined {
    let current: TypeContext<any> = this;
    while (current) {
      const entity = current.value as BaseEntity;
      // ALTEA: entity.Type && tryGetTypeInfo(entity.Type) -> real instance + native TypeInfo.
      if (entity instanceof BaseEntity && tryGetTypeInfo(entity) != null)
        return current as TypeContext<BaseEntity>;

      current = current.parent as TypeContext<any>;
    }

    return undefined;
  }

  tryFindParentCtx<S extends BaseEntity>(type: Type<S>): TypeContext<S> | undefined;
  tryFindParentCtx(type: PseudoType): TypeContext<BaseEntity> | undefined;
  tryFindParentCtx(type: PseudoType): TypeContext<BaseEntity> | undefined {
    let current: TypeContext<any> = this;
    const typeName = getTypeName(type);
    while (current) {
      const entity = current.value as BaseEntity;
      if (entity instanceof BaseEntity && getTypeName(entity) == typeName)
        return current as TypeContext<BaseEntity>;

      current = current.parent as TypeContext<any>;
    }

    return undefined;
  }

  findParentCtx<S extends BaseEntity>(type: Type<S>): TypeContext<S>;
  findParentCtx(type: PseudoType): TypeContext<BaseEntity>;
  findParentCtx(type: PseudoType): TypeContext<BaseEntity> {
    const result = this.tryFindParentCtx(type);
    if (result == undefined)
      throw new Error(`No '${getTypeName(type)}' found in the parent chain`);

    return result;
  }

  tryFindParent<S extends BaseEntity>(type: Type<S>): S | undefined;
  tryFindParent(type: PseudoType): BaseEntity | undefined;
  tryFindParent(type: PseudoType): BaseEntity | undefined {
    var ctx = this.tryFindParentCtx(type);
    return ctx && ctx.value;
  }

  findParent<S extends BaseEntity>(type: Type<S>): S;
  findParent(type: PseudoType): BaseEntity;
  findParent(type: PseudoType): BaseEntity {
    var ctx = this.tryFindParentCtx(type);
    const result = ctx && ctx.value;
    if (result == undefined)
      throw new Error(`No '${getTypeName(type)}' found in the parent chain`);

    return result;
  }

  using(render: (ctx: this) => React.ReactNode): React.ReactNode {
    return render(this);
  }

  get propertyPath(): string | undefined {
    return this.propertyRoute && this.propertyRoute.propertyRouteType != PropertyRouteType.Root ? this.propertyRoute.propertyString() : undefined;
  }

}

export interface ButtonsContext {
  pack: EntityPack<BaseEntity>;
  frame: EntityFrame<BaseEntity>;
  isOperationVisible?: (eoc: EntityOperationContext<any /*Entity*/>) => boolean;
  tag?: string;
}

export interface ButtonBarElement {
  button: React.ReactElement<any>;
  order?: number;
  shortcut?: (e: KeyboardEvent) => boolean;
}

export interface IRenderButtons {
  renderButtons(ctx: ButtonsContext): (ButtonBarElement | undefined)[];
}

export interface IOperationVisible {
  isOperationVisible(eoc: EntityOperationContext<any /*Entity*/>): boolean;
}

export interface IHasChanges {
  entityHasChanges?: () => boolean | undefined;
}

export interface FunctionalFrameComponent {
  forceUpdate(): void;
  type: Function;
}

export interface EntityFrame<T extends BaseEntity = BaseEntity> {
  frameComponent: FunctionalFrameComponent | React.Component;
  tabs: EmbeddedWidget[] | undefined;
  entityComponent: React.Component | null | undefined;
  pack: EntityPack<T>;
  onReload: (pack?: EntityPack<T>, reloadComponent?: boolean | string | ViewPromise<T>, callback?: () => void) => void;
  setError: (modelState: ModelState, initialPrefix?: string) => void;
  revalidate: () => void;
  onClose: (pack?: EntityPack<T>) => void;
  refreshCount: number;
  allowExchangeEntity: boolean;

  isExecuting(): boolean;
  execute: (action: () => Promise<void>) => Promise<void>;

  createNew?: (oldPack: EntityPack<T>) => (Promise<EntityPack<T> | undefined>) | undefined;
  prefix: string;

  currentDate?: string;
  previousDate?: string;

  hideAndClose?: boolean;
}

// ALTEA: Signum's `mlistItemContext` (Signum.React/TypeContext.tsx). Signum bound each MList row via
// an MListElementBinding on `{ rowId, element }`; altea has NO MList wrapper — a collection field is a
// plain `T[]` of the sustaining ROW entities — so each element binds by its numeric array index (a
// plain Binding, see TypeContext.index). Returns one TypeContext per row, routed through the
// collection's element PropertyRoute (`add("Item")`). Time-machine previousVersion alignment (Signum
// matched by rowId) is not reproduced here — altea rows have no rowId — so element contexts carry no
// previousVersion for now (TODO if list time-travel is needed).
export function mlistItemContext<T>(ctx: TypeContext<T[]>): TypeContext<T>[] {
  const list = ctx.value;
  if (list == null)
    return [];

  const itemRoute = ctx.propertyRoute?.add("Item");

  return list.map((_item, i) =>
    new TypeContext<T>(ctx, undefined, itemRoute, new Binding<T>(list, i, "[" + i + "]")));
}
