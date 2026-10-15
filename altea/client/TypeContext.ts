import * as React from 'react'
import { getTypeName, tryGetTypeInfo, GraphExplorer } from './Reflection'
import type { PseudoType, MemberInfo } from './Reflection'
import { PropertyRoute, PropertyRouteType, isPartType } from '../data/propertyRoute'
import { TypeReference } from '../data/reflection'
import { ReadonlyBinding, createBinding, getLambdaMembers, getFieldMembers, Binding } from './binding'
import type { IBinding, LambdaMember } from './binding'
import type { Quoted } from 'quote-transformer/quoted'
import { BaseEntity } from '../data/entity'
import { Dic } from '../data/globals'
import { Decimal } from '../data/basics'
import type { Entity, ModelEntity, Type } from '../data/entity'
import type { EntityPack } from '../data/entityPack'
import type { ModelState } from '../data/validation'

// EntityOperationContext is the real class in ./Operations now (type-only import — Operations imports
// TypeContext's types back, so both directions erase at runtime → no cycle).
import type { EntityOperationContext as EntityOperationContextClass } from './Operations'
type EntityOperationContext<T> = EntityOperationContextClass<T & Entity>;

// --- Temporary stubs for modules not yet ported (Phase 2/3). Restore the real imports then:
//   ViewPromise <- ./Navigator,  EmbeddedWidget <- ./Frames/Widgets
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
      this.styleOptions.valueColumns = StyleContext.bsColumnsInvert(toLabelLayout(this.styleOptions.labelColumns));
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
      case "xs": return "sf-form-group sf-form-group-xs";
      case "sm": return "sf-form-group sf-form-group-sm";
      case "md": return "sf-form-group";
      case "lg": return "sf-form-group sf-form-group-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get colFormLabelClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "sf-col-form-label sf-col-form-label-xs";
      case "sm": return "sf-col-form-label sf-col-form-label-sm";
      case "md": return "sf-col-form-label";
      case "lg": return "sf-col-form-label sf-col-form-label-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get labelClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "sf-form-label-xs";
      case "sm": return "sf-form-label-sm";
      case "md": return undefined;
      case "lg": return undefined;
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get inputGroupClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "sf-input-group sf-input-group-xs";
      case "sm": return "sf-input-group sf-input-group-sm";
      case "md": return "sf-input-group";
      case "lg": return "sf-input-group sf-input-group-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  inputGroupVerticalClass(mode: "before" | "after"): string | undefined {
    switch (this.formSize) {
      case "xs": return "sf-input-group-vertical " + mode + " sf-input-group-xs";
      case "sm": return "sf-input-group-vertical " + mode + " sf-input-group-sm";
      case "md": return "sf-input-group-vertical " + mode;
      case "lg": return "sf-input-group-vertical " + mode + " sf-input-group-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get formControlClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "sf-form-control sf-form-control-xs";
      case "sm": return "sf-form-control sf-form-control-sm";
      case "md": return "sf-form-control sf-form-control-md";
      case "lg": return "sf-form-control sf-form-control-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get formSelectClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "sf-form-select sf-form-select-xs";
      case "sm": return "sf-form-select sf-form-select-sm";
      case "md": return "sf-form-select";
      case "lg": return "sf-form-select sf-form-select-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get formControlPlainTextClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "sf-form-control-plaintext sf-form-control-xs";
      case "sm": return "sf-form-control-plaintext sf-form-control-sm";
      case "md": return "sf-form-control-plaintext sf-form-control-md";
      case "lg": return "sf-form-control-plaintext sf-form-control-lg";
      default: throw new Error("Unexpected formSize " + this.formSize);
    }
  }

  get buttonClass(): string | undefined {
    switch (this.formSize) {
      case "xs": return "sf-btn-xs";
      case "sm": return "sf-btn-sm";
      case "md": return undefined;
      case "lg": return "sf-btn-lg";
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

  get labelColumns(): LabelLayout {
    return this.styleOptions.labelColumns != undefined ? toLabelLayout(this.styleOptions.labelColumns) : this.parent.labelColumns;
  }

  get labelColumnsCss(): string {
    return StyleContext.labelLayoutCss(this.labelColumns);
  }

  get valueColumns(): LabelLayout {
    return this.styleOptions.valueColumns != undefined ? toLabelLayout(this.styleOptions.valueColumns) : this.parent.valueColumns;
  }

  get valueColumnsCss(): string {
    return StyleContext.labelLayoutCss(this.valueColumns);
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


  /** The grid spans of one side of a LabelColumns form group (inside `sf-form-group-columns`). */
  static labelLayoutCss(layout: LabelLayout): string {
    return [
      (layout.xs ? "col-span-" + layout.xs : ""),
      (layout.sm ? "sm:col-span-" + layout.sm : ""),
      (layout.md ? "md:col-span-" + layout.md : ""),
      (layout.lg ? "lg:col-span-" + layout.lg : ""),
    ].filter(a => a != "").join(" ");
  }

  /** @deprecated Use {@link labelLayoutCss}. */
  static bsColumnsCss(layout: LabelLayout): string {
    return StyleContext.labelLayoutCss(layout);
  }

  static bsColumnsInvert(bs: LabelLayout): LabelLayout {
    return {
      xs: bs.xs ? (12 - bs.xs) : undefined,
      sm: (12 - bs.sm),
      md: bs.md ? (12 - bs.md) : undefined,
      lg: bs.lg ? (12 - bs.lg) : undefined,
    };
  }
}

function toLabelLayout(layoutOrNumber: LabelLayout | number): LabelLayout {
  return typeof (layoutOrNumber) == "number" ? { sm: layoutOrNumber } : layoutOrNumber;
}

export interface StyleOptions {
  formGroupStyle?: FormGroupStyle;
  formSize?: FormSize;
  placeholderLabels?: boolean;
  titleLabels?: boolean;
  readonlyAsPlainText?: boolean;
  labelColumns?: LabelLayout | number;
  valueColumns?: LabelLayout | number;
  readOnly?: boolean;
  frame?: EntityFrame;
}


/** How many of the 12 columns the label (or the value) of a LabelColumns form group takes, per breakpoint. */
export interface LabelLayout {
  xs?: number;
  sm: number;
  md?: number;
  lg?: number;
}

/** @deprecated Use {@link LabelLayout}. */
export type BsColumns = LabelLayout;


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


/**
 * The route (or, for a `@part`, the bare TYPE) a context RE-ROOTED at `ctor` gets.
 *
 * Re-rooting at each rendered entity is Signum's own behaviour and altea's — except at a part, which
 * continues its owner's route and may not be a route root at all (PropertyRoute.isPartType). The three
 * callers here are the ones that have NO parent context to continue from (`TypeContext.root`, `cast`,
 * `as`), so a part gets a TypeReference instead: the context still knows its type — which is what the
 * Lines dispatch on — and simply has no route, exactly as a context built from a raw type does.
 *
 * A part rendered the ordinary way never comes through here: `subCtx` keeps the parent's route, and
 * RenderEntity / EntityTable keep the owner's, which is where its rules are stored.
 */
function rootRouteOrType(ctor: Type<BaseEntity>): PropertyRoute | TypeReference {
  return isPartType(ctor) ? new TypeReference({ type: () => ctor }) : PropertyRoute.root(ctor);
}

// ---- TypeContext.equals helpers -------------------------------------------------------------------

interface BindingAnswers { error?: { value: string | undefined }; readOnly?: { value: boolean }; }

// What each binding last answered a render. Keyed by the binding, not the context: the line renders through
// `ctx.subCtx(styleOptions)`, a different context sharing the same binding as the one in its props.
const bindingAnswers = new WeakMap<IBinding<any>, BindingAnswers>();

function answers(binding: IBinding<any>): BindingAnswers {
  let a = bindingAnswers.get(binding);
  if (a == null)
    bindingAnswers.set(binding, a = {});
  return a;
}

function sameAnswers(prev: TypeContext<unknown>, next: TypeContext<unknown>): boolean {
  if (prev.binding == null)
    return true;

  const a = bindingAnswers.get(prev.binding);
  if (a == null)
    return true;

  // Asked through `next`, which records its own answers for the comparison after this one.
  return (a.error == null || a.error.value === next.error) &&
    (a.readOnly == null || a.readOnly.value === next.bindingIsReadonly);
}

function bindingEquals(prev: IBinding<any> | undefined, next: IBinding<any> | undefined): boolean {
  if (prev === next)
    return true;

  if (prev instanceof Binding && next instanceof Binding)
    return prev.parentObject === next.parentObject &&
      prev.member === next.member &&
      prev.suffix === next.suffix &&
      prev.forceError === next.forceError &&
      valueEquals(prev.initialValue, next.initialValue);

  if (prev instanceof ReadonlyBinding && next instanceof ReadonlyBinding)
    return prev.value === next.value && prev.suffix === next.suffix;

  return false; // a binding we know nothing about: re-render rather than guess.
}

// A field VALUE: primitives (bigint included) and identities by `===`; the immutable value types — Date,
// Temporal, decimal.js — by what they denote (a new instance per assignment is the norm).
function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b)
    return true;

  if (a instanceof Date && b instanceof Date)
    return a.valueOf() === b.valueOf();

  // A decimal field holds a decimal.js object, and NumberLine stores a NEW one on every edit.
  if (a instanceof Decimal && b instanceof Decimal)
    return a.eq(b);

  return Dic.isTemporal(a) && Dic.isTemporal(b) &&
    Object.getPrototypeOf(a) === Object.getPrototypeOf(b) && String(a) === String(b);
}


