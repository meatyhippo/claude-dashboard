import { useEffect, useState } from "react";

/**
 * BA edition: an .xlsx file in the workbench, shown as a read-only table with a
 * tab per sheet. Editing stays in Excel or Numbers ("Open in app").
 */

type Sheet = { name: string; rows: string[][]; truncated: boolean };
type SheetRead = { ok: boolean; sheets: Sheet[]; error: string | null };

export const isSheet = (path: string) => /\.(xlsx|xlsm)$/i.test(path);

const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export default function SheetView({ cwd, path, visible }: { cwd: string; path: string; visible: boolean }) {
  const [data, setData] = useState<SheetRead | null>(null);
  const [at, setAt] = useState(0);
  const [nonce, setNonce] = useState(0);
  const qs = new URLSearchParams({ cwd, path }).toString();

  useEffect(() => {
    let live = true;
    setData(null);
    fetch(`/api/files/sheet?${qs}`)
      .then((r) => r.json())
      .then((d: SheetRead) => live && setData(d))
      .catch((e) => live && setData({ ok: false, sheets: [], error: String(e) }));
    return () => {
      live = false;
    };
  }, [qs, nonce]);

  const sheet = data?.sheets[at] ?? data?.sheets[0];
  const width = sheet ? Math.max(0, ...sheet.rows.map((r) => r.length)) : 0;

  return (
    <div className="wb-editor wb-sheet" style={{ display: visible ? undefined : "none" }}>
      {!data && <div className="empty">Reading the spreadsheet…</div>}
      {data && !data.ok && <div className="empty">{data.error ?? "This spreadsheet could not be read."}</div>}
      {sheet && (
        <div className="wb-sheet-scroll">
          <table className="wb-sheet-table">
            <thead>
              <tr>
                <th />
                {Array.from({ length: width }, (_, i) => (
                  <th key={i}>{colName(i)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((r, i) => (
                <tr key={i}>
                  <th>{i + 1}</th>
                  {Array.from({ length: width }, (_, j) => (
                    <td key={j} title={r[j] && r[j]!.length > 40 ? r[j] : undefined}>
                      {r[j] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {sheet.rows.length === 0 && <div className="empty">This sheet is empty.</div>}
        </div>
      )}
      <div className="wb-editor-bar">
        {data && data.sheets.length > 1 && (
          <span className="wb-sheet-tabs">
            {data.sheets.map((s, i) => (
              <button key={s.name} className={`icon-btn ${i === at ? "" : "ghost"}`} onClick={() => setAt(i)}>
                {s.name}
              </button>
            ))}
          </span>
        )}
        <span className="wb-editor-path" title={`${cwd}/${path}`}>
          {path}
        </span>
        <span style={{ flex: 1 }} />
        {sheet && (
          <span>
            {sheet.rows.length} rows × {width} columns{sheet.truncated ? " · first 2,000 rows / 80 columns" : ""} · read-only
          </span>
        )}
        <button className="icon-btn ghost" onClick={() => setNonce((n) => n + 1)}>
          Reload
        </button>
        <button className="icon-btn" onClick={() => void fetch(`/api/files/sheet/open?${qs}`, { method: "POST" })}>
          Open in app
        </button>
      </div>
    </div>
  );
}
