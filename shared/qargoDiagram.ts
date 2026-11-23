/**
 * Qargo integration diagrams: the Excalidraw styleguide as code.
 *
 * Source: Notion "Styleguide: Excalidraw" (208e32e8f8c88053bf03c3d55ab40c67), as
 * restated in the prof-svc-scoping skill's references/excalidraw.md. The guide
 * names colours by Excalidraw picker position ("Green, Shade 1"); the hex values
 * below are those picker swatches in Excalidraw 0.18 (open-color, shade N =
 * index (N-1)*2). Change a colour here and the template, library and checker all
 * follow.
 *
 * Shared by the page (template, library, checker panel) and anything on the
 * daemon that wants to check a scene, so it holds plain data and no Excalidraw
 * imports.
 */

export const STROKE_DEFAULT_LIGHT = "#1e1e1e";
export const STROKE_DEFAULT_DARK = "#ffffff";

/** Block fills: what kind of thing a block is. */
export const BLOCK = {
  qargo: { label: "Qargo", fill: "#ebfbee", hint: "Qargo (TMS) · Green, shade 1" },
  ootb: { label: "Out-of-the-box", fill: "#ffc9c9", hint: "Out-of-the-box integration · Red" },
  ootbAccounting: { label: "OOTB · Accounting", fill: "#ffc9c9", hint: "Accounting · Red, shade 2" },
  ootbTelematics: { label: "OOTB · FMS / Telematics", fill: "#ff8787", hint: "FMS, Telematics · Red, shade 3" },
  ootbOrders: { label: "OOTB · Orders / Visibility", fill: "#fa5252", hint: "Order import, Visibility, Container booking · Red, shade 4" },
  custom: { label: "Custom integration", fill: "#ffa94d", hint: "Custom integration request · Orange, shade 3" },
  middleware: { label: "Customer middleware", fill: "#9775fa", hint: "Customer API/EDI middleware · Lila, shade 3" },
  connection: { label: "Customer API/EDI", fill: "#a5d8ff", hint: "Customer API/EDI connection · Blue, shade 2" },
} as const;
export type BlockKind = keyof typeof BLOCK;

/** Flow line colours: how far along a flow is. */
export const FLOW = {
  working: { label: "Already working", stroke: STROKE_DEFAULT_LIGHT, hint: "No development needed · default stroke" },
  inDevelopment: { label: "In development", stroke: "#e8590c", hint: "Orange, shade 5" },
  tested: { label: "Confirmed / tested", stroke: "#40c057", hint: "Green, shade 4" },
} as const;
export type FlowState = keyof typeof FLOW;

const BLOCK_FILLS = new Set<string>(Object.values(BLOCK).map((b) => b.fill));
const FLOW_STROKES = new Set<string>([...Object.values(FLOW).map((f) => f.stroke), STROKE_DEFAULT_DARK]);

/** Excalidraw's hand-drawn fonts: Virgil (1) and Excalifont (5). */
const HAND_DRAWN_FONTS = new Set([1, 5]);

/** Name of the frame holding the legend; the checker skips everything inside it. */
export const LEGEND_FRAME = "Legend";

// ── skeletons (fed to Excalidraw's convertToExcalidrawElements on the page) ──────

type Skeleton = Record<string, unknown>;

export function blockSkeleton(id: string, kind: BlockKind, text: string, x: number, y: number, w = 220, h = 90): Skeleton {
  return {
    type: "rectangle",
    id,
    x,
    y,
    width: w,
    height: h,
    backgroundColor: BLOCK[kind].fill,
    fillStyle: "solid",
    strokeColor: STROKE_DEFAULT_LIGHT,
    strokeWidth: 1,
    roundness: { type: 3 },
    label: { text, fontSize: 20 },
  };
}

/** A flow: description, a newline, then the transport in brackets. Dotted until confirmed. */
export function flowLabel(description: string, transport: string): string {
  return `${description.trim()}\n(${transport.trim().replace(/^\(|\)$/g, "")})`;
}