function routeEquals(a: PropertyRoute | undefined, b: PropertyRoute | undefined): boolean {
  return a === b || (a != null && b != null && a.toString() === b.toString());
}

function typeReferenceEquals(a: TypeReference | undefined, b: TypeReference | undefined): boolean {
  return a === b || (a != null && b != null &&
    a.typeName === b.typeName && a.subTypeName === b.subTypeName &&
    a.lite === b.lite && a.array === b.array && a.isNullable === b.isNullable &&
    a.type?.() === b.type?.() &&
    Dic.equals(a.implementations, b.implementations, true));
}

function previousVersionEquals(a: TypeContext<unknown>["previousVersion"], b: TypeContext<unknown>["previousVersion"]): boolean {
  return a === b || (a != null && b != null && a.value === b.value && a.oldIndex === b.oldIndex && a.isMoved === b.isMoved);
}

// Style options hold primitives, small literals a view writes inline (`labelColumns: { sm: 4 }`) and the
// frame, which FramePage rebuilds on every render around the same pack (down to its `frameComponent:
// { forceUpdate, type }`). Plain objects are compared a few levels down; anything with a class (an entity,
// a component) only by reference, and the pack's entity is one — a reload is a different frame.
function styleOptionsEqual(a: object | undefined, b: object | undefined): boolean {
  return shallowEquals(a, b, 3);
}

