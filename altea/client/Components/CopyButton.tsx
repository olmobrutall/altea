// Ported from Signum.React/Components/CopyButton.tsx — copy-and-fix.
// altea fixes: FrameMessage import (../Signum.Entities → ../../data/uiMessages); LinkButton path
// (../Basics/LinkButton unchanged). Otherwise identical (react-bootstrap Overlay/Tooltip + clipboard).
import * as React from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/Tooltip';
import { FrameMessage } from '../../data/uiMessages';
import { LinkButton } from '../Basics/LinkButton';

interface CopyButtonProps {
  getText: () => string;
  className?: string;
  title?: string;
  children: React.ReactNode;
}

export default function CopyButton(p: CopyButtonProps): React.ReactElement | null {
  const supportsClipboard = (navigator.clipboard && window.isSecureContext);
  const link = React.useRef<HTMLAnchorElement>(null);
  const [showTooltip, setShowTooltip] = React.useState<boolean>(false);
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    if (!showTooltip) return;
    const timer = setTimeout(() => {
      setShowTooltip(false);
      setElapsed(e => e + 1);
    }, 1000);
    return () => clearTimeout(timer);
  }, [showTooltip, elapsed]);

  if (!supportsClipboard)
    return null;

  function handleCopy(e: React.MouseEvent<any>) {
    e.preventDefault();
    const text = p.getText();
    if (!text) return;
    navigator.clipboard.writeText(text)
      .then(() => setShowTooltip(true));
  }

  return (
    <span className={p.className}>
      <Popover open={showTooltip}>
        <PopoverAnchor asChild>
          <LinkButton ref={link} className="btn btn-sm btn-tertiary sf-pointer mx-1" onClick={handleCopy} title={p.title}>
            {p.children}
          </LinkButton>
        </PopoverAnchor>
        <PopoverContent side="top" sideOffset={4} role="status" autoFocus={false}
          className="w-auto rounded-md border-0 bg-dark px-2 py-1 text-sm text-dark-foreground shadow-none">
          {FrameMessage.Copied.niceToString()}
        </PopoverContent>
      </Popover>
    </span>
  );
}
