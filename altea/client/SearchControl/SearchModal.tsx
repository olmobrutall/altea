// Ported from Signum.React/SearchControl/SearchModal.tsx — copy-paste + fix. altea fixes: imports
// retargeted (Signum.Entities→entities/*, ResultRow/ResultTable→entities/dynamicQuery/queryRequest,
// Globals→domGlobals); ModifiableEntity→BaseEntity; idioms getToString→.toString(), isLite→instanceof
// Lite, toLite(e)→e.toLite(), is(a,b)→a.is(b), e.EntityType/e.Type→getTypeInfo(e); TypeInfo.niceName→
// getNiceName(); MessageModal is a deferred stub.
import * as React from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { openModal, type IModalProps, type IGetUIState, type UIState } from '../Modals';
import { Finder } from '../Finder';
import type { FindOptions, FindMode, ModalFindOptions, ModalFindOptionsMany, FindOptionsParsed } from '../FindOptions'
import type { ResultRow, ResultTable } from '../../data/dynamicQuery/queryRequest'
import { getQueryNiceName, getTypeInfo, tryGetTypeInfo, QueryKey, type PseudoType } from '../Reflection'
import SearchControl, { type SearchControlProps, type SearchControlHandler } from './SearchControl'
import { AutoFocus } from '../Components/AutoFocus';
import { Entity, BaseEntity as ModifiableEntity } from '../../data/entity';
import { Lite } from '../../data/lite';
import type { EntityPack } from '../../data/entityPack';
import { isEntityPack } from '../../data/entityPack';
import { FrameMessage, SearchMessage } from '../../data/uiMessages';
import { ModalFooterButtons, ModalHeaderButtons } from '../Components/ModalHeaderButtons';
import { Modal, Dropdown } from 'react-bootstrap';
import { useForceUpdate } from '../Hooks';
import SearchControlLoaded from './SearchControlLoaded';
import MessageModal from '../Modals/MessageModal';
import type { BsSize } from '../Components';
import { DomUtils } from '../domGlobals';
import { LinkButton } from '../Basics/LinkButton';

interface SearchModalProps extends IModalProps<{ rows: ResultRow[], searchControl: SearchControlLoaded } | undefined> {
  findOptions: FindOptions;
  findMode: FindMode;
  isMany: boolean;
  allowNoSelection?: boolean;
  title?: React.ReactNode;
  message?: React.ReactNode;
  size?: BsSize;
  avoidReturnCreate?: boolean;
  searchControlProps?: Partial<SearchControlProps>;
  autoCheckSingleRowResult?: boolean;
  onOKClicked?: (sc: SearchControlLoaded) => Promise<boolean>;
  ref?: React.Ref<IGetUIState>;
}

