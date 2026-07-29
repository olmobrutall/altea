// Ported from Signum.React/Lines/EntityStrip.tsx onto altea's EntityListBase. altea has no MList: the
// collection is a plain `R[]` of ROW entities, so EntityStrip is generic ONLY on R. Every callback
// (onCreate/onFindMany/onView/move/…) is R-typed — override one and you build/return the row yourself.
// The @valueField handling is a runtime default in the base: the autocomplete/create/find target the
// VALUE type and the picked value is auto-wrapped into a row; `getElementValue(row)` reads it back for
// display (the @valueField value, or the row itself for owned collections).
// altea fixes: MListElement gone → iterate `getMListItemContext` (row contexts); idioms
// isLite/isEntity→instanceof, getToString(x)→valueToString; the avoidDuplicates helper (dead in
// Signum's file) is omitted.
import * as React from 'react'
import { classes } from '../../entities/globals'
import { Navigator } from '../Navigator'
import type { TypeContext } from '../TypeContext'
import { FormGroup } from './FormGroup'
import { BaseEntity, Entity } from '../../entities/entity'
import { Lite, parseLiteList } from '../../entities/lite'
import { EntityControlMessage } from '../../entities/uiMessages'
import { Typeahead } from '../Components'
import { EntityListBaseController, type EntityListBaseProps, tryGetValueField, type DragConfig, type MoveConfig } from './EntityListBase'
import { fieldTypeName } from '../../entities/reflection'
import { type AutocompleteConfig, TypeBadge } from './AutoCompleteConfig'
import { EntityBaseController } from './EntityBase'
import { useController } from './LineBase'
import { useForceUpdate } from '../Hooks'
import { TextHighlighter, type TypeaheadController } from '../Components/Typeahead'
import { LinkButton } from '../Basics/LinkButton'

function valueToString(v: unknown): string {
  return v == null ? "" : (typeof v == "object" ? (v as { toString(): string }).toString() : String(v));
}

export interface EntityStripProps<R extends BaseEntity> extends EntityListBaseProps<R> {
  vertical?: boolean;
  iconStart?: boolean;
  autocomplete?: AutocompleteConfig<any> | null;
  onRenderItem?: (row: NoInfer<R>) => React.ReactNode;
  showType?: boolean;
  onItemHtmlAttributes?: (row: NoInfer<R>) => React.HTMLAttributes<HTMLSpanElement | HTMLAnchorElement>;
  onItemContainerHtmlAttributes?: (row: NoInfer<R>) => React.HTMLAttributes<HTMLSpanElement | HTMLAnchorElement>;
  groupElementsBy?: (row: NoInfer<R>) => string;
  renderGroupTitle?: (key: string, i?: number) => React.ReactElement;
  inputAttributes?: React.InputHTMLAttributes<HTMLInputElement>;
  ref?: React.Ref<EntityStripController<R>>
}

export class EntityStripController<R extends BaseEntity> extends EntityListBaseController<EntityStripProps<R>, R> {

  typeahead!: React.RefObject<TypeaheadController | null>;

  // EntityStrip always shows the @valueField value → needsValue = true (getDefaultProps throws if the
  // row type declares none).
  constructor() {
    super(true);
  }

  override overrideProps(p: EntityStripProps<R>, overridenProps: EntityStripProps<R>): void {
    super.overrideProps(p, overridenProps);
    this.typeahead = React.useRef<TypeaheadController>(null);

    if (p.type) {
      // Autocomplete/showType key off the ELEMENT type = the row's @valueField (guaranteed present:
      // getDefaultProps already validated it for a needsValue line).
      const vf = tryGetValueField(fieldTypeName(p.type) ?? "");
      const elementPr = vf ? p.ctx.propertyRoute?.add("Item").add(vf.name) : p.ctx.propertyRoute?.add("Item");

      if (p.showType == undefined)
        p.showType = (fieldTypeName(vf ?? p.type) ?? "").contains(",");

      if (p.autocomplete === undefined) {
        p.autocomplete = elementPr == null ? null :
          Navigator.getAutoComplete(elementPr.type, p.findOptions, p.findOptionsDictionary, p.ctx, p.create! || p.createOnFind!, p.showType);
      }
      if (p.iconStart == undefined && p.vertical)
        p.iconStart = true;
    }
  }

