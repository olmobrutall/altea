import * as React from 'react'
import { Modal } from 'react-bootstrap'
import { openModal, type IModalProps } from './Modals'
import { SelectorMessage, JavascriptMessage } from '../data/uiMessages'
import { PropertyRoute } from '../data/propertyRoute'
import { TypeReference } from '../data/reflection'
import { Binding } from './binding'
import { TypeContext } from './TypeContext'
import { type BsSize, KeyNames } from './Components'
import { AutoFocus } from './Components/AutoFocus'
import { useForceUpdate } from './Hooks'
import type { AutoLineProps } from './Lines/AutoLine'

// Port of Signum's AutoLineModal.tsx: ask for ONE value in a modal, rendered by whichever line `AutoLine`
// dispatches to.
//
// altea divergence: Signum threads the type to the line as a `type` prop; altea lines read it off
// `ctx.memberType`, so the TypeContext is built from the PropertyRoute or the bare TypeReference instead
// (its constructor takes either). `format` / `unit` still travel as props, because a context built from a
// bare TypeReference has no route to read them from.
const AutoLine = React.lazy(() => import("./Lines/AutoLine").then(m => ({ default: m.AutoLine })));

export interface AutoLineModalOptions {
  propertyRoute?: PropertyRoute;
  type?: TypeReference;
  initialValue?: unknown;
  title?: React.ReactNode;
  message?: React.ReactNode;
  label?: React.ReactNode;
  customComponent?: (p: AutoLineProps) => React.ReactElement;
  validateValue?: (val: any) => string | undefined;
  format?: string;
  unit?: string;
  valueHtmlAttributes?: React.HTMLAttributes<any>;
  allowEmptyValue?: boolean;
  modalSize?: BsSize;
  doNotCloseByEnter?: boolean;
}

interface AutoLineModalProps extends IModalProps<unknown> {
  options: AutoLineModalOptions;
}

function AutoLineModal(p: AutoLineModalProps): React.ReactElement {

  const [show, setShow] = React.useState(true);
  const forceUpdate = useForceUpdate();
  const { title, message, initialValue, ...options } = p.options;
  const value = React.useRef<unknown>(initialValue);
  const selectedValue = React.useRef<unknown>(undefined);
  const btnOkRef = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();

  function handleOkClick(): void {
    selectedValue.current = value.current;
    setShow(false);
  }

  function handleCancelClicked(): void {
    selectedValue.current = undefined;
    setShow(false);
  }

  function handleKeyUp(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key == KeyNames.enter) {
      btnOkRef.current!.focus();
      window.setTimeout(handleOkClick, 100);
    }
  }

  const fieldInfo = options.propertyRoute?.fieldInfo;
  const ctx = new TypeContext<unknown>(undefined, undefined, options.propertyRoute ?? options.type,
    Binding.create(value, v => v.current), "autoLineModal");

  const label = options.label !== undefined ? options.label : fieldInfo?.niceToString();

  const alp: AutoLineProps = {
    ctx: ctx,
    format: options.format !== undefined ? options.format : fieldInfo?.format,
    unit: options.unit !== undefined ? options.unit : fieldInfo?.unit,
    label: label,
    propertyRoute: options.propertyRoute,
    valueHtmlAttributes: options.valueHtmlAttributes,
    formGroupStyle: label ? "Basic" : "SrOnly",
    onChange: forceUpdate,
    mandatory: options.allowEmptyValue == false,
  };

  const empty = options.allowEmptyValue == false && (ctx.value == undefined || ctx.value === "");
  const error = options.validateValue?.(ctx.value);

  return (
    // `as any`: altea's BsSize carries "xs"/"md", which react-bootstrap's Modal does not take (FrameModal
    // casts identically).
    <Modal size={(options.modalSize ?? "lg") as any} show={show} aria-labelledby={titleId}
      onExited={() => p.onExited!(selectedValue.current)} onHide={handleCancelClicked}>
      <div className="modal-header">
        <h1 id={titleId} className="modal-title h5">
          {title ?? fieldInfo?.niceToString() ?? SelectorMessage.ChooseAValue.niceToString()}
        </h1>
        <button type="button" className="btn-close" data-dismiss="modal"
          aria-label={JavascriptMessage.Close.niceToString()} onClick={handleCancelClicked} />
      </div>
      <div className="modal-body"
        onKeyUp={fieldInfo?.isMultiline || options.doNotCloseByEnter ? undefined : handleKeyUp}>
        <p>{message === undefined ? SelectorMessage.PleaseChooseAValueToContinue.niceToString() : message}</p>
        <AutoFocus>
          {options.customComponent ? options.customComponent(alp) :
            <React.Suspense fallback={JavascriptMessage.loading.niceToString()}>
              <AutoLine {...alp} />
            </React.Suspense>}
        </AutoFocus>
        {error != null && <p className="text-danger">{error}</p>}
      </div>
      <div className="modal-footer">
        <button type="button" ref={btnOkRef} className="btn btn-primary sf-entity-button sf-ok-button"
          disabled={empty || error != null} aria-disabled={empty || error != null} onClick={handleOkClick}>
          {JavascriptMessage.ok.niceToString()}
        </button>
        <button type="button" className="btn btn-light sf-entity-button sf-close-button"
          onClick={handleCancelClicked}>
          {JavascriptMessage.cancel.niceToString()}
        </button>
      </div>
    </Modal>
  );
}

namespace AutoLineModal {
  export function show<T = unknown>(options: AutoLineModalOptions): Promise<T | undefined> {
    return openModal<T | undefined>(<AutoLineModal options={options} />);
  }
}

export default AutoLineModal;
