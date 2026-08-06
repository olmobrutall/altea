// Ported from Signum.React/Components/CopyLinkButton.tsx — copy-and-fix.
// altea fixes: message import (../Signum.Entities → ../../data/uiMessages); Navigator + AppContext
// import paths (../Navigator / ../AppContext unchanged in altea's client layout).
import * as React from 'react';
import { Entity } from '../../data/entity';
import { NormalControlMessage } from '../../data/uiMessages';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Navigator } from '../Navigator';
import * as AppContext from '../AppContext';
import CopyButton from './CopyButton';

interface CopyLinkButtonProps {
  entity: Entity;
  className?: string;
}

export default function CopyLinkButton(p: CopyLinkButtonProps): React.ReactElement | null {
  if (p.entity.isNew)
    return null;

  return (
    <CopyButton
      getText={() => window.location.origin + AppContext.toAbsoluteUrl(Navigator.navigateRoute(p.entity))}
      className={p.className}
      title={NormalControlMessage.CopyEntityUrl.niceToString()}
    >
      <FontAwesomeIcon aria-hidden={true} icon="link" color="gray" />
    </CopyButton>
  );
}