export function flowSkeleton(
  id: string,
  opts: { from?: string; to?: string; x: number; y: number; width: number; description: string; transport: string; confirmed: boolean; state: FlowState },
): Skeleton {
  return {
    type: "arrow",
    id,
    x: opts.x,
    y: opts.y,
    width: opts.width,
    height: 0,
    strokeColor: FLOW[opts.state].stroke,
    strokeWidth: 1,
    strokeStyle: opts.confirmed ? "solid" : "dotted",
    ...(opts.from ? { start: { id: opts.from } } : {}),
    ...(opts.to ? { end: { id: opts.to } } : {}),
    label: { text: flowLabel(opts.description, opts.transport), fontSize: 16 },
  };
}

/**
 * The "Integration landscape" starting scene: Qargo centred, a customer block on
 * the left and a third party on the right, one example flow each, and a legend.
 */
export function landscapeSkeleton(customer: string): Skeleton[] {
  const name = customer.trim() || "Customer";
  const legend: Skeleton[] = [];
  const legendIds: string[] = [];
  const kinds: BlockKind[] = ["qargo", "ootb", "custom", "middleware", "connection"];
  kinds.forEach((k, i) => {
    const id = `legend-${k}`;
    legendIds.push(id);
    legend.push(blockSkeleton(id, k, BLOCK[k].label, -560 + i * 230, 420, 210, 60));
  });
  (Object.keys(FLOW) as FlowState[]).forEach((s, i) => {
    const id = `legend-flow-${s}`;
    legendIds.push(id);
    legend.push({
      type: "arrow",
      id,
      x: -560 + i * 380,
      y: 540,
      width: 160,
      height: 0,
      strokeColor: FLOW[s].stroke,
      strokeWidth: 1,
      label: { text: FLOW[s].label, fontSize: 14 },
    });
  });
  const styleId = "legend-style";
  legendIds.push(styleId);
  legend.push({
    type: "text",
    id: styleId,
    x: -560,
    y: 600,
    text: "Solid = confirmed request · Dotted = unconfirmed request · Arrow label: description, newline, (transport)",
    fontSize: 14,
  });

  return [
    blockSkeleton("qargo", "qargo", "Qargo (TMS)", -110, -45),
    blockSkeleton("customer-system", "connection", `${name} ERP`, -620, -45),
    blockSkeleton("third-party", "custom", "Partner", 400, -45),
    flowSkeleton("flow-1", { from: "customer-system", to: "qargo", x: -400, y: 0, width: 290, description: "1. Order creation", transport: "Qargo API", confirmed: false, state: "working" }),
    flowSkeleton("flow-2", { from: "qargo", to: "third-party", x: 110, y: 0, width: 290, description: "2. Status updates", transport: "sFTP", confirmed: false, state: "inDevelopment" }),
    ...legend,
    { type: "frame", id: "legend", name: LEGEND_FRAME, children: legendIds, x: -600, y: 380, width: 1240, height: 280 },
  ];
}

/** One library item per block kind and flow state, each a ready-styled shape to drag in. */
export function librarySkeletons(): { name: string; skeleton: Skeleton[] }[] {
  const blocks = (Object.keys(BLOCK) as BlockKind[]).map((k) => ({ name: BLOCK[k].hint, skeleton: [blockSkeleton(`lib-${k}`, k, BLOCK[k].label, 0, 0)] }));
  const flows = (Object.keys(FLOW) as FlowState[]).flatMap((s) =>
    [true, false].map((confirmed) => ({
      name: `${FLOW[s].label} · ${confirmed ? "confirmed (solid)" : "unconfirmed (dotted)"}`,
      skeleton: [flowSkeleton(`lib-flow-${s}-${confirmed}`, { x: 0, y: 0, width: 240, description: "Flow description", transport: "Qargo API", confirmed, state: s })],
    })),
  );
  return [...blocks, ...flows];
}

// ── checker ────────────────────────────────────────────────────────────────────

/** The fields of an Excalidraw element the checker reads. */
export type SceneElement = {
  id: string;
  type: string;
  isDeleted?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor?: string;
  backgroundColor?: string;
  strokeStyle?: string;
  strokeWidth?: number;
  roundness?: unknown;
  frameId?: string | null;
  name?: string | null;
  containerId?: string | null;
  boundElements?: { id: string; type: string }[] | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  text?: string;
  originalText?: string;
  fontFamily?: number;
};

export type DiagramIssue = {
  /** 1–10, matching the self-check in references/excalidraw.md. */
  rule: number;
  level: "error" | "warn" | "info";
  message: string;
  /** Elements to select when the issue is clicked. */
  ids: string[];
};

