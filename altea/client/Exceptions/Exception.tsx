import * as React from 'react'
import { Tab, Tabs } from 'react-bootstrap'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { Quoted } from 'quote-transformer/quoted'
import { classes } from '../../data/globals'
import { ExceptionEntity } from '../../data/exception'
import { BigStringEmbedded } from '../../data/bigString'
import { AutoLine } from '../Lines/AutoLine'
import { TextAreaLine } from '../Lines/TextAreaLine'
import { TypeContext } from '../TypeContext'

// Ported from Signum.React/Exceptions/Exception.tsx — copy-and-fix. altea fixes:
//   - luxon → dropped (Signum showed a relative-time `unit` on creationDate via DateTime.fromISO; altea
//     dates are Temporal and the relative unit is cosmetic, so it's omitted).
//   - The `user` EntityLine is dropped (altea's ExceptionEntity has no User field — no auth wired yet).
//   - Signum's `tc.propertyRoute.member!.niceName` (member is a MemberInfo) → `tc.niceName()` (altea's
//     PropertyRoute.member is a plain string; the TypeContext exposes the member nice name).
//   - Lines imported per-file (no barrel); classes from data/globals.
export default function Exception(p: { ctx: TypeContext<ExceptionEntity> }): React.ReactElement {
  const ctx = p.ctx;
  const sc = p.ctx.subCtx({ labelColumns: { sm: 4 } });
  return (
    <div>
      <div className="row">
        <div className="col-sm-6">
          <AutoLine ctx={sc.subCtx(f => f.environment)} />
          <AutoLine ctx={sc.subCtx(f => f.creationDate)} />
          <AutoLine ctx={sc.subCtx(f => f.version)} />
          <AutoLine ctx={sc.subCtx(f => f.threadId)} />
          <AutoLine ctx={sc.subCtx(f => f.machineName)} />
          <AutoLine ctx={sc.subCtx(f => f.applicationName)} />
        </div>
        <div className="col-sm-6">
          <AutoLine ctx={sc.subCtx(f => f.actionName)} />
          <AutoLine ctx={sc.subCtx(f => f.controllerName)} />
          <AutoLine ctx={sc.subCtx(f => f.userHostAddress)} />
          <AutoLine ctx={sc.subCtx(f => f.userHostName)} />
          <TextAreaLine ctx={sc.subCtx(f => f.userAgent)} />
          <AutoLine ctx={sc.subCtx(f => f.origin)} />
        </div>
      </div>
      <AutoLine ctx={ctx.subCtx(f => f.requestUrl)} />
      <AutoLine ctx={ctx.subCtx(f => f.urlReferer)} />
      <div className="h3" style={{ color: "rgb(139, 0, 0)" }}>{ctx.value.exceptionType} <small>(HResult = {ctx.value.hResult})</small></div>

      <pre style={{ whiteSpace: "pre-wrap" }}><code>{ctx.value.exceptionMessage}</code></pre>

      <Tabs id="exceptionTabs">
        {codeTab("stackTrace", a => a.stackTrace)}
        {codeTab("data", a => a.data)}
        {codeTab("queryString", a => a.queryString)}
        {codeTab("form", a => a.form, true)}
        {codeTab("session", a => a.session)}
      </Tabs>
    </div>
  );

  // `property` is typed `Quoted<…>` so the transformer captures the inline lambda AT THE CALL SITE
  // (like subCtx does) — it reaches subCtx carrying its `__quoted` tree. A plainly-typed lambda
  // parameter would lose that and subCtx would throw "the lambda carries no `__quoted` expression tree".
  function codeTab(tabId: string, property: Quoted<(ex: ExceptionEntity) => BigStringEmbedded>, formatJson?: boolean): React.ReactElement | undefined {
    const tc = p.ctx.subCtx(property);

    if (tc.propertyRoute == null || !tc.value.text || tc.value.text == "")
      return undefined;

    return (
      <Tab title={tc.niceName()} eventKey={tabId}>
        {formatJson ?
          <FormatJson code={tc.value.text} /> :
          <pre style={{ whiteSpace: "pre-wrap" }}>
            <code>{tc.value.text}</code>
          </pre>
        }
      </Tab>
    );
  }
}

export function FormatJson(p: { code: string | undefined | null }): React.ReactElement {

  const [formatJson, setFormatJson] = React.useState<boolean>(false);

  const formattedJson = React.useMemo(() => {
    if (formatJson == false || p.code == undefined)
      return null;

    try {
      return JSON.stringify(JSON.parse(p.code), undefined, 2);
    } catch {
      return "Invalid Json"
    }
  }, [formatJson, p.code])

  return (
    <div>
      <button className={classes("btn btn-sm btn-tertiary", formatJson && "active")} onClick={() => setFormatJson(!formatJson)}>
        <FontAwesomeIcon aria-hidden={true} icon="code" /> Format JSON
      </button>
      <pre style={{ whiteSpace: "pre-wrap" }}>
        <code>{formatJson ? formattedJson : p.code}</code>
      </pre>
    </div>
  );
}