  handleOnSelect = (item: any, event: React.SyntheticEvent<any>) => {
    this.props.autocomplete!.getEntityFromItem(item)
      .then(entity => entity && this.addValue(entity));

    return "";
  }
}

export function EntityStrip<R extends BaseEntity>(props: EntityStripProps<R>): React.JSX.Element | null {
  const c = useController<EntityStripController<R>, EntityStripProps<R>, R[]>(EntityStripController, props);
  const p = c.props;

  if (c.isHidden)
    return null;

  const isLabelVisible = !(p.ctx.formGroupStyle === "SrOnly" || "visually-hidden");
  var ariaAtts = p.ctx.readOnly ? c.baseAriaAttributes() : c.extendedAriaAttributes();
  if (!isLabelVisible && p.label) {
    ariaAtts = { ...ariaAtts, "aria-label": typeof p.label === "string" ? p.label : String(p.label) };
  }

  const helpText = p.helpText && (typeof p.helpText == "function" ? p.helpText(c) : p.helpText);
  const helpTextOnTop = p.helpTextOnTop && (typeof p.helpTextOnTop == "function" ? p.helpTextOnTop(c) : p.helpTextOnTop);

  const readOnly = p.ctx.readOnly;
  return (
    <FormGroup ctx={p.ctx!} error={p.error} label={p.label} labelIcon={p.labelIcon}
      labelHtmlAttributes={p.labelHtmlAttributes}
      helpText={helpText}
      helpTextOnTop={helpTextOnTop}
      htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }}
      ariaAttributes={ariaAtts}>
      {inputId => <div className="sf-entity-strip sf-control-container">
        {p.groupElementsBy == undefined ?
          <ul id={inputId} className={classes("sf-strip", p.vertical ? "sf-strip-vertical" : "sf-strip-horizontal", p.ctx.labelClass)}>
            {c.getMListItemContext(p.ctx).map((mlec, i) => renderElement(mlec, i))}
            {renderLastElement()}
          </ul>
          :
          <>
            {c.getMListItemContext(p.ctx).groupBy(a => p.groupElementsBy!(a.value)).map((gr, i) =>
              <div className={classes("mb-2")} key={i} >
                <small className="text-muted">{p.renderGroupTitle != undefined ? p.renderGroupTitle(gr.key, i) : gr.key}</small>
                <ul className={classes("sf-strip", p.vertical ? "sf-strip-vertical" : "sf-strip-horizontal", p.ctx.labelClass)}>
                  {gr.elements.map((mlec, i) => renderElement(mlec, i))}
                </ul>
              </div>)}
            {renderLastElement()}
          </>
        }
      </div>}
    </FormGroup>
  );

  function renderElement(mlec: TypeContext<R>, index: number): React.ReactElement {
    return <EntityStripElement<R> key={index}
      ctx={mlec}
      value={c.getElementValue(mlec.value)}
      iconStart={p.iconStart}
      autoComplete={p.autocomplete}
      onRenderItem={p.onRenderItem}
      move={c.canMove(mlec.value) && p.moveMode == "MoveIcons" && !readOnly ? c.getMoveConfig(false, mlec.index!, p.vertical ? "v" : "h") : undefined}
      drag={c.canMove(mlec.value) && p.moveMode == "DragIcon" && !readOnly ? c.getDragConfig(mlec.index!, p.vertical ? "v" : "h") : undefined}
      onItemHtmlAttributes={p.onItemHtmlAttributes}
      onItemContainerHtmlAttributes={p.onItemContainerHtmlAttributes}
      onRemove={c.canRemove(mlec.value) && !readOnly ? e => c.handleRemoveElementClick(e, mlec.index!) : undefined}
      onView={c.canView(mlec.value) ? e => c.handleViewElement(e, mlec.index!) : undefined}
      showType={p.showType!}
      vertical={p.vertical}
    />
  }

  function renderLastElement() {

    const buttons = (
      <>
        {p.extraButtonsBefore && p.extraButtonsBefore(c)}
        {c.renderCreateButton(true)}
        {c.renderFindButton(true)}
        {c.renderPasteButton(true)}
        {p.extraButtons && p.extraButtons(c)}
      </>
    );
    var autocomplete = !EntityBaseController.hasChildrens(buttons) ?
      renderAutoComplete() :
      renderAutoComplete(input => <div className={p.ctx.inputGroupClass}>
        {input}
        {buttons}
      </div>);

    if (p.groupElementsBy == null)
      return (
        <li className={"sf-strip-input"}>
          {autocomplete}
        </li>
      );

    return (
      <div className={"sf-strip-input"}>
        {autocomplete}
      </div>
    );
  }

  function handleOnPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    const lites = parseLiteList(text);
    if (lites.length == 0)
      return;

    e.preventDefault();
    c.paste(text)?.then(() => {
      c.typeahead.current?.writeInInput("");
    });
  }

  function renderAutoComplete(renderInput?: (input: React.ReactElement | null) => React.ReactElement) {
    var ac = p.autocomplete;

    if (p.ctx!.readOnly)
      return undefined;

    if (ac == null)
      return renderInput == null ? null : renderInput(null);

    return (
      <Typeahead ref={c.typeahead}
        inputAttrs={{
          className: classes(p.ctx.formControlClass, "sf-entity-autocomplete", c.mandatoryClass),
          placeholder: EntityControlMessage.Add.niceToString(),
          onPaste: p.paste == false ? undefined : handleOnPaste,
          ...p.inputAttributes
        }}
        getItems={q => ac!.getItems(q)}
        itemsDelay={ac.getItemsDelay()}
        renderItem={(e, hl) => ac!.renderItem(e, hl)}
        itemAttrs={item => ({ 'data-entity-key': ac!.getDataKeyFromItem(item) }) as React.HTMLAttributes<HTMLButtonElement>}
        onSelect={c.handleOnSelect}
        renderInput={renderInput}
      />
    );
  }
}

