import * as React from 'react'
import { NavDropdown } from 'react-bootstrap';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useAPI } from './Hooks';
import { CultureClient } from './CultureClient';

// Port of Signum's CultureDropdown (React/Basics/CultureDropdown.tsx) — the navbar language picker.
// A culture is a plain locale TAG here rather than a `Lite<CultureInfoEntity>` (see CultureClient for why),
// so the `is(c, current)` comparison becomes a string compare and the label comes from Intl.DisplayNames.
//
// Renders nothing when only ONE culture is available: a picker with a single choice is noise, and it keeps
// the navbar clean for an app that ships no translations at all.
export default function CultureDropdown(p: { fullName?: boolean; isMobile?: boolean }): React.ReactElement | null {

  const catalogue = useAPI(() => CultureClient.getCultures(), []);

  // Re-render on a culture change: the label below reads the CURRENT culture, and this component can be
  // mounted outside the subtree resetUI remounts.
  const [, setN] = React.useState(0);
  React.useEffect(() => {
    const fn = (): void => setN(n => n + 1);
    CultureClient.onCultureChanged.push(fn);
    return () => { CultureClient.onCultureChanged.remove(fn); };
  }, []);

  if (catalogue == null || catalogue.cultures.length <= 1)
    return null;

  const current = CultureClient.getCurrentCulture();
  const label = (c: string): string => p.fullName ? CultureClient.nativeName(c) : c.split("-")[0].toUpperCase();
  const currentLabel = CultureClient.nativeName(current);

  const title = p.isMobile
    ? <FontAwesomeIcon icon="globe" title={currentLabel} aria-label={currentLabel} />
    : label(current);

  return (
    <NavDropdown data-culture={current} title={title} className="sf-culture-dropdown"
      aria-label={currentLabel}>
      {catalogue.cultures.map(c =>
        <NavDropdown.Item key={c} data-culture={c} active={c === current}
          onClick={() => CultureClient.changeCurrentCulture(c)}>
          {CultureClient.nativeName(c)}
        </NavDropdown.Item>
      )}
    </NavDropdown>
  );
}
