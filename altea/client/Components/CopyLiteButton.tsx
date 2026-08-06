// Ported from Signum.React/Components/CopyLiteButton.tsx — copy-and-fix.
// altea fixes: message import (../Signum.Entities → ../../data/uiMessages); Signum's free
// `liteKey(toLite(entity))` → altea's real model `entity.toLite().key()`.
import * as React from 'react';
import { Entity } from '../../data/entity';
import { NormalControlMessage } from '../../data/uiMessages';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import CopyButton from './CopyButton';

interface CopyLiteButtonProps {
  entity: Entity;
  className?: string;
}

export default function CopyLiteButton(p: CopyLiteButtonProps): React.ReactElement | null {
  if (p.entity.isNew)
    return null;

  return (
    <CopyButton
      getText={() => p.entity.toLite().key()}
      className={p.className}
      title={NormalControlMessage.CopyEntityTypeAndIdForAutocomplete.niceToString()}
    >
      <FontAwesomeIcon aria-hidden={true} icon="copy" color="gray" />
    </CopyButton>
  );
}