export interface EntityStripElementProps<R extends BaseEntity> {
  iconStart?: boolean;
  onRemove?: (event: React.MouseEvent<any>) => void;
  onView?: (event: React.MouseEvent<any>) => void;
  ctx: TypeContext<R>;
  value: unknown; // the element value (row's @valueField value, or the row itself) — for display
  autoComplete?: AutocompleteConfig<unknown> | null;
  onRenderItem?: (row: R) => React.ReactNode;
  onItemHtmlAttributes?: (row: R) => React.HTMLAttributes<HTMLSpanElement | HTMLAnchorElement>;
  onItemContainerHtmlAttributes?: (row: R) => React.HTMLAttributes<HTMLSpanElement | HTMLAnchorElement>;
  drag?: DragConfig;
  move?: MoveConfig;
  showType: boolean;
  vertical?: boolean;
}

export function EntityStripElement<R extends BaseEntity>(p: EntityStripElementProps<R>): React.ReactElement {
  var currentEntityRef = React.useRef<{ entity: unknown, item?: unknown } | undefined>(undefined);
  const forceUpdate = useForceUpdate();

  React.useEffect(() => {

    if (p.autoComplete) {
      var newEntity = p.value;
      if (!currentEntityRef.current || currentEntityRef.current.entity !== newEntity) {
        var ci = { entity: newEntity as unknown, item: undefined as unknown }
        currentEntityRef.current = ci;
        var fillItem = (newEntity: unknown) => {
          const autocomplete = p.autoComplete;
          autocomplete?.getItemFromEntity(newEntity as BaseEntity | Lite<Entity>)
            .then(item => {
              if (autocomplete == p.autoComplete) {
                ci.item = item;
                forceUpdate();
              } else {
                fillItem(newEntity);
              }
            });
        };
        fillItem(newEntity);
      }
    }

  }, [p.value]);

  const toStr =
    p.onRenderItem ? p.onRenderItem(p.ctx.value) :
      currentEntityRef.current?.item ? p.autoComplete!.renderItem(currentEntityRef.current.item, new TextHighlighter(undefined)) :
        getToStr();


  function getToStr() {
    const value = p.value;
    const toStr = valueToString(value);
    return !p.showType || !(value instanceof Entity || value instanceof Lite) ? toStr :
      <span style={{ wordBreak: "break-all" }} title={toStr}>
        {toStr}<TypeBadge entity={value} />
      </span>;
  }


  var drag = p.drag;
  const htmlAttributes = p.onItemHtmlAttributes && p.onItemHtmlAttributes(p.ctx.value);

  var val = p.value;

  //Till https://github.com/facebook/react/issues/8529 gets fixed
  var url = val instanceof Entity && !val.isNew ? Navigator.navigateRoute(val) :
    val instanceof Lite && !(val.entityOrNull && val.entityOrNull.isNew) ? Navigator.navigateRoute(val) : "#";

  var hasIcon = p.onRemove || p.drag || p.move;

  var containerHtmlAttributes = (p.onItemContainerHtmlAttributes && p.onItemContainerHtmlAttributes(p.ctx.value));

  return (
    <li className={classes("sf-strip-element", containerHtmlAttributes?.className, drag?.dropClass)}
      title={valueToString(p.value)}
      {...(val instanceof Entity || val instanceof Lite ? EntityBaseController.entityHtmlAttributes(val) : undefined)}
      {...containerHtmlAttributes}>
      <div className="sf-strip-dropable"
        onDragEnter={drag?.onDragOver}
        onDragOver={drag?.onDragOver}
        onDrop={drag?.onDrop}
      >
        {hasIcon && p.iconStart && <span style={{ marginRight: "5px", whiteSpace: "nowrap" }}>{removeIcon()}&nbsp;{dragIcon()}{p.move?.renderMoveUp()}{p.move?.renderMoveDown()}</span>}
        {
          p.onView ?
            <a href={url} className={classes("sf-strip-link", htmlAttributes?.className ?? "text-body")} onClick={p.onView} {...htmlAttributes}>
              {toStr}
            </a>
            :
            <span className={classes("sf-strip-link", htmlAttributes?.className ?? "text-body")} {...htmlAttributes}>
              {toStr}
            </span>
        }
        {hasIcon && !p.iconStart && <span>{removeIcon()}&nbsp;{dragIcon()}{p.move?.renderMoveUp()}{p.move?.renderMoveDown()}</span>}
      </div>
    </li>
  );

  function removeIcon() {
    return p.onRemove &&
      <span>
        <LinkButton className="sf-line-button sf-remove"
          onClick={p.onRemove}
          title={p.ctx.titleLabels ? EntityControlMessage.Remove.niceToString() : undefined}>
          {EntityBaseController.getRemoveIcon()}
        </LinkButton>
      </span>
  }

  function dragIcon() {
    return (
      drag && (
        <LinkButton
          className={classes("sf-line-button", "sf-move", drag.dropClass)}
          onClick={e => {
            e.stopPropagation();
          }}
          draggable={true}
          onDragStart={drag.onDragStart}
          onDragEnd={drag.onDragEnd}
          onKeyDown={drag.onKeyDown}
          title={drag.title}>
          {EntityBaseController.getMoveIcon()}
        </LinkButton>
      )
    );
  }
}