function SearchModal(p: SearchModalProps): React.ReactElement {

  const [show, setShow] = React.useState(true);

  const selectedRows = React.useRef<ResultRow[]>([]);
  const [singleResultRow, setSingleResultRow] = React.useState<ResultRow | null>(null);
  const okPressed = React.useRef<boolean>(false);
  const forceUpdate = useForceUpdate();
  const searchControl = React.useRef<SearchControlHandler>(null);

  React.useImperativeHandle(p.ref, () => ({
    getUIState(): UIState {
      const scl = searchControl.current?.searchControlLoaded;
      return { name: "SearchModal", context: scl && Finder.toFindOptions(scl.props.findOptions, scl.props.queryToken, scl.props.defaultIncudeDefaultFilters) };
    }
  }));

  React.useEffect(() => {
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  if (p.autoCheckSingleRowResult)
    React.useEffect(() => {

      let scl = searchControl.current?.searchControlLoaded;
      if (scl && singleResultRow) {       
        scl.setState({ selectedRows: [singleResultRow] }, () => handleSelectionChanged([singleResultRow]));
      }
    }, [singleResultRow]);

  function handleSelectionChanged(selected: ResultRow[]) {
    selectedRows.current = selected;
    forceUpdate();
  }

  function handleOkClicked() {
    if (!p.onOKClicked) {
      okPressed.current = true;
      setShow(false);
    }
    else
      p.onOKClicked(searchControl.current!.searchControlLoaded!).then(result => {
        if (result) {
          okPressed.current = true;
          setShow(false);
        };
      });
  }

  function handleCancelClicked() {
    okPressed.current = false;
    setShow(false);
  }

  function handleOnExited() {
    p.onExited!(okPressed.current ? { rows: selectedRows.current, searchControl: searchControl.current!.searchControlLoaded! } : undefined);
  }

  function handleDoubleClick(e: React.MouseEvent<any>, row: ResultRow) {
    e.preventDefault();
    selectedRows.current = [row];
    searchControl.current!.searchControlLoaded!.state.selectedRows!.clear();
    searchControl.current!.searchControlLoaded!.state.selectedRows!.push(row);
    handleOkClicked();
  }

  function handleOnResult(table: ResultTable, dataChange: boolean, scl: SearchControlLoaded) {
    if (!p.autoCheckSingleRowResult)
      return;

    if (table.rows.length == 1)
      setSingleResultRow(table.rows[0])
    else
      setSingleResultRow(null)
  }

  function handleCreateFinished(entity: EntityPack<Entity> | ModifiableEntity | Lite<Entity> | undefined | void) {

    const scl = searchControl.current!.searchControlLoaded!;
    if (p.findMode == "Find" && entity != null && !p.avoidReturnCreate && !p.findOptions.groupResults && !p.onOKClicked) {
      const e = isEntityPack(entity) ? entity.entity : entity;
      const ti = getTypeInfo(e);
      MessageModal.show({
        buttons: "yes_no",
        style: "success",
        customIcon: "check-square",
        title: SearchMessage.ReturnNewEntity.niceToString(),
        message: SearchMessage.DoYouWantToSelectTheNew01_G.niceToString().forGenderAndNumber(ti.getGender()).formatHtml(ti.getNiceName(), <strong>{e.toString()}</strong>)
      }).then(b => {
        if (b == "yes") {
          selectedRows.current = [{ entity: e instanceof Lite ? e : (e as Entity).toLite(), columns: [] }];
          okPressed.current = true;
          setShow(false);
        } else
          scl.dataChanged();
      });

    } else 
      scl.dataChanged();
  }


  function handleInputsKeyUp(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key == "Enter") {

      (e.target as HTMLElement).blur()

      window.setTimeout(() => {
        handleOkClicked();
      }, 100);
    }
  }

  function onResize() {
    var sc = searchControl.current;
    var scl = sc?.searchControlLoaded;
    var containerDiv = scl?.containerDiv;
    if (containerDiv) {
      var rect = containerDiv.getBoundingClientRect();
      var modalContent = DomUtils.closest(containerDiv.offsetParent as HTMLElement, ".modal-content")!;
      const marginModal = 28; 
      const marginTop = rect.top + marginModal;
      const marginButton = (modalContent!.offsetHeight - rect.bottom) + marginModal;
      const maxHeight = window.innerHeight - marginTop - marginButton;
      containerDiv.style.maxHeight = Math.max(maxHeight, SearchModal.Options.minHeight) + "px";
    }
  }

  var qs = Finder.getSettings(p.findOptions.queryName);

  const okEnabled = p.isMany ? (p.allowNoSelection || selectedRows.current.length > 0) : selectedRows.current.length == 1;

  return (
    <Modal size={(p.size ?? qs?.modalSize ?? "lg") as any} show={show} onExited={handleOnExited} onHide={handleCancelClicked} className="sf-search-modal">
      <ModalHeaderButtons onClose={p.findMode == "Explore" ? handleCancelClicked : undefined}>
        <span className="sf-entity-title">
          {p.title}
          &nbsp;
        </span>
        <LinkButton className="sf-popup-fullscreen"
          title={FrameMessage.Fullscreen.niceToString()}
          onClick={(e) => { searchControl.current && searchControl.current.searchControlLoaded!.handleFullScreenClick(e); }}>
          <FontAwesomeIcon aria-hidden={true} icon="up-right-from-square" />
        </LinkButton>
        {p.message && <>
          <br />
          <small className="sf-type-nice-name text-muted"> {p.message}</small>
        </>
        }
      </ModalHeaderButtons>
      <div className="modal-body" onKeyUp={handleInputsKeyUp} >
        <SearchControl 
          ref={searchControl}
          hideFullScreenButton={true}
          throwIfNotFindable={true}
          findOptions={p.findOptions}
          defaultIncludeDefaultFilters={true}
          allowSelection={p.isMany ? undefined : "single"}
          onSelectionChanged={handleSelectionChanged}
          showGroupButton={p.findMode == "Explore"}
          showSystemTimeButton={p.findMode == "Explore"}
          largeToolbarButtons={true}
          showFooter={true}
          maxResultsHeight={"none"}
          enableAutoFocus={true}
          onCreateFinished={handleCreateFinished}
          onHeighChanged={onResize}
          onDoubleClick={p.findMode == "Find" ? handleDoubleClick : undefined}
          onResult={handleOnResult}
          {...p.searchControlProps}
        />
      </div>
      {p.findMode == "Find" &&
        <ModalFooterButtons
          onOk={handleOkClicked}
          onCancel={handleCancelClicked}
          okDisabled={!okEnabled} />
      }
    </Modal>
  );
}


namespace SearchModal {
  export const Options = { minHeight: 400 };

  export function open(findOptions: FindOptions, modalOptions?: ModalFindOptions): Promise<{ row: ResultRow, searchControl: SearchControlLoaded } | undefined> {

    return openModal<{ rows: ResultRow[], searchControl: SearchControlLoaded } | undefined>(<SearchModal
      findOptions={findOptions}
      findMode={"Find"}
      isMany={false}
      title={modalOptions?.title ?? getQueryNiceName(findOptions.queryName)}
      message={modalOptions?.message ?? defaultSelectMessage(findOptions.queryName, false, modalOptions?.forProperty)}
      size={modalOptions?.modalSize}
      searchControlProps={modalOptions?.searchControlProps}
      autoCheckSingleRowResult={modalOptions?.autoCheckSingleRowResult}
      onOKClicked={modalOptions?.onOKClicked}
    />)
      .then(a => a && { row: a.rows[0], searchControl: a.searchControl });
  }

  export function openMany(findOptions: FindOptions, modalOptions?: ModalFindOptionsMany): Promise<{ rows: ResultRow[], searchControl: SearchControlLoaded } | undefined> {
    return openModal<{ rows: ResultRow[], searchControl: SearchControlLoaded } | undefined>(<SearchModal findOptions={findOptions}
      findMode={"Find"}
      isMany={true}
      allowNoSelection={modalOptions?.allowNoSelection}
      title={modalOptions?.title ?? getQueryNiceName(findOptions.queryName)}
      message={modalOptions?.message ?? defaultSelectMessage(findOptions.queryName, true, modalOptions?.forProperty)}
      size={modalOptions?.modalSize}
      searchControlProps={modalOptions?.searchControlProps}
      onOKClicked={modalOptions?.onOKClicked}
    />);
  }

  export function explore(findOptions: FindOptions, modalOptions?: ModalFindOptions): Promise<void> {

    return openModal<void>(<SearchModal findOptions={findOptions}
      findMode={"Explore"}
      isMany={true}
      title={modalOptions?.title ?? getQueryNiceName(findOptions.queryName)}
      message={modalOptions?.message}
      size={modalOptions?.modalSize}
      searchControlProps={modalOptions?.searchControlProps}
    />);
  }
}

export default SearchModal;

export function defaultSelectMessage(queryName: PseudoType | QueryKey, plural: boolean, forProperty?: string): string {

  var type = queryName instanceof QueryKey ? null : tryGetTypeInfo(queryName);

  if (plural) {
    return type ?
      SearchMessage.PleaseSelectOneOrMore0_G.niceToString().forGenderAndNumber(type.getGender(), 2).formatWith(forProperty ?? type.getNicePluralName()) :
      SearchMessage.PleaseSelectOneOrSeveralEntities.niceToString();
  } else {
    return type ?
      SearchMessage.PleaseSelectA0_G.niceToString().forGenderAndNumber(type.getGender(), 2).formatWith(forProperty ?? type.getNiceName()) :
      SearchMessage.PleaseSelectAnEntity.niceToString();
  }
}
