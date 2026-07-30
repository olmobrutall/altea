import type * as React from "react";

// React / DOM-specific globals split out of entities/globals.ts: the JSX
// namespace fallback, browser Window members, the fetch RequestInit extension,
// and the DomUtils helpers (which touch HTMLElement / document / window). These
// all need the DOM lib (and, for JSX, React's types), so they live in the react
// layer rather than the environment-agnostic entities package.

declare global {

  namespace JSX {
    // Fallback to React's JSX namespace
    interface Element extends React.JSX.Element { }
    interface IntrinsicElements extends React.JSX.IntrinsicElements { }
  }

  interface Window {
    __allowNavigatorWithoutUser?: boolean;
    __baseName: string;
    __baseNameAPI: string;
    dataForChildWindow?: any;
    dataForCurrentWindow?: any;
    exploreGraphDebugMode: boolean;
  }

  interface RequestInit {
    abortSignal?: AbortSignal;
  }
}

export namespace DomUtils {
  export function matches(elem: HTMLElement, selector: string): boolean {
    // Vendor-specific implementations of `Element.prototype.matches()`.
    const proto = Element.prototype as any;
    const nativeMatches = proto.matches ||
      proto.webkitMatchesSelector ||
      proto.mozMatchesSelector ||
      proto.msMatchesSelector ||
      proto.oMatchesSelector;

    if (!elem || elem.nodeType !== 1) {
      return false;
    }

    const parentElem = elem.parentNode as HTMLElement;

    // use native 'matches'
    if (nativeMatches) {
      return nativeMatches.call(elem, selector);
    }

    // native support for `matches` is missing and a fallback is required
    const nodes = parentElem.querySelectorAll(selector);
    const len = nodes.length;

    for (let i = 0; i < len; i++) {
      if (nodes[i] === elem) {
        return true;
      }
    }

    return false;
  }

  export function closest(element: HTMLElement, selector: string, context?: Node): HTMLElement | undefined {
    context = context || document;
    // guard against orphans
    while (!matches(element, selector)) {
      if (element == context || element == undefined)
        return undefined;

      element = element.parentNode as HTMLElement;
    }

    return element;
  }

  export function offsetParent(element: HTMLElement): HTMLElement | undefined {

    const isRelativeOrAbsolute = (str: string | null) => str === "relative" || str === "absolute";

    // guard against orphans
    while (!isRelativeOrAbsolute(window.getComputedStyle(element).position)) {
      if (element.parentNode == document)
        return undefined;

      element = element.parentNode as HTMLElement;
    }

    return element;
  }
}
