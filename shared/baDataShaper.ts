/**
 * BA edition: what a session did to DataShaper mappings on the Qargo MCP, read
 * back from its transcript. One change per mapping (all attempts at it folded
 * together), every test run, and the analysis Claude wrote around them.
 */

/** One expression in a mapping: the JSONata value and the variables it uses. */
export type DsLeaf = { path: string; type: string | null; value: string | null; variables: string | null; raw?: string };

export type DsOutcome = "ok" | "blocked" | "approval" | "error" | "pending";

export type DsAttempt = { at: string | null; outcome: DsOutcome; message: string | null; approvalUrl: string | null; rowId: string | null; note?: string | null };

export type DsChange = {
  id: string;
  tool: string;
  server: string;
  tenant: string | null;
  prod: boolean;
  /** The mapping version the change starts from (create from_row_id / update row_id). */
  baseRowId: string | null;
  name: string | null;
  versionDescription: string | null;
  contextUrl: string | null;
  /** The fields this change sets: an override tree flattened to expressions. */
  fields: DsLeaf[];
  attempts: DsAttempt[];
  outcome: DsOutcome;
  /** Claude's own words just before the change: why, and what it expects. */
  analysis: string | null;
  at: string | null;
};

export type DsTest = {
  id: string;
  server: string;
  tenant: string | null;
  input: string;
  expressions: DsLeaf[];
  output: string | null;
  errors: string[];
  outcome: DsOutcome;
  analysis: string | null;
  at: string | null;
};

export type DsReport = {
  sessionId: string;
  changes: DsChange[];
  tests: DsTest[];
  /** Mappings read (get/list) so the change can name them. */
  reads: number;
  /** Claude's last words in the session: the conclusion. */
  conclusion: string | null;
  updatedAt: number;
};

const isLeaf = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && ("datashaper__value" in v || "datashaper__variables" in v);

/** An override tree as the list of expressions it sets, by dotted path. */
export function flattenTree(tree: unknown, prefix = ""): DsLeaf[] {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return [];
  const node = tree as Record<string, unknown>;
  if (isLeaf(node))
    return [
      {
        path: prefix || "(root)",
        type: typeof node.datashaper__type === "string" ? node.datashaper__type : null,
        value: typeof node.datashaper__value === "string" ? node.datashaper__value : node.datashaper__value == null ? null : JSON.stringify(node.datashaper__value, null, 2),
        variables: typeof node.datashaper__variables === "string" ? node.datashaper__variables : node.datashaper__variables == null ? null : JSON.stringify(node.datashaper__variables, null, 2),
      },
    ];
  const out: DsLeaf[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("datashaper__")) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") out.push(...flattenTree(v, p));
    else out.push({ path: p, type: null, value: null, variables: null, raw: JSON.stringify(v) });
  }
  return out;
}

/** The node at a dotted path anywhere inside a full mapping, wherever its tree sits. */
export function findLeaf(root: unknown, path: string): DsLeaf | null {
  const segs = path.split(".");
  const seen = new Set<unknown>();
  const queue: unknown[] = [root];
  while (queue.length) {
    const n = queue.shift();
    if (!n || typeof n !== "object" || seen.has(n)) continue;
    seen.add(n);
    let cur: unknown = n;
    for (const s of segs) cur = cur && typeof cur === "object" && !Array.isArray(cur) ? (cur as Record<string, unknown>)[s] : undefined;
    if (cur !== undefined) {
      const leaves = flattenTree(cur);
      if (leaves.length === 1) return { ...leaves[0]!, path };
      if (cur !== null && typeof cur !== "object") return { path, type: null, value: null, variables: null, raw: JSON.stringify(cur) };
    }
    for (const v of Array.isArray(n) ? n : Object.values(n)) if (v && typeof v === "object") queue.push(v);
  }
  return null;
}
