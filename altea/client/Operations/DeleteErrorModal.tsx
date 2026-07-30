// Ported from Signum.React/Operations/DeleteErrorModal.tsx — copy-and-fix. altea fixes: import paths;
// `.EntityType`→`.entityType`, `getToString(x)`→`x.toString()`, `toLite(x)`→`x.toLite()`; PropertyRoute
// from entities/propertyRoute.
import * as React from 'react'
import { openModal } from '../Modals'
import type { IModalProps } from '../Modals'
import type { Lite } from '../../entities/lite'
import type { Entity } from '../../entities/entity'
import { JavascriptMessage, CascadeDeleteMessage } from '../../entities/uiMessages'
import { ajaxPost, ServiceError } from '../Services'
import { Navigator } from '../Navigator'
import { Finder } from '../Finder'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Modal, Spinner } from 'react-bootstrap'
import { getTypeInfo } from '../Reflection'
import { PropertyRoute, PropertyRouteType } from '../../entities/propertyRoute'
import { useAPI, useVersion } from '../Hooks'
import { EntityOperations } from './EntityOperations'
import { Operations } from '../Operations'
import SearchValue from '../SearchControl/SearchValue'
import { LinkButton } from '../Basics/LinkButton'

export interface CascadeReferenceDto {
  typeName: string;
  propertyRoute: string;
  count: number;
}

interface DeleteErrorModalProps extends IModalProps<boolean> {
  lite: Lite<Entity>;
  executeDelete: () => Promise<void>;
  serviceError?: ServiceError;
}

