// Ported from Signum.React/Modals/ErrorModal.tsx — copy-and-fix. altea fixes: import paths
// (Globals→entities/globals, Signum.Entities→entities/uiMessages, ClientErrorModel→entities/clientError);
// dropped the unused ExceptionEntity + newLite imports and the junk `namespace from 'd3'`;
// ClientErrorModel.New(...)→.create(...); Link from 'react-router'.
import * as React from 'react'
import { Link } from 'react-router'
import * as Modals from '../Modals';
import { Dic } from '../../data/globals';
import { ajaxPost, ExternalServiceError, ServiceError, ValidationError } from '../Services';
import { JavascriptMessage, FrameMessage, ConnectionMessage, EntityControlMessage } from '../../data/uiMessages'
import { ClientErrorModel } from '../../data/clientError'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import "./DialogModals.css"
import { Modal } from '../ui/Modal';
import MessageModal from './MessageModal';
import { LinkButton } from '../Basics/LinkButton';
import { useAPI } from '../Hooks';

//http://codepen.io/m-e-conroy/pen/ALsdF
interface ErrorModalProps extends Modals.IModalProps<undefined> {
  error: any;
  beforeOkClicked?:()=> Promise<void>
}

const ErrorModal: {
  (p: ErrorModalProps): React.ReactElement;
  register: () => void;
  showErrorModal: (error: any, beforeOkClicked?: ()=> Promise<void>) => Promise<void>;
} = function (p: ErrorModalProps) {

  const [show, setShow] = React.useState(true);
  // Names the dialog through aria-labelledby below; unique per instance since dialogs can be nested here.
  const titleId = React.useId();
  const messageId = React.useId();

  function handleOnExited() {
    p.onExited!(undefined);
  }

  async function handleCloseClicked() {
    await p.beforeOkClicked?.();

    setShow(false);
  }


  const e = p.error;

  const se = e instanceof ServiceError ? (e as ServiceError) : undefined;
  const ese = e instanceof ExternalServiceError ? (e as ExternalServiceError) : undefined;
  const ve = e instanceof ValidationError ? (e as ValidationError) : undefined;

  return (
    <Modal show={show} onExited={handleOnExited} onHide={handleCloseClicked} size="lg" dialogClassName="error-modal"
      aria-labelledby={titleId}
      // The error itself, read with the dialog's name when it opens rather than only its title.
      aria-describedby={messageId}>
      {/* The header carried role="dialog" of its own, so a single dialog reported the role twice and the
          inner one wrapped only the heading. The <Modal> above is the dialog; this is just its header. */}
      <div className="sf-modal-header dialog-header-error">
        <h1 className="sf-modal-title text-h5 font-medium" id={titleId}>
          {
            se ? renderServiceTitle(se) :
              ve ? renderValidationTitle(ve) :
                ese ? renderExternalServiceTitle(ese) :
                  renderTitle(e)
          }
        </h1>
        <button type="button" className="sf-btn-close" data-dismiss="modal" aria-label={JavascriptMessage.Close.niceToString()} onClick={handleCloseClicked} />
      </div>

      <div className="sf-modal-body" id={messageId}>
        {se ? ErrorModalOptions.renderServiceMessage(se) :
          ve ? ErrorModalOptions.renderValidationMessage(ve) :
            ese ? ErrorModalOptions.renderExternalServiceMessage(ese) :
              ErrorModalOptions.renderMessage(e)}
      </div>

      <div className="sf-modal-footer">
        <button className="sf-btn sf-btn-primary sf-close-button sf-ok-button" onClick={handleCloseClicked}>
          {JavascriptMessage.ok.niceToString()}</button>
      </div>
    </Modal>
  );

  function renderTitle(e: any) {
    return (
      <span><FontAwesomeIcon aria-hidden={true} icon="triangle-exclamation" /> Error <ClientExceptionId error={e} /></span>
    );
  }

  function renderServiceTitle(se: ServiceError) {
    return (
      <span>
        <FontAwesomeIcon aria-hidden={true} icon={se.defaultIcon} />&nbsp; <span>{se.httpError.exceptionType}</span>
        {se.httpError.exceptionId && <ExceptionId exceptionId={se.httpError.exceptionId} />}
      </span>
    );
  }

  function renderExternalServiceTitle(ese: ExternalServiceError) {
    return (
      <span>
        <strong>{ese.serviceName}: </strong>
        {ese.title}
      </span>
    );
  }


  function renderValidationTitle(ve: ValidationError) {
    return (
      <span>
        <FontAwesomeIcon aria-hidden={true} icon="triangle-exclamation" /> {FrameMessage.ThereAreErrors.niceToString()}
      </span>
    );
  }
}

