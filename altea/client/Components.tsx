// STUB (Phase 4). A sliver of Signum.React's Components — only what FindOptions needs so far. The
// full Bootstrap component layer is ported later. (Real components live under ./Components/ — e.g.
// TextArea, Typeahead — and are re-exported here to mirror Signum's `from '../Components'` barrel.)

export { default as TextArea } from './Components/TextArea';
export { Typeahead, TypeaheadController, TypeaheadOptions, TextHighlighter } from './Components/Typeahead';
export type { TypeaheadProps } from './Components/Typeahead';
export { ErrorBoundary } from './Components/ErrorBoundary';

// Bootstrap sizing token (Signum's BsSize), used by ModalFindOptions.modalSize.
export type BsSize = "xs" | "sm" | "md" | "lg" | "xl";
export type BsColor = "primary" | "secondary" | "success" | "danger" | "warning" | "info" | "light" | "dark";

// Ported from Signum.React/Components/Basic.tsx — KeyboardEvent.key constants used by the Lines
// value editors (number key filtering, arrow increments, etc.).
export const KeyNames = {
  backspace: "Backspace",
  tab: "Tab",
  enter: "Enter",
  esc: "Escape",
  space: " ",
  end: "End",
  home: "Home",
  arrowLeft: "ArrowLeft",
  arrowUp: "ArrowUp",
  arrowRight: "ArrowRight",
  arrowDown: "ArrowDown",
  delete: "Delete",
  numpadMinus: "Subtract",
  minus: "-",
};
