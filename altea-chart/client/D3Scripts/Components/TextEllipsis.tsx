import * as React from 'react'

// Copy-and-fix of Signum.Chart/D3Scripts/Components/TextEllipsis.tsx (verbatim; unused d3/ChartUtils imports dropped).
export interface TextEllipsisProps extends React.SVGProps<SVGTextElement> {
  maxWidth: number;
  padding?: number;
  etcText?: string;
}

export default function TextEllipsis({ maxWidth, padding, children, etcText, onClick, ...atts }: TextEllipsisProps): React.JSX.Element {

  const txt = React.useRef<SVGTextElement>(null);

  React.useEffect(() => {
    var width = maxWidth;
    if (padding)
      width -= padding * 2;

    let txtElem = txt.current!;
    txtElem.textContent = getString(children);
    let textLength = txtElem.getComputedTextLength();
    let text = txtElem.textContent!;
    while (textLength > width && text.length > 0) {
      text = text.slice(0, -1);
      while (text[text.length - 1] == ' ' && text.length > 0)
        text = text.slice(0, -1);
      txtElem.textContent = text + (etcText ?? "…");
      textLength = txtElem.getComputedTextLength();
    }

  }, [maxWidth, padding, etcText, getString(children)]);

  const interactive = typeof onClick === "function";
  const accessibilityPropsOnClick = interactive
    ? {
      role: "button",
      tabIndex: 0,
      cursor: "pointer",
      onKeyDown: (e: React.KeyboardEvent<SVGTextElement>) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          (onClick as any)?.(e);
        }
      },
    }
    : {};

  return (
    <text ref={txt} {...atts} {...accessibilityPropsOnClick} onClick={onClick}>
      {children ?? ""}
    </text>
  );
}

function getString(children: React.ReactNode) {
  return React.Children.toArray(children)[0] as string;
}
