/**
 * BA edition: a read-only look inside .xlsx files in the file workbench.
 *
 * An .xlsx is a zip of XML parts. macOS's own `unzip` pulls the parts out and a
 * small parser reads cell values, so no spreadsheet library is needed. Formulas
 * show their last saved value; dates show as Excel serial numbers unless the cell
 * is formatted as a date.
 */

export type Sheet = { name: string; rows: string[][]; truncated: boolean };
export type SheetRead = { ok: boolean; sheets: Sheet[]; error: string | null };

const MAX_ROWS = 2_000;
const MAX_COLS = 80;

async function part(abs: string, name: string): Promise<string | null> {
  const p = Bun.spawn(["unzip", "-p", abs, name], { stdout: "pipe", stderr: "ignore" });
  const kill = setTimeout(() => p.kill(), 15_000);
  try {
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out : null;
  } finally {
    clearTimeout(kill);
  }
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

/** The text of every <t> inside a fragment (rich text is split over several runs). */
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]!)).join("");

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;

const colIndex = (ref: string) => {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** Style indexes whose number format is a date, so their serial numbers can be shown as dates. */
function dateStyles(styles: string | null): Set<number> {
  const out = new Set<number>();
  if (!styles) return out;
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\s[^>]*>/g)) custom.set(Number(attr(m[0], "numFmtId")), decode(attr(m[0], "formatCode") ?? ""));
  const isDate = (id: number) => (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[dmy]/i.test((custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]/g, ""));
  const xfs = styles.match(/<cellXfs[\s\S]*?<\/cellXfs>/)?.[0] ?? "";
  [...xfs.matchAll(/<xf\s[^>]*>/g)].forEach((m, i) => {
    if (isDate(Number(attr(m[0], "numFmtId") ?? -1))) out.add(i);
  });
  return out;
}

const fromSerial = (v: number) => {
  const d = new Date(Math.round((v - 25569) * 86_400_000));
  const iso = d.toISOString();
  return v % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
};

export async function readSheets(abs: string): Promise<SheetRead> {
  if (!/\.(xlsx|xlsm)$/i.test(abs)) return { ok: false, sheets: [], error: "only .xlsx and .xlsm can be shown here" };
  const workbook = await part(abs, "xl/workbook.xml");
  if (!workbook) return { ok: false, sheets: [], error: "this file could not be opened as a spreadsheet" };
  const rels = (await part(abs, "xl/_rels/workbook.xml.rels")) ?? "";
  const target = new Map([...rels.matchAll(/<Relationship\s[^>]*>/g)].map((m) => [attr(m[0], "Id") ?? "", attr(m[0], "Target") ?? ""]));
  const shared = [...((await part(abs, "xl/sharedStrings.xml")) ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  const dates = dateStyles(await part(abs, "xl/styles.xml"));

  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const name = decode(attr(m[0], "name") ?? `Sheet ${sheets.length + 1}`);
    const t = target.get(attr(m[0], "r:id") ?? "") ?? "";
    const path = t.startsWith("/") ? t.slice(1) : `xl/${t.replace(/^\.\//, "")}`;
    const xml = await part(abs, path);
    if (!xml) continue;
    const rows: string[][] = [];
    let truncated = false;
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const at = Number(attr(r[1]!, "r") ?? rows.length + 1) - 1;
      if (at >= MAX_ROWS) {
        truncated = true;
        break;
      }
      const row: string[] = [];
      for (const c of r[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const head = c[1]!;
        const body = c[2] ?? "";
        const col = colIndex(attr(head, "r") ?? "");
        if (col >= MAX_COLS) {
          truncated = true;
          continue;
        }
        const type = attr(head, "t");
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let text = "";
        if (type === "s") text = shared[Number(v)] ?? "";
        else if (type === "inlineStr") text = textOf(body);
        else if (type === "b") text = v === "1" ? "TRUE" : "FALSE";
        else if (v !== undefined) {
          const num = Number(v);
          text = type !== "str" && type !== "e" && dates.has(Number(attr(head, "s") ?? -1)) && Number.isFinite(num) ? fromSerial(num) : decode(v);
        }
        row[col] = text;
      }
      rows[at] = Array.from(row, (x) => x ?? "");
    }
    sheets.push({ name, rows: Array.from(rows, (x) => x ?? []), truncated });
  }
  return { ok: true, sheets, error: sheets.length ? null : "no sheets found" };
}
