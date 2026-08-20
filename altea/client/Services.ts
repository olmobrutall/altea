// Ported from Signum.React/Services.ts. Near-verbatim; altea-specific fixes are marked ALTEA.
//   - Globals moved to @altea/altea/data/globals (Dic + Array/String prototype extensions).
//   - luxon dropped: the only use (build-time comparison) is done with the native Date.
//   - GraphExplorer.propagateAll removed: Signum walked the graph to set `modified` flags before
//     JSON.stringify; altea computes modified from the snapshot inside the Serializer, so the
//     low-level ajax stays generic. Entity request bodies must be pre-encoded via
//     Serializer.stringify by the entity API layer (Navigator/EntitiesAPI, Phase 2) — this file
//     keeps Signum's generic JSON.stringify/JSON.parse for plain DTO/query payloads.
import { Dic } from '../data/globals';
import { CultureInfo } from '../data/utils/cultureInfo';
import { toAbsoluteUrl } from './AppContext';
import { Serializer } from '../data/serializer';
import type { ModelEntity } from '../data/entity';
import type { ModelState } from '../data/validation';

export interface AjaxOptions {
  url: string;
  avoidNotifyPendingRequests?: boolean;
  avoidThrowError?: boolean;
  avoidRetry?: boolean;
  avoidGraphExplorer?: boolean;
  avoidAuthToken?: boolean;
  /**
   * Attach the bearer token as usual, but do NOT act on a `New_Token` in the response — i.e. do not kick
   * off another "refresh the token and re-fetch the current user" round.
   *
   * This exists for exactly one caller: the `fetchCurrentUser` that a token refresh itself issues. That
   * call goes through the same wrapper, so without this its own response re-triggers the handler and the
   * pair recurse. Signum has the same shape and gets away with it only because the token it just stored is
   * fresh, so the second response carries no header — a termination condition that depends on server clocks
   * and the refresh interval rather than on the code. Distinct from `avoidAuthToken`, which drops the token
   * altogether (for a genuinely unauthenticated call) and would make this request answer "not logged in".
   */
  avoidTokenRefresh?: boolean;
  avoidVersionCheck?: boolean;
  avoidContextHeaders?: boolean;

  headers?: { [index: string]: string };
  mode?: string;
  credentials?: RequestCredentials;
  cache?: string;
  signal?: AbortSignal;

  // ALTEA: (de)serialization is Serializer-based by default (rebuilds real Entity/Lite/Embedded/Temporal/
  // Decimal instances from the { $type }/{ $lite }/… wire shapes, and writes them back on POST). Opt out
  // per-request for endpoints whose payload is a plain DTO where reviving discriminators is unwanted or a
  // waste — then the low-level generic JSON.parse / JSON.stringify is used instead.
  /** Skip Serializer.parse on the response; use generic JSON.parse. */
  avoidDeserialize?: boolean;
  /** Skip Serializer.stringify on the POST body; use generic JSON.stringify. */
  avoidSerialize?: boolean;
}

// Decode a response body: Serializer.parse (real class graph) by default, generic JSON.parse when opted
// out. Empty body → null (matches Signum's ajax helpers).
// Every call carries the culture the UI is CURRENTLY rendered in, so the server resolves its own labels
// (a registered expression's niceName, a validation or exception message) in the same language the page is
// in — Signum gets this from ASP.NET request localization reading a culture cookie. A bare locale tag, not
// a weighted Accept-Language list: this is the app's applied culture, not a browser preference, and the
// server ignores anything it has no translations for. (CultureInfo is imported for the value, not the
// module's side effects — it is the same store ReflectionClient points at when a blob is applied.)
function currentCultureHeader(): string {
  return CultureInfo.currentUICulture();
}

function parseResponse<T>(text: string, options: AjaxOptions): T | null {
  if (!text.length)
    return null;
  return (options.avoidDeserialize ? JSON.parse(text) : Serializer.parse(text)) as T;
}

export function ajaxGet<T>(options: AjaxOptions): Promise<T> {
  return ajaxGetRaw(options)
    .then(res => res.text())
    .then(text => parseResponse<T>(text, options) as T);
}

export function ajaxGetRaw(options: AjaxOptions): Promise<Response> {

  return wrapRequest(options, () => {

    const headers = Dic.simplify({
      'Accept': 'application/json',
      'Accept-Language': currentCultureHeader(),
      ...options.headers
    } as any);

    return fetch(toAbsoluteUrl(options.url, window.__baseNameAPI), {
      method: "GET",
      headers: headers,
      mode: options.mode,
      credentials: options.credentials || "same-origin",
      cache: options.cache || 'no-store',
      signal: options.signal
    } as RequestInit);
  });
}

