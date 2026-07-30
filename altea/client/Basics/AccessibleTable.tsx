// Ported from Signum.React/Basics/AccessibleTable.tsx — copy-paste + fix. altea fixes: `import React`
// → `import * as React`; dropped the `react/jsx-runtime` JSX import (return types use React.ReactElement).
// Otherwise verbatim (self-contained WCAG table enhancer over native <table>).
import * as React from "react";

type SectionType = "tbody" | "thead" | "tfoot";
type TableRole = "grid" | "table" | "treegrid";

interface AccessibleTableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  "aria-label": string;
  tableRole?: TableRole;
  multiselectable?: boolean;
  focusCells?: boolean;
  mapCustomComponents?: Map<React.JSXElementConstructor<any>, string>
}

/**
 * AccessibleTable
 * ----------------
 * A WCAG-compliant table component that enhances native HTML tables
 * with keyboard navigation, accessibility roles, and proper semantic structure.
 */
export function AccessibleTable({
  "aria-label": ariaLabel,
  tableRole = "grid",
  children,
  multiselectable = true,
  focusCells = true,
  mapCustomComponents,
  ...rest
}: AccessibleTableProps): React.ReactElement {

  function enhanceSection(
    section: React.ReactElement<React.HTMLAttributes<HTMLTableSectionElement>>,
    sectionType: SectionType
  ): React.ReactElement {
    const enhancedRows = React.Children.map(section.props.children, (child) => {

      const type = getType(child, mapCustomComponents);
      if (type !== "tr" && type !== React.Fragment.toString()) {
        handleStructureError(sectionType, child);
        return child;
      }
      const element = child as React.ReactElement<React.HTMLAttributes<HTMLTableRowElement>>;
      if (element.type == "tr")
        return React.createElement(AccessibleRow, { focusCells, focusHeader: multiselectable, sectionType, tableRole, ...element.props });

      return child;
    });

    return React.cloneElement(section, { children: enhancedRows });
  }

  function enhanceChildren(node: React.ReactNode): React.ReactNode {
    return React.Children.map(node, (child) => {

      const element = child as React.ReactElement<React.HTMLAttributes<HTMLTableSectionElement>>;
      const type = getType(element, mapCustomComponents);
      switch (type) {
        case "thead": return enhanceSection(element, "thead");
        case "tbody": return enhanceSection(element, "tbody");
        case "tfoot": return enhanceSection(element, "tfoot");
        default:
          handleStructureError("A table should have a thead, tbody or tfoot", element);
          return element;
      }
    });
  }

  const enhancedChildren = enhanceChildren(children);

  return (
    <table
      role={tableRole}
      aria-label={ariaLabel}
      aria-multiselectable={`${multiselectable ? "true" : "false"}`}
      {...rest}>
      {AccessibleTable.Options.ariaLabelAsCaption && <caption>{ariaLabel}</caption>}
      {enhancedChildren}
    </table>
  );
}

export namespace AccessibleTable {
  export const Options = { ariaLabelAsCaption: false };
}

function handleStructureError(message: string, node: React.ReactNode) {
  throw new Error(`[AccessibleTable] Structure error: ${message} instead of ${React.isValidElement(node) ? node.type : typeof node}`);
}

function getType(node: React.ReactNode, mapCustomComponents: Map<React.JSXElementConstructor<any>, string> | undefined): string | null {
  if (!React.isValidElement(node))
    return null;

  if (node.type == React.Fragment)
    return React.Fragment.toString();

  if (typeof node.type == "string")
    return node.type;

  var mappedType = mapCustomComponents?.get(node.type as React.JSXElementConstructor<any>);

  if (mappedType == null)
    throw new Error(`Custom Component ${(node.type as any).name} should be registered in mapCustomComponents with the equivalent table tag (tr, td..)`);

  return mappedType;
}
interface WCAGRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  focusCells?: boolean;
  focusHeader?: boolean;
  sectionType?: SectionType,
  mapCustomComponents?: Map<React.JSXElementConstructor<any>, string>,
  tableRole?: TableRole
}