const lower = (s: string | undefined | null) => (s ?? "").toLowerCase();

/**
 * The styleguide's self-check, as far as a scene can answer it. Rules that need
 * outside knowledge (does a label match the Notion flow name, is this flow
 * really confirmed) come back as `info` reminders rather than verdicts.
 */
export function checkDiagram(all: SceneElement[], title?: string): DiagramIssue[] {
  const live = all.filter((e) => !e.isDeleted);
  const legendFrames = new Set(live.filter((e) => e.type === "frame" && e.name === LEGEND_FRAME).map((e) => e.id));
  const els = live.filter((e) => !(e.frameId && legendFrames.has(e.frameId)) && !legendFrames.has(e.id));
  const byId = new Map(els.map((e) => [e.id, e]));
  const textOf = (container: SceneElement) =>
    els.find((t) => t.type === "text" && t.containerId === container.id)?.originalText ??
    els.find((t) => t.type === "text" && t.containerId === container.id)?.text ??
    "";

  const issues: DiagramIssue[] = [];
  const blocks = els.filter((e) => ["rectangle", "ellipse", "diamond"].includes(e.type));
  const arrows = els.filter((e) => e.type === "arrow");
  if (blocks.length === 0 && arrows.length === 0) return [{ rule: 1, level: "info", message: "Empty diagram. Start from New integration landscape, or drag shapes in from the Qargo library.", ids: [] }];

  // 1. Qargo present, green shade 1, centred.
  const qargo = blocks.find((b) => lower(textOf(b)).includes("qargo"));
  if (!qargo) {
    issues.push({ rule: 1, level: "error", message: "No Qargo block. Add a block labelled “Qargo (TMS)” in the centre.", ids: [] });
  } else {
    if (lower(qargo.backgroundColor) !== BLOCK.qargo.fill) {
      issues.push({ rule: 1, level: "error", message: `Qargo block should be ${BLOCK.qargo.hint} (${BLOCK.qargo.fill}).`, ids: [qargo.id] });
    }
    const shapes = [...blocks];
    const minX = Math.min(...shapes.map((s) => s.x));
    const maxX = Math.max(...shapes.map((s) => s.x + s.width));
    const minY = Math.min(...shapes.map((s) => s.y));
    const maxY = Math.max(...shapes.map((s) => s.y + s.height));
    const cx = qargo.x + qargo.width / 2;
    const cy = qargo.y + qargo.height / 2;
    const offX = Math.abs(cx - (minX + maxX) / 2) / Math.max(1, maxX - minX);
    const offY = Math.abs(cy - (minY + maxY) / 2) / Math.max(1, maxY - minY);
    if (shapes.length > 2 && (offX > 0.15 || offY > 0.2)) {
      issues.push({ rule: 1, level: "warn", message: "Qargo is not centred. Keep it in the middle, customer stack left and third parties right.", ids: [qargo.id] });
    }
  }

  // 2. Blocks are rounded rectangles with a name inside.
  for (const b of blocks) {
    if (b.type !== "rectangle") issues.push({ rule: 2, level: "error", message: `Use a rounded rectangle, not a ${b.type}.`, ids: [b.id] });
    else if (!b.roundness) issues.push({ rule: 2, level: "error", message: "Block corners should be rounded.", ids: [b.id] });
    if (!textOf(b).trim()) issues.push({ rule: 2, level: "error", message: "Block has no name inside it.", ids: [b.id] });
  }

  // 7. Block colours from the type table.
  for (const b of blocks) {
    if (b === qargo) continue;
    const fill = lower(b.backgroundColor);
    if (!BLOCK_FILLS.has(fill)) {
      issues.push({ rule: 7, level: "error", message: `Fill ${b.backgroundColor ?? "none"} is not a styleguide block colour (red = OOTB, orange = custom, lila = middleware, blue = connection).`, ids: [b.id] });
    } else if (fill === BLOCK.qargo.fill) {
      issues.push({ rule: 7, level: "warn", message: "Only Qargo uses green.", ids: [b.id] });
    }
  }

  // 3 + 8. Arrows: labelled “description⏎(transport)”, both ends bound.
  for (const a of arrows) {
    const label = textOf(a).trim();
    if (!label) {
      issues.push({ rule: 3, level: "error", message: "Flow has no label. Add a description, a newline, then the transport in brackets.", ids: [a.id] });
    } else {
      const lines = label.split("\n").map((l) => l.trim()).filter(Boolean);
      const last = lines[lines.length - 1] ?? "";
      if (!/^\(.+\)$/.test(last) && /\S\s*\(.+\)$/.test(last)) issues.push({ rule: 3, level: "error", message: `“${label.replace(/\n/g, " ")}”: put the (transport) on its own line, below the description.`, ids: [a.id] });
      else if (!/^\(.+\)$/.test(last)) issues.push({ rule: 3, level: "error", message: `“${label.replace(/\n/g, " ")}”: end with the connection type in brackets, e.g. (Qargo API), (EDI), (sFTP).`, ids: [a.id] });
      else if (lines.length < 2) issues.push({ rule: 3, level: "error", message: "Put the description and the (transport) on separate lines.", ids: [a.id] });
    }
    const start = a.startBinding?.elementId && byId.get(a.startBinding.elementId);
    const end = a.endBinding?.elementId && byId.get(a.endBinding.elementId);
    if (!start || !end) issues.push({ rule: 8, level: "error", message: `Flow ${label ? `“${label.split("\n")[0]}” ` : ""}is not attached at ${!start && !end ? "either end" : !start ? "its start" : "its end"}. Drag the endpoint onto the block until it snaps.`, ids: [a.id] });
  }

  // 5. Solid vs dotted: dashed is neither.
  for (const a of arrows) {
    if (a.strokeStyle === "dashed") issues.push({ rule: 5, level: "error", message: "Dashed is not a styleguide stroke. Use solid (confirmed) or dotted (unconfirmed).", ids: [a.id] });
  }
  for (const b of blocks) {
    if (b.strokeStyle === "dashed") issues.push({ rule: 5, level: "error", message: "Dashed is not a styleguide stroke. Use solid (confirmed) or dotted (unconfirmed).", ids: [b.id] });
  }

  // 6. Flow colours reflect state.
  for (const a of arrows) {
    if (!FLOW_STROKES.has(lower(a.strokeColor))) issues.push({ rule: 6, level: "error", message: `Line colour ${a.strokeColor} is not a flow state (default = working, orange = in development, green = tested).`, ids: [a.id] });
  }
  if (arrows.length >= 3 && new Set(arrows.map((a) => lower(a.strokeColor))).size === 1 && new Set(arrows.map((a) => a.strokeStyle)).size === 1) {
    issues.push({ rule: 6, level: "info", message: "Every flow has the same colour and stroke. Check that each one reflects its real state.", ids: arrows.map((a) => a.id) });
  }

  // General styling: 1px strokes, hand-drawn font.
  const thick = [...blocks, ...arrows].filter((e) => (e.strokeWidth ?? 1) !== 1);
  if (thick.length) issues.push({ rule: 2, level: "warn", message: `${thick.length} shape${thick.length > 1 ? "s use" : " uses"} a thicker stroke. The styleguide uses 1px (thin).`, ids: thick.map((e) => e.id) });
  const fonts = els.filter((e) => e.type === "text" && e.fontFamily !== undefined && !HAND_DRAWN_FONTS.has(e.fontFamily));
  if (fonts.length) issues.push({ rule: 2, level: "warn", message: "Use the hand-drawn font for all text.", ids: fonts.map((e) => e.id) });

  // 4, 5, 9, 10. Reminders a scene cannot verify.
  if (arrows.length) {
    const dotted = arrows.filter((a) => a.strokeStyle === "dotted").length;
    issues.push({ rule: 4, level: "info", message: "Check arrow labels match the flow names (and numbers) in the Notion request.", ids: [] });
    issues.push({ rule: 5, level: "info", message: `${arrows.length - dotted} confirmed (solid) and ${dotted} unconfirmed (dotted) flows. Check each against its IR.`, ids: [] });
  }
  if (title !== undefined && /^untitled/i.test(title.trim())) issues.push({ rule: 9, level: "warn", message: "Name the drawing after the customer.", ids: [] });
  issues.push({ rule: 10, level: "info", message: "Export for customers in light theme (use Customer export).", ids: [] });

  const order = { error: 0, warn: 1, info: 2 } as const;
  return issues.sort((a, b) => order[a.level] - order[b.level] || a.rule - b.rule);
}