export function ajaxPost<T>(options: AjaxOptions, data: any): Promise<T> {
  return ajaxPostRaw(options, data)
    .then(res => res.text())
    .then(text => parseResponse<T>(text, options) as T);
}

export function ajaxPostRaw(options: AjaxOptions, data: any): Promise<Response> {

  return wrapRequest(options, () => {

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Accept-Language': currentCultureHeader(),
      ...options.headers
    } as any;

    const isFormData = data instanceof FormData;
    if (isFormData) {
      // FormData can't be stringified and the browser will set the correct Content-Type including the boundary
      delete headers['Content-Type'];
    }

    return fetch(toAbsoluteUrl(options.url, window.__baseNameAPI), {
      method: "POST",
      credentials: options.credentials || "same-origin",
      headers: headers,
      mode: options.mode,
      cache: options.cache || 'no-store',
      // Serializer.stringify (real entity/lite graph → wire) by default; FormData is sent as-is, and
      // avoidSerialize falls back to generic JSON.stringify for plain DTO bodies.
      body: isFormData ? data : (options.avoidSerialize ? JSON.stringify(data) : Serializer.stringify(data)),
      signal: options.signal
    } as RequestInit);
  });
}

export function ajaxPostUpload<T>(options: AjaxOptions, blob: Blob): Promise<T> {

  return wrapRequest(options, () => {

    if (options.signal?.aborted)
      throw new Error();

    const headers = Dic.simplify({
      'Accept': 'application/json',
      'Content-Type': "application/octet-stream",
      'Accept-Language': currentCultureHeader(),
      ...options.headers
    } as any);

    return fetch(toAbsoluteUrl(options.url, window.__baseNameAPI), {
      method: "POST",
      credentials: options.credentials || "same-origin",
      headers: headers,
      mode: options.mode,
      cache: options.cache || 'no-store',
      body: blob,
      signal: options.signal
    } as RequestInit);
  }).then(res => res.text())
    .then(text => text.length ? JSON.parse(text) : null);
}


export const addContextHeaders: ((options: AjaxOptions) => void)[] = [];

export function clearContextHeaders(): void {
  addContextHeaders.clear();
}

export function wrapRequest(options: AjaxOptions, makeCall: () => Promise<Response>): Promise<Response> {

  if (!options.avoidContextHeaders && addContextHeaders.length > 0) {
    addContextHeaders.forEach(f => f(options));
  }

  if (!options.avoidRetry) {
    const call = makeCall;
    makeCall = () => RetryFilter.retryFilter(call);
  }

  if (!options.avoidVersionCheck) {
    const call = makeCall;
    makeCall = () => VersionFilter.onVersionFilter(call);
  }

  if (!options.avoidThrowError) {
    const call = makeCall;
    makeCall = () => ThrowErrorFilter.throwError(call, options.url);
  }

  if (!options.avoidAuthToken && AuthTokenFilter.addAuthToken) {
    let call = makeCall;
    makeCall = () => AuthTokenFilter.addAuthToken(options, call);
  }

  if (!options.avoidNotifyPendingRequests) {
    let call = makeCall;
    makeCall = () => NotifyPendingFilter.onPendingRequest(call);
  }

  const promise = makeCall();

  return promise;
}

export namespace RetryFilter {
  export function retryFilter(makeCall: () => Promise<Response>): Promise<Response> {
    return makeCall();
  }
}

export namespace AuthTokenFilter {
  export let addAuthToken: (options: AjaxOptions, makeCall: () => Promise<Response>) => Promise<Response>;
}

export namespace VersionFilter {
  export let initialVersion: string | undefined;
  export let initialBuildTime: string | undefined;
  export let latestVersion: string | undefined;

  export let versionHasChanged: () => void = () => console.warn("New Server version detected, handle VersionFilter.versionHasChanged to inform user");

  export function onVersionFilter(makeCall: () => Promise<Response>): Promise<Response> {
    function changeVersion(response: Response) {
      var ver = response.headers.get("X-App-Version");
      var buildTime = response.headers.get("X-App-BuildTime");

      if (!ver)
        return;

      if (initialVersion == undefined) {
        initialVersion = ver;
        latestVersion = ver;
        initialBuildTime = buildTime!;
      }

      if (latestVersion != ver) {
        // ALTEA: was luxon DateTime.fromISO(...) comparison; native Date parses ISO the same here.
        if (buildTime && initialBuildTime && new Date(buildTime) > new Date(initialBuildTime)) {
          latestVersion = ver;
          if (versionHasChanged)
            versionHasChanged();
        }
      }
    }

    return makeCall().then(resp => { changeVersion(resp); return resp; });
  }
}