export function AccessibleRow({ focusCells = true, focusHeader = false, sectionType = "tbody", mapCustomComponents, children, tableRole = "grid", ...rest }: WCAGRowProps): React.ReactElement {

  function enhanceHeaderCell(
    th: React.ReactElement<React.ThHTMLAttributes<HTMLTableCellElement>>
  ): React.ReactElement {
    return React.cloneElement(th, {
      role: !tableRole ? "columnheader" : undefined,
      scope: th.props.scope || "col",
      tabIndex: focusHeader ? 0 : -1,
    } as React.ThHTMLAttributes<HTMLTableCellElement>);
  }

  function enhanceCell(
    td: React.ReactElement<React.TdHTMLAttributes<HTMLTableCellElement> | React.ThHTMLAttributes<HTMLTableCellElement>>
  ): React.ReactElement {
    var type = getType(td, mapCustomComponents);

    const renderedChildren = React.Children.toArray(td.props.children)
      .filter(child => child !== "" && child !== null && child !== undefined);
    const isEmptyCell = renderedChildren.length === 0; // needed for condinional rendering

    if (type == "th" && isEmptyCell)
      handleStructureError("tbody > th should always contain content", td);

    if (type == "th")
      return React.cloneElement(td, {
        role: "rowheader",
        scope: td.props.scope || "row",
        tabIndex: focusCells ? 0 : -1,
      } as React.ThHTMLAttributes<HTMLTableCellElement>);

    return React.cloneElement(td, {
      role: (tableRole) ? undefined : "gridcell",
      tabIndex: focusCells ? 0 : -1,
      children: isEmptyCell
        ? <span className="sr-only">Kein Eintrag in diesem Feld</span>
        : td.props.children
    } as React.TdHTMLAttributes<HTMLTableCellElement>);
  }

  const childrenArray = React.Children.toArray(children);
  const enhancedCells = childrenArray.map((child) => {

    var type = getType(child, mapCustomComponents);

    if (sectionType === "thead") {

      if (type !== "th")
        handleStructureError("thead > tr should only contain th", child);

      return enhanceHeaderCell(child as React.ReactElement<React.ThHTMLAttributes<HTMLTableCellElement>>);
    } else {

      if (type !== "td" && type !== "th")
        handleStructureError(`${sectionType} > tr should contains td or th`, child);

      return enhanceCell(child as React.ReactElement<React.TdHTMLAttributes<HTMLTableCellElement> | React.ThHTMLAttributes<HTMLTableCellElement>>);
    }
  });

  function handleKeyDown(e: React.KeyboardEvent<HTMLTableRowElement>) {

    const target = e.target as HTMLElement;
    const tag = target.tagName.toLowerCase();
    const isFormElement =
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      target.isContentEditable;

    if (isFormElement)
      return;

    function getIndexOfCell(row: HTMLTableRowElement, cell: HTMLTableCellElement) {

      // Compute the visual column index of the current cell
      let colIndex = 0;
      for (const c of Array.from(row.cells)) {
        if (c === cell) break;
        colIndex += c.colSpan || 1;
      }
      return colIndex;
    }

    function getCellAtIndex(targetRow: HTMLTableRowElement, colIndex: number): HTMLTableCellElement | null {
      if (targetRow == null || targetRow.tagName !== "TR")
        return null;

      let cc = 0;
      for (const c of Array.from(targetRow.cells)) {
        const span = c.colSpan || 1;
        if (cc <= colIndex && colIndex < cc + span) {
          return (c as HTMLTableCellElement);
        }
        cc += span;
      }

      return Array.from(targetRow.cells).last();
    };

    if (e.defaultPrevented || e.isPropagationStopped()) return;



    if (e.key === "ArrowDown" || e.key == "ArrowUp") {
      e.preventDefault();
      const cell = (e.target as HTMLElement).closest("td,th") as HTMLTableCellElement;
      if (cell == null)
        return;

      const row = cell.parentElement as HTMLTableRowElement;
      if (row.tagName !== "TR")
        return;

      const index = getIndexOfCell(row, cell);
      var nextCell = e.key === "ArrowDown" ?
        getCellAtIndex(row.nextElementSibling as HTMLTableRowElement ?? row.parentElement?.nextElementSibling?.firstChild as HTMLTableRowElement, index) :
        getCellAtIndex(row.previousElementSibling as HTMLTableRowElement ?? row.parentElement?.previousElementSibling?.lastChild as HTMLTableRowElement, index);

      nextCell?.focus();
    }

    if (e.key == "ArrowLeft" || e.key == "ArrowRight") {
      const cell = (e.target as HTMLElement).closest("td,th") as HTMLTableCellElement;
      const nextCell = e.key == "ArrowLeft" ?
        cell.previousElementSibling as HTMLTableCellElement :
        cell.nextElementSibling as HTMLTableCellElement;

      nextCell?.focus();
    }
  }

  return React.cloneElement(<tr role={!tableRole ? "row" : undefined} onKeyDown={handleKeyDown} {...rest}></tr>, undefined, enhancedCells);
}