function shallowEquals(a: unknown, b: unknown, depth: number): boolean {
  if (a === b)
    return true;

  if (typeof a === "function" && typeof b === "function")
    return true;

  if (depth == 0 || !isPlain(a) || !isPlain(b) || Array.isArray(a) !== Array.isArray(b))
    return false;

  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every(k => Object.prototype.hasOwnProperty.call(b, k) &&
    shallowEquals((a as any)[k], (b as any)[k], depth - 1));
}

function isPlain(v: unknown): v is object {
  if (typeof v !== "object" || v == null)
    return false;

  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === Array.prototype || proto === null;
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

    // A live/forced binding error wins; otherwise surface a server-reported error for THIS field —
    // looked up by full path in the root entity's ModelState (set by frame.setError on a 400). This is
    // how a server-only validator (disabled on the "Client" phase, so the live check stays silent)
    // still reddens its field, not only the summary.
    const live = this.binding.getError();
    const root = live ? undefined : this.rootEntity();
    const error = live || (root ? GraphExplorer.peekModelState(root)?.[this.prefix] : undefined);
    answers(this.binding).error = { value: error };
    return error;
  }

  /** The binding's own read-only rule (`@isReadOnly`, which may read OTHER fields), remembered for {@link TypeContext.equals}. */
  get bindingIsReadonly(): boolean {
    const readOnly = this.binding.getIsReadonly();
    answers(this.binding).readOnly = { value: readOnly };
    return readOnly;
  }

  set error(val: string | undefined) {
    this.binding.setError(val);
  }

  // The root entity of this context tree — the one the frame keys ModelState by. Walks up the parent
  // chain to the topmost TypeContext and returns its value when it is a BaseEntity.
  private rootEntity(): BaseEntity | undefined {
    let c: TypeContext<any> = this;
    while (c.parent instanceof TypeContext)
      c = c.parent;
    const v = c.value;
    return v instanceof BaseEntity ? v : undefined;
  }

  get index(): number | undefined {
    // ALTEA: a collection element binds by numeric array index (a plain Binding), not an
    // MListElementBinding. Read the numeric member, else inherit from the parent context.
    const member = (this.binding as Binding<any> | undefined)?.member;
    return typeof member === "number" ? member : (this.parent as TypeContext<any>)?.index;
  }

  /**
   * Whether a memoized line given `prev` would render the same as one given `next` — the `ctx` half of
   * LineBaseController.propEquals. A view builds a NEW context for every line on every render, so `===`
   * says nothing; this compares what the line can actually see, level by level up the parent chain:
   *
   * - **The target, by REFERENCE.** A context is a handle the line WRITES through, not just data to show.
   *   After a reload the new entity graph can be deep-equal to the old one; a line that skipped that render
   *   would keep a binding to the dead object and type into nothing. So `parentObject` / `value` are never
   *   walked, and the cost no longer grows with the entity (a 600 KB file used to be walked per line).
   * - **The value, by VALUE.** Entities are mutated in place, so the target being the same object proves
   *   nothing about the field. The binding snapshots it at construction (`initialValue`): an edit made
   *   elsewhere (an onChange, an operation) shows up as a different snapshot.
   * - **What the line derived LIVE.** `ctx.error` (validators + the server's ModelState) and the binding's
   *   `@isReadOnly` rule can change through OTHER fields. Whatever the previous render was told is asked
   *   again; a different answer re-renders.
   *
   * Style options are compared shallowly (a view writes `{ labelColumns: { sm: 4 } }` inline); functions
   * count as equal, as `Dic.equals` always has (inline handlers would otherwise defeat the memo).
   */
  static equals(prev: StyleContext | undefined, next: StyleContext | undefined): boolean {
    if (prev === next)
      return true;

    if (prev == null || next == null || Object.getPrototypeOf(prev) !== Object.getPrototypeOf(next))
      return false;

    if (!styleOptionsEqual(prev.styleOptions, next.styleOptions))
      return false;

    if (prev instanceof TypeContext) {
      const n = next as TypeContext<unknown>;
      if (prev.prefix !== n.prefix ||
        !routeEquals(prev.propertyRoute, n.propertyRoute) ||
        !typeReferenceEquals(prev.typeReference, n.typeReference) ||
        !previousVersionEquals(prev.previousVersion, n.previousVersion) ||
        !bindingEquals(prev.binding, n.binding) ||
        !sameAnswers(prev, n))
        return false;
    }

    return TypeContext.equals(prev.parent, next.parent);
  }

  static root<T extends BaseEntity>(value: T, styleOptions?: StyleOptions, parent?: StyleContext): TypeContext<T> {
    // ALTEA: value.Type (string) -> the real constructor.
    return new TypeContext(parent, styleOptions, rootRouteOrType(value.getType()), new ReadonlyBinding<T>(value, ""));
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

  // ALTEA divergence from Signum's subCtx overloads:
  //   1. The property-lambda param is `Quoted<(val:T)=>R>` (the transformer needs a Quoted-typed param to
  //      emit `__quoted`; getLambdaMembers has no toString fallback) and MUST precede the StyleOptions
  //      overload. StyleOptions is all-optional, so a bare selector lambda is assignable to it — were it
  //      first, overload resolution would pick it and the lambda param would silently degrade to any.
  //   2. Signum's `subCtx(mixin: Type<M>): TypeContext<M>` overload is DROPPED as redundant. A mixin step is
  //      navigated INSIDE the property lambda instead — `subCtx(a => a.mixin(SomeMixin).someProperty)` — the
  //      same Quoted path getLambdaMembers already parses into a Mixin member (proven by
  //      `Type.token(a => a.mixin(X).prop)` in altea-test, which resolves to "X.Prop"). Bonus: a
  //      constructor-typed overload at this arg position would ALSO defeat contextual typing of that lambda
  //      (mixed call/construct signatures → the arrow param falls to any), so dropping it is doubly right.
  subCtx<R>(property: Quoted<(val: T) => R>, styleOptions?: StyleOptions): TypeContext<R>
  subCtx(field: string, styleOptions?: StyleOptions): TypeContext<any>
  subCtx(styleOptions: StyleOptions): TypeContext<T>
  subCtx(arg: Quoted<(val: T) => any> | string | StyleOptions, styleOptions?: StyleOptions): TypeContext<any> {
    if (typeof arg == "object") {
      var nc = new TypeContext<T>(this, arg, this.propertyRoute ?? this.typeReference, this.binding, this.prefix);
      nc.previousVersion = this.previousVersion;

      return nc;
    }

    // A property lambda (`function`) is parsed via its `__quoted` tree — mixin steps (`a.mixin(X).f`) become
    // Mixin members there; a plain string is a field path.
    const lambdaMembers: LambdaMember[] =
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

    const newPr = this.propertyRoute == null ? undefined : rootRouteOrType(entity.getType());

    return new TypeContext<any>(this, undefined, newPr, new ReadonlyBinding(entity, ""));
  }

  as<R extends T & BaseEntity>(type: Type<R>): TypeContext<R> | undefined {

    const entity = this.value as any as Entity;

    if (getTypeName(type) != getTypeName(entity))
      return undefined;

    const newPr = rootRouteOrType(entity.getType());

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

  /**
   * The line's OWN member — what `data-property-path` carries, and the contract altea-playwright's
   * per-step narrowing is built on (see its LineContainer: it walks a route one step at a time, matching
   * one attribute per step, so a nested `city` cannot match a sibling's).
   *
   * It used to be `propertyString()`, the whole path, which read the same only because the UI RE-ROOTS at
   * every entity it renders — so the path was one step by construction. A `@part` no longer re-roots
   * (PropertyRoute.isPartType), so an order line's cell would have come out `Details/Product` where every
   * other line says `Product`. The route being longer is the point of that change; the ATTRIBUTE saying
   * which line this is, is a different question, and the answer is the last step either way.
   */
  get propertyPath(): string | undefined {
    const pr = this.propertyRoute;
    if (pr == null || pr.propertyRouteType == PropertyRouteType.Root)
      return undefined;
    const path = pr.propertyString();
    const cut = Math.max(path.lastIndexOf("."), path.lastIndexOf("/"));
    return cut < 0 ? path : path.substring(cut + 1);
  }

}

export interface ButtonsContext {
  pack: EntityPack<BaseEntity>;
  frame: EntityFrame<BaseEntity>;
  isOperationVisible?: (eoc: EntityOperationContext<any /*Entity*/>) => boolean;
  tag?: string;
  /** Operation KEYS to keep, tilde-separated and matched on the member after the last dot — the form a
   *  `?operations=` query parameter carries. Shows only those, ungrouped. */
  operations?: string;
  /** Free text to match against operation nice names, tilde-separated (any match keeps the operation).
   *  What the button bar's own search box fills in. */
  filter?: string;
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
  setError: (modelState: ModelState | undefined, initialPrefix?: string) => void;
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