export namespace NotifyPendingFilter {
  export let notifyPendingRequests: (pendingRequests: number) => void = () => { };
  let pendingRequests: number = 0;
  export function onPendingRequest(makeCall: () => Promise<Response>): Promise<Response> {

    notifyPendingRequests(++pendingRequests);

    return makeCall()
      .finally(() => notifyPendingRequests(--pendingRequests));
  }
}

export namespace ThrowErrorFilter {
  export function throwError(makeCall: () => Promise<Response>, url: string): Promise<Response> {
    return makeCall().then(response => {
      if (response.status >= 200 && response.status < 300) {
        return response;
      } else {
        return response.text().then<Response>(text => {
          if (text.length) {
            var obj = null;
            try {
              obj = JSON.parse(text);
            } catch (e) {
              throw new ServiceError({
                exceptionType: "Status " + response.status,
                exceptionMessage: response.statusText + "\n\n" + text,
                exceptionId: null,
                innerException: null,
                stackTrace: null,
              });
            }

            if (response.status == 400 && !(obj as WebApiHttpError).exceptionType)
              throw new ValidationError(obj as ModelState);
            else if ((obj as WebApiHttpError).model)
              throw new ModelRequestedError((obj as WebApiHttpError).model!);
            else
              throw new ServiceError(obj as WebApiHttpError);

          }
          else
            throw new ServiceError({
              exceptionType: "Status " + response.status,
              exceptionMessage: response.statusText,
              exceptionId: null,
              innerException: null,
              stackTrace: null,
            });
        });
      }
    }).catch(error => { error.url = url; throw error; });
  }
}

let a = document.createElement("a");
a.href = "#";
document.body.appendChild(a);
a.style.display = "none";

export function saveFile(response: Response, overrideFileName?: string): Promise<void> {

  var fileName = overrideFileName || getFileName(response);

  return response.blob().then(blob => {
    saveFileBlob(blob, fileName);
  });
}

export function getFileName(response: Response): string {
  const contentDisposition = response.headers.get("Content-Disposition")!;
  const parts = contentDisposition.split(";");

  const fileNamePartUTF8 = parts.filter(a => a.trim().startsWith("filename*=")).singleOrNull();
  const fileNamePartAscii = parts.filter(a => a.trim().startsWith("filename=")).singleOrNull();

  if (fileNamePartUTF8)
    return decodeURIComponent(fileNamePartUTF8.trim().after("UTF-8''"));

  if (fileNamePartAscii)
    return fileNamePartAscii.trim().after("filename=").replace("\"", "");
  else
    return "file.dat";
}

export function saveFileBlob(blob: Blob, fileName: string): void {
  if ((window.navigator as any).msSaveBlob)
    (window.navigator as any).msSaveBlob(blob, fileName);
  else {
    const url = window.URL.createObjectURL(blob);
    a.href = url;

    (a as any).download = fileName;

    a.click();

    window.setTimeout(() => window.URL.revokeObjectURL(url), 500);
  }
}

export function b64toBlob(b64Data: string, contentType: string = "", sliceSize = 512): Blob {
  contentType = contentType || '';
  sliceSize = sliceSize || 512;

  var byteCharacters = atob(b64Data);
  var byteArrays: Uint8Array<ArrayBuffer>[] = [];

  for (var offset = 0; offset < byteCharacters.length; offset += sliceSize) {
    var slice = byteCharacters.slice(offset, offset + sliceSize);

    var byteNumbers = new Array(slice.length);
    for (var i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }

    var byteArray = new Uint8Array(byteNumbers);

    byteArrays.push(byteArray);
  }

  var blob = new Blob(byteArrays, { type: contentType });
  return blob;
}

export class ServiceError {
  constructor(
    public httpError: WebApiHttpError) {
  }

  get defaultIcon(): "lock" | "trash" | "clone" | "exclamation-triangle" {
    switch (this.httpError.exceptionType) {
      case "UnauthorizedAccessException": return "lock";
      case "EntityNotFoundException": return "trash";
      case "UniqueKeyException": return "clone";
      default: return "exclamation-triangle";
    }
  }

  toString(): string | null {
    return this.httpError.exceptionMessage;
  }
}

export class ExternalServiceError {
  serviceName: string;
  error: any;
  title?: string;
  message?: string;
  additionalInfo?: string;


  constructor(
    serviceName: string,
    error: any,
    title?: string,
    message?: string,
    additionalInfo?: string,
  ) {
    this.serviceName = serviceName;
    this.error = error;
    this.title = title,
      this.message = message;
    this.additionalInfo = additionalInfo;
  }
}