export default ErrorModal;

function ExceptionId(p: { exceptionId: string }): React.ReactElement {
  return (
    <span>({
      ErrorModalOptions.isExceptionViewable() ?
        <Link to={ErrorModalOptions.getExceptionUrl(p.exceptionId)!}>{p.exceptionId}</Link> :
        <strong>{p.exceptionId}</strong>
    })</span>
  );
}

function ClientExceptionId(p: { error: any }): React.ReactElement | null {
  const exceptionId = useAPI(() => p.error != null && typeof p.error == "object" ? clientExceptionIds.get(p.error) ?? null : null, [p.error]);
  return exceptionId ? <ExceptionId exceptionId={exceptionId} /> : null;
}

var lastError: { model: ClientErrorModel, date: Date, exceptionId: Promise<string | null> } | undefined;

const clientExceptionIds = new WeakMap<object, Promise<string | null>>();

function logError(error: Error) {
  const exceptionId = registerClientError(error);
  if (exceptionId != null && error != null && typeof error == "object")
    clientExceptionIds.set(error, exceptionId);
}

function registerClientError(error: Error): Promise<string | null> | undefined {

  if (error instanceof ServiceError || error instanceof ValidationError)
    return undefined;

  if (error instanceof DOMException && error.name == "AbortError")
    return undefined;

  var errorModel = ClientErrorModel.create({
    url: window.location.href,
    errorType: (error as Object).constructor.name,
    message: error.message || error.toString(),
    stack: error.stack ?? null,
    name: error.name,
  });

  var date = new Date();

  if (lastError != null) {
    if (
      lastError.model.url == errorModel.url &&
      lastError.model.errorType == errorModel.errorType &&
      lastError.model.message == errorModel.message &&
      lastError.model.stack == errorModel.stack &&
      lastError.model.errorType == errorModel.errorType &&
      ((date.valueOf() - lastError.date.valueOf()) / 1000) < 10
    ) {
      return lastError.exceptionId;
    }
  }

  const exceptionId = ajaxPost<string | null>({ url: "/api/registerClientError" }, errorModel)
    .catch(e => {
      console.error("Unable to save client-side error:", error, e);
      return null;
    });
  lastError = { model: errorModel, date: date, exceptionId };
  return exceptionId;
}

ErrorModal.register = () => {
  window.onunhandledrejection = p => {
    var error = p.reason;

    if (error.alreadyConsumed)
      return;

    error.alreadyConsumed = true;

    logError(error);
    if (Modals.isStarted()) {
      ErrorModal.showErrorModal(error);
    }
    else {
      error.alreadyConsumed = false;
      window.onerror?.("error", undefined, undefined, undefined, error);
      console.error("Unhandled promise rejection:", error);
    }
  };

  var oldOnError = window.onerror;

  window.onerror = (message: Event | string, filename?: string, lineno?: number, colno?: number, error?: Error) => {

    if (error != null) {
      if ((error as any).alreadyConsumed)
        return;

      (error as any).alreadyConsumed = true;
    }

    if (error != null)
      logError(error);

    if (Modals.isStarted()) {
      console.error(error);
      ErrorModal.showErrorModal(error);
    }
    else if (oldOnError != null) {
      if (error instanceof ServiceError)
        oldOnError(message, filename, lineno, colno, {
          name: error.httpError.exceptionType! + " (ExceptionID " + error.httpError.exceptionId! + ")",
          message: error.httpError.exceptionMessage!,
          stack: error.httpError.stackTrace!,
        });
      else
        oldOnError(message, filename, lineno, colno, error);
    }
  };
}

function isOutdatedClientError(error: any): boolean {
  const message = error?.message as string | undefined;

  if (message == null)
    return false;

  // A new version has been deployed and the old hashed asset filenames no longer exist.
  // Covers webpack's "Loading chunk ..." and Vite's "Failed to fetch dynamically imported module ..." / "error loading dynamically imported module ...".
  return /^Loading chunk/i.test(message) ||
    /(Failed to fetch|error loading) dynamically imported module/i.test(message);
}

