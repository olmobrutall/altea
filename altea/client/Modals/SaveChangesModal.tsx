// Ported from Signum.React/Modals/SaveChangesModal.tsx — copy-and-fix. altea fixes: import paths;
// dropped unused imports (BooleanEnum/EntityPack/ModifiableEntity/Entity/isEntity, getTypeInfo/
// OperationInfo/tryGetTypeInfo/TypeInfo, ButtonsContext/EntityFrame, Operations, PropertyRoute, BsSize).
import * as React from 'react'
import { openModal } from '../Modals';
import type { IModalProps } from '../Modals';
import { classes } from '../../data/globals';
import { JavascriptMessage, SaveChangesMessage } from '../../data/uiMessages'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import "./DialogModals.css"
import { Modal } from 'react-bootstrap';
import type { EntityOperationContext } from '../Operations';
import { OperationButton } from '../Operations/EntityOperations';

type SaveChangesResult = EntityOperationContext<any> | "loseChanges" | "cancel";

interface SaveChangesModalProps extends IModalProps<SaveChangesResult | undefined> {
  eocs: EntityOperationContext<any>[];
}

function SaveChangesModal(p: SaveChangesModalProps): React.ReactElement {

  const [show, setShow] = React.useState(true);

  const selectedValue = React.useRef<SaveChangesResult | undefined>(undefined);

  function handleButtonClicked(val: SaveChangesResult) {
    selectedValue.current = val;
    setShow(false);
  }

  function handleCancelClicked() {
    setShow(false);
  }

  function handleOnExited() {
    p.onExited!(selectedValue.current);
  }

  // aria-labelledby names the dialog from its own title: it carried role="dialog" and aria-modal but no
  // accessible name, so it was announced as just "dialog". useId because dialogs here are opened nested,
  // so a fixed id could appear twice in the document.
  const titleId = React.useId();
  // The header text was a bare <span>, which is also why the dialog had no heading to name it with; it is
  // now the same modal-title h1 MessageModal uses inside this same message-modal layout.
  return (
    <Modal show={show} onExited={handleOnExited}
      dialogClassName={classes("message-modal")}
      aria-labelledby={titleId}
      onHide={handleCancelClicked} autoFocus={true}>
      <div className={classes("modal-header", "dialog-header-wait")}>
        <h1 id={titleId} className="modal-title h5">
          {SaveChangesMessage.ThereAreChanges.niceToString()}
        </h1>
      </div>
      <div className="modal-body">
        {SaveChangesMessage.YoureTryingToCloseAnEntityWithChanges.niceToString()}
      </div>
      <div className="modal-footer">
        <div className="btn-toolbar">
          {p.eocs.map(eoc => <OperationButton key={eoc.operationInfo.key} eoc={eoc} avoidAlternatives onOperationClick={async () => handleButtonClicked(eoc)} />)}
          <button
            type="button"
            className="btn btn-secondary sf-close-button sf-no-button"
            onClick={() => handleButtonClicked("loseChanges")}
            name="no">
            <FontAwesomeIcon aria-hidden={true} icon={"arrow-rotate-left"} />&nbsp;{SaveChangesMessage.LoseChanges.niceToString()}
          </button>
          <button
            type="button"
            className="btn btn-secondary sf-close-button sf-cancel-button"
            onClick={() => handleButtonClicked("cancel")}
            name="cancel">
            {JavascriptMessage.cancel.niceToString()}
          </button>
        </div>
      </div>
    </Modal>
  );
}

namespace SaveChangesModal {
  export function show(options: SaveChangesModalProps): Promise<SaveChangesResult | undefined> {
    return openModal(<SaveChangesModal {...options} />);
  }
}

export default SaveChangesModal;