export interface WebApiHttpError {
  exceptionType: string;
  exceptionMessage: string | null;
  stackTrace: string | null;
  exceptionId: string | null;
  model?: ModelEntity;
  innerException: WebApiHttpError | null;
}

export class ValidationError {
  modelState: ModelState;

  constructor(modelState: ModelState) {
    this.modelState = modelState;
  }
}

export class ModelRequestedError {
  model: ModelEntity;

  constructor(model: ModelEntity) {
    this.model = model;
  }
}


export namespace SessionSharing {

  export let avoidSharingSession = false;

  //localStorage: Domain+Browser
  //sessionStorage: Browser tab, copied when Ctrl+Click from another tab, but not windows.open or just paste link

  var _appName: string = "";
  // Awaiters resolved when another tab's response FILLS this (empty) tab's sessionStorage.
  let _fillWaiters: (() => void)[] = [];

  export function getAppName(): string {
    return _appName;
  }

  // Set the app name (namespaces the cross-tab keys + the logout signal) and, on a FRESH tab (empty
  // sessionStorage), ask any other open tab for its sessionStorage so the credentials carry over.
  //
  // altea divergence from Signum (which returns void): this returns a Promise that resolves once a logged-in
  // tab has answered (sessionStorage filled) OR a short grace period elapses (no other tab / none logged
  // in). `await` it BEFORE autoLogin so the token is present when autoLogin reads it — the cross-tab
  // storage round-trip is asynchronous, so a bare fire-and-forget would race the token read.
  export function setAppNameAndRequestSessionStorage(appName: string, graceMs = 300): Promise<void> {
    _appName = appName;
    if (sessionStorage.length) //this tab already has a session — nothing to fetch
      return Promise.resolve();
    return new Promise<void>(resolve => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        _fillWaiters = _fillWaiters.filter(w => w !== finish);
        resolve();
      };
      _fillWaiters.push(finish);
      requestSessionStorageFromAnyTab();
      setTimeout(finish, graceMs); //no logged-in tab answered → proceed as a fresh (logged-out) tab
    });
  }

  function requestSessionStorageFromAnyTab() {
    localStorage.setItem('requestSessionStorage' + _appName, new Date().toString());
    localStorage.removeItem('requestSessionStorage' + _appName);
  }

  //http://blog.guya.net/2015/06/12/sharing-sessionstorage-between-tabs-for-secure-multi-tab-authentication/
  //To share session storage between tabs for new tabs WITHOUT windows.opener
  window.addEventListener("storage", se => {

    if (avoidSharingSession)
      return;

    if (se.key == 'requestSessionStorage' + _appName) {
      // Some tab asked for the sessionStorage -> send it

      localStorage.setItem('responseSessionStorage' + _appName, JSON.stringify(sessionStorage));
      localStorage.removeItem('responseSessionStorage' + _appName);

    } else if (se.key == ('responseSessionStorage' + _appName) && !sessionStorage.length) {
      // sessionStorage is empty -> fill it
      if (se.newValue) {
        const data = JSON.parse(se.newValue);

        for (let key in data) {
          sessionStorage.setItem(key, data[key]);
        }

        console.log("SessionStorage taken from any tab");
      }
      // A logged-in tab answered → release anyone awaiting setAppNameAndRequestSessionStorage (only when a
      // session was actually copied; an empty answer keeps waiting until the grace timeout).
      if (sessionStorage.length)
        for (const w of [..._fillWaiters]) w();
    }
  });


}


/// This class encapsulates a sequence of ajax request, making them abortable, and auto-aborting previous request when a new one is made
export class AbortableRequest<Q, A> {

  private requestIndex = 0;
  private abortController?: AbortController;

  constructor(public makeCall: (signal: AbortSignal, query: Q) => Promise<A>) {
  }

  abort(): boolean {
    if (!this.abortController || !this.abortController.abort) {
      this.abortController = undefined;
      return false;
    } else {
      this.abortController.abort!();
      this.abortController = undefined;
      return true;
    }
  }

  isRunning(): boolean {
    return this.abortController != null;
  }

  getData(query: Q): Promise<A> {

    this.abort();

    this.requestIndex++;

    var myIndex = this.requestIndex;

    this.abortController = new AbortController();

    return this.makeCall(this.abortController!.signal, query).then(result => {

      if (this.abortController == undefined)
        return new Promise<A>(resolve => { /*never*/ });

      if (myIndex != this.requestIndex) //request is too old
        return new Promise<A>(resolve => { /*never*/ });

      this.abortController = undefined;
      return result;
    }, (ex: TypeError) => {
      if (ex.name === 'AbortError')
        return new Promise<A>(resolve => { /*never*/ });

      throw ex
    }) as Promise<A>;
  }
}
