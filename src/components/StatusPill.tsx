/**
 * Coloured status boxes for Notion statuses and billable statuses, one colour per
 * meaning rather than per value: done, moving, waiting on someone, not started, stopped.
 */
export function statusTone(status: string, billable = false): "done" | "moving" | "waiting" | "todo" | "stopped" | "money" {
  const s = status.toLowerCase();
  if (billable) {
    if (/invoiced|paid/.test(s)) return "done";
    if (/ready to invoice/.test(s)) return "money";
    if (/quoted/.test(s)) return "moving";
    if (/to quote|to estimate|awaiting/.test(s)) return "waiting";
    if (/waived|not applicable|on hold/.test(s)) return "stopped";
    return "todo";
  }
  if (/done|live|completed|closed|production ready|resolved/.test(s)) return "done";
  if (/won.?t|cancel|duplicate|no longer|rejected/.test(s)) return "stopped";
  if (/progress|implementing|development|testing|building|scoping|in review/.test(s)) return "moving";
  if (/awaiting|waiting|blocked|on hold|customer to|external|pending/.test(s)) return "waiting";
  return "todo";
}

export function StatusPill({ status, billable }: { status: string | null | undefined; billable?: boolean }) {
  if (!status) return <span className="sp sp-todo">—</span>;
  return <span className={`sp sp-${statusTone(status, billable)}`}>{status}</span>;
}