export function DeleteErrorModal(p: DeleteErrorModalProps): React.ReactElement {
  const [show, setShow] = React.useState(true);
  const [version, updateVersion] = useVersion();
  const references = useAPI(() => API.getReferences(p.lite), [version], { avoidReset: true });
  const [deleting, setDeleting] = React.useState(false);
  const [showDetails, setShowDetails] = React.useState(false);

  const loading = references === undefined;

  async function handleDelete(): Promise<void> {
    setDeleting(true);
    try {
      await p.executeDelete();
      p.onExited!(true);
    } catch {
      updateVersion();
    } finally {
      setDeleting(false);
    }
  }

  function handleClose(): void {
    setShow(false);
  }

  function handleOnExited(): void {
    p.onExited!(false);
  }

  const hasReferences = references != null && references.length > 0;
  const entityTypeName = getTypeInfo(p.lite.entityType).getNiceName();

  return (
    <Modal show={show} onExited={handleOnExited} onHide={handleClose} size="lg">
      <Modal.Header closeButton>
        <Modal.Title>
          <FontAwesomeIcon icon="triangle-exclamation" className="text-warning me-2" />
          {CascadeDeleteMessage.ThisEntityIsStillReferenced.niceToString()}
        </Modal.Title>
      </Modal.Header>

      <Modal.Body>
        {loading ? (
          <div className="d-flex align-items-center gap-2">
            <Spinner animation="border" size="sm" />
            <span>{JavascriptMessage.loading.niceToString()}</span>
          </div>
        ) : hasReferences ? (
          <>
            <p className="mb-3">
              {CascadeDeleteMessage.TheFollowingEntitiesStillReference0RemoveThemBeforeDeleting
                .niceToString(p.lite.toString() || entityTypeName)}
            </p>
            <div className="list-group">
              {references!.map(dto => (
                <ReferenceRow
                  key={dto.typeName + "|" + dto.propertyRoute}
                  dto={dto}
                  targetLite={p.lite}
                  onExplored={updateVersion}
                  version={version}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="d-flex align-items-center gap-2 text-success">
            <FontAwesomeIcon icon="circle-check" />
            <span>{CascadeDeleteMessage.NoReferencesFoundYouCanNowDeleteThisEntity.niceToString()}</span>
          </div>
        )}

        {p.serviceError && hasReferences && (
          <div className="mt-3">
            <button
              className="btn btn-link btn-sm p-0 text-muted"
              onClick={() => setShowDetails(v => !v)}
            >
              <FontAwesomeIcon icon={showDetails ? "chevron-up" : "chevron-down"} className="me-1" />
              {CascadeDeleteMessage.ErrorDetails.niceToString()}
            </button>
            {showDetails && (
              <div className="mt-2 p-2 bg-body-tertiary border rounded small font-monospace">
                <div className="text-danger fw-bold mb-1">{p.serviceError.httpError.exceptionType}</div>
                <div className="mb-2">{p.serviceError.httpError.exceptionMessage}</div>
                {p.serviceError.httpError.stackTrace && (
                  <pre className="mb-0 text-muted" style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>
                    {p.serviceError.httpError.stackTrace}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </Modal.Body>

      <Modal.Footer>
        <button className="btn btn-secondary" onClick={updateVersion} disabled={loading || deleting}>
          <FontAwesomeIcon icon="arrows-rotate" className="me-1" />
          {CascadeDeleteMessage.Refresh.niceToString()}
        </button>
        <button
          className="btn btn-danger"
          onClick={handleDelete}
          disabled={hasReferences || loading || deleting}
        >
          {deleting
            ? <><Spinner animation="border" size="sm" className="me-1" />{JavascriptMessage.loading.niceToString()}</>
            : <><FontAwesomeIcon icon="trash" className="me-1" />{CascadeDeleteMessage.Delete.niceToString()}</>
          }
        </button>
        <button className="btn btn-light" onClick={handleClose} disabled={deleting}>
          {JavascriptMessage.cancel.niceToString()}
        </button>
      </Modal.Footer>
    </Modal>
  );
}

interface ReferenceRowProps {
  dto: CascadeReferenceDto;
  targetLite: Lite<Entity>;
  onExplored: () => void;
  version: number;
}

function ReferenceRow({ dto, targetLite, onExplored, version }: ReferenceRowProps): React.ReactElement {
  const isFindable = Finder.isFindable(dto.typeName, false);
  const typeInfo = getTypeInfo(dto.typeName);
  const niceName = typeInfo?.getNiceName() ?? dto.typeName;
  const token = propertyRouteToQueryToken(dto.propertyRoute);

  const findOptions = {
    queryName: dto.typeName,
    filterOptions: [{
      token: token,
      operation: "EqualTo" as const,
      value: targetLite,
    }],
  };

  return (
    <div className="list-group-item d-flex align-items-center gap-2 py-2">
      <div className="flex-grow-1 d-flex align-items-center gap-1">
        {isFindable ? (
          <SearchValue
            findOptions={findOptions}
            onExplored={onExplored}
            deps={[version]}
            onRender={(value, vsc) => {
              if (value === undefined)
                return <span className="badge text-bg-secondary">…</span>;

              const count = (value as number) ?? 0;
              const hidden = Math.max(0, dto.count - count);
              return (
                <>
                  <LinkButton title={undefined} className="text-decoration-none" onClick={vsc.handleClick}>
                    <span className="badge text-bg-secondary me-1">{count}</span>
                    {niceName}
                  </LinkButton>
                  {hidden > 0 && (
                    <span className="text-muted small">
                      ({CascadeDeleteMessage._0MoreNotVisibleForYou.niceToString(hidden)})
                    </span>
                  )}
                </>
              );
            }}
          />
        ) : (
          <span className="badge bg-secondary">{dto.count} {niceName}</span>
        )}
      </div>
      <div>
        <span className="text-muted small me-1">{CascadeDeleteMessage.ReferencedVia.niceToString()}</span>
        <code className="small">{dto.propertyRoute}</code>
      </div>
    </div>
  );
}

function propertyRouteToQueryToken(route: string): string {
  // ALTEA: PropertyRoute.tryParseFull → parseFull (throws); no allParents → walk the `.parent` chain;
  // PropertyRouteType.Field/MListItem → FieldOrProperty/MListItems; `member` is the name string.
  let pr: PropertyRoute;
  try { pr = PropertyRoute.parseFull(route); } catch { return 'Entity'; }

  const chain: PropertyRoute[] = [];
  for (let p: PropertyRoute | undefined = pr; p != undefined; p = p.parent)
    chain.unshift(p);

  let result = 'Entity';
  for (const p of chain) {
    switch (p.propertyRouteType) {
      case PropertyRouteType.FieldOrProperty: {
        const name = p.member;
        const lastSep = Math.max(name.lastIndexOf('/'), name.lastIndexOf('.'));
        result += '.' + (lastSep >= 0 ? name.substring(lastSep + 1) : name);
        break;
      }
      case PropertyRouteType.Mixin: break;
      case PropertyRouteType.MListItems: result += '.Any'; break;
      case PropertyRouteType.LiteEntity: result += '.Entity'; break;
    }
  }
  return result;
}

export namespace DeleteErrorModal {
  export function show(lite: Lite<Entity>, executeDelete: () => Promise<void>, serviceError?: ServiceError): Promise<boolean> {
    return openModal<boolean>(
      <DeleteErrorModal lite={lite} executeDelete={executeDelete} serviceError={serviceError} />
    );
  }

  export function register(): void {
    EntityOperations.Options.onDeleteError = async (eoc, e) => {
      if (!e.httpError.exceptionType?.endsWith("ForeignKeyException"))
        return false;

      const lite = eoc.entity.toLite();
      const doDelete = (): Promise<void> => Operations.API.deleteLite(lite, eoc.operationInfo.key);
      const deleted = await DeleteErrorModal.show(lite, doDelete, e);
      if (deleted)
        (eoc.onDeleteSuccess ?? eoc.onDeleteSuccess_Default)?.();

      return true;
    };
  }
}

export namespace API {
  export function getReferences(lite: Lite<Entity>): Promise<CascadeReferenceDto[]> {
    return ajaxPost<CascadeReferenceDto[]>({ url: '/api/cascadeDelete/references' }, lite);
  }
}