ErrorModal.showErrorModal = (error: any, beforeOkClicked?: ()=> Promise<void>): Promise<void> => {
  if (error == null || error.code === 20) //abort
    return Promise.resolve();

  if (isOutdatedClientError(error))
    return MessageModal.show({
      title: ConnectionMessage.OutdatedClientApplication.niceToString(),
      message:
        <div>
          {ConnectionMessage.ANewVersionHasJustBeenDeployedConsiderReload.niceToString()}&nbsp;
          <button type="button" className="sf-btn sf-btn-warning" onClick={e => { e.preventDefault(); window.location.reload(); }} title={EntityControlMessage.Reload.niceToString()}>
            <FontAwesomeIcon aria-hidden={true} icon="rotate" />
          </button>
        </div>,
      buttons: "cancel",
      style: "warning"
    }).then(() => undefined);

  return Modals.openModal<void>(<ErrorModal error={error} beforeOkClicked={beforeOkClicked} />);
}

function textDanger(message: string | null | undefined): React.ReactNode {

  if (typeof message == "string")
    return message.split("\n").map((s, i) => <p key={i} className="text-destructive">{s}</p>);

  return message;
}

export function RenderServiceMessageDefault(p: { error: ServiceError }): React.ReactElement {

  const [showDetails, setShowDetails] = React.useState(false);

  function handleShowStackTrace(e: React.MouseEvent<any>) {
    e.preventDefault();
    setShowDetails(!showDetails);
  }

  return (
    <div>

      {ErrorModalOptions.preferPreFormated(p.error) ? <pre style={{ whiteSpace: "pre-wrap" }}>{p.error.httpError.exceptionMessage}</pre> : textDanger(p.error.httpError.exceptionMessage)}
      {p.error.httpError.stackTrace && ErrorModalOptions.isExceptionViewable() &&
        <div>
          <LinkButton title={undefined} onClick={handleShowStackTrace}>StackTrace</LinkButton>
          {showDetails && <pre>{p.error.httpError.stackTrace}</pre>}
        </div>}
    </div>
  );
}

export function RenderExternalServiceMessageDefault(p: { error: ExternalServiceError }): React.ReactElement {

  const [showDetails, setShowDetails] = React.useState(false);

  function handleShowDetails(e: React.MouseEvent<any>) {
    e.preventDefault();
    setShowDetails(!showDetails);
  }

  return (
    <div>
      {textDanger(p.error.message)}
      {p.error.additionalInfo && ErrorModalOptions.isExceptionViewable() &&
        <div>
          <LinkButton title={undefined} onClick={handleShowDetails}>StackTrace</LinkButton>
          {showDetails && <pre>{p.error.additionalInfo}</pre>}
        </div>}
    </div>
  );
}

export function RenderValidationMessageDefault(p: { error: ValidationError }): React.ReactElement {
  return (
    <div>
      {textDanger(Dic.getValues(p.error.modelState).join("\n"))}
    </div>
  );
}

export function RenderMessageDefault(p: { error: any }): React.ReactElement {
  const [showDetails, setShowDetails] = React.useState(false);

  function handleShowStackTrace(e: React.MouseEvent<any>) {
    e.preventDefault();
    setShowDetails(!showDetails);
  }

  const e = p.error;
  return (
    <div>
      {textDanger(e.message ? e.message : e.toString())}
      {e.stack && ErrorModalOptions.isExceptionViewable() &&
        <div>
          <LinkButton title={undefined} onClick={handleShowStackTrace}>StackTrace</LinkButton>
          {showDetails && <pre>{e.stack}</pre>}
        </div>}
    </div>
  );
}

export namespace ErrorModalOptions {
  export function getExceptionUrl(exceptionId: number | string): string | undefined {
    return `/view/exception/${exceptionId}`;
  }

  /** Reveals the StackTrace toggle and links the exception id. altea-auth gates it on
   *  `BasicPermission.ViewErrorDetails`; with no authorization module everything is shown. */
  export let isExceptionViewable: () => boolean = () => true;

  export function preferPreFormated(se: ServiceError): boolean {
    // Signum's `se.httpError.exceptionType.contains(...)`. Guard against a missing exceptionType:
    // although HttpError types it non-nullable, a malformed/legacy error response can omit it,
    // and `undefined.includes(...)` would throw inside render and crash the whole modal.
    return se.httpError.exceptionType?.includes("FieldReaderException") ?? false;
  }
  export function renderServiceMessage(se: ServiceError): React.ReactNode {
    return <RenderServiceMessageDefault error={se} />;
  }

  export function renderExternalServiceMessage(ese: ExternalServiceError): React.ReactNode {
    return <RenderExternalServiceMessageDefault error={ese} />;
  }

  export function renderValidationMessage(ve: ValidationError): React.ReactNode {
    return <RenderValidationMessageDefault error={ve} />;
  }

  export function renderMessage(e: any): React.ReactNode {
    return <RenderMessageDefault error={e} />;
  }
}
