// STUB (Phase 4). A sliver of Signum.React's Components — only what FindOptions needs so far. The
// full Bootstrap component layer is ported later. (Real components live under ./Components/ — e.g.
// TextArea, Typeahead — and are re-exported here to mirror Signum's `from '../Components'` barrel.)

export { default as TextArea } from './Components/TextArea';
export { Typeahead, TypeaheadController, TypeaheadOptions, TextHighlighter } from './Components/Typeahead';
export type { TypeaheadProps } from './Components/Typeahead';
export { ErrorBoundary } from './Components/ErrorBoundary';
export { FullscreenComponent } from './Components/FullscreenComponent';

// Bootstrap sizing token (Signum's BsSize), used by ModalFindOptions.modalSize.
export type BsSize = "xs" | "sm" | "md" | "lg" | "xl";
export type BsColor = "primary" | "secondary" | "success" | "danger" | "warning" | "info" | "light" | "dark";

/**
 * A Bootstrap colour name (still the vocabulary of colour PROPS: an operation's `color`, a quick link's badge) as the
 * Tailwind class on altea's token. `danger` is the `destructive` token, and `text-bg` is Bootstrap's pair: the colour as
 * the background, its foreground as the text. theme.css safelists every class this returns.
 */
export function colorClass(kind: "text" | "bg" | "border" | "text-bg", color: string | undefined | null): string | undefined {
  if (!color)
    return undefined;
  const token = color === "danger" ? "destructive" : color;
  return kind === "text-bg" ? `bg-${token} text-${token}-foreground` : `${kind}-${token}`;
}

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
