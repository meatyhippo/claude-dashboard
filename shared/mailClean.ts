/**
 * Mail as a person wants to read it: the message itself, and the links worth
 * clicking. Inline image placeholders, quoted earlier replies, forwarded headers,
 * signatures' social links, legal disclaimers and tracking wrappers are taken out.
 * The original stays available behind "Show original".
 */

export type MailLink = { url: string; label: string; kind: "qargo" | "notion" | "front" | "doc" | "web" };

/** Where the quoted history of a reply starts, in the languages this mail arrives in. */
const QUOTE_START = [
  /^on .{3,120} wrote:\s*$/i,
  /^op .{3,120} (schreef|geschreven)\s*.*:\s*$/i,
  /^le .{3,120} a écrit\s*:\s*$/i,
  /^am .{3,120} schrieb .*:\s*$/i,
  /^-{2,}\s*(original message|oorspronkelijk bericht|message d'origine|ursprüngliche nachricht|forwarded message)\s*-{2,}/i,
  /^_{8,}\s*$/,
  /^(from|van|de|von)\s*:\s.+$/i, // the start of an Outlook header block…
];
/** …which only counts when a Sent/To line follows within a few lines. */
const HEADER_FOLLOW = /^(sent|verzonden|envoyé|gesendet|date|datum|to|aan|à|an)\s*:/i;

/** A sign-off: the message ends here; keep this line and a name line, drop the signature block under it. */
const SIGN_OFF = /^(kind regards|best regards|warm regards|regards|best|cheers|thanks( again)?|thank you|many thanks|with kind regards|met vriendelijke groet(en)?|vriendelijke groet(en)?|mvg|groet(en|jes)?|cordialement|bien (à vous|cordialement)|salutations|mit freundlichen grüßen|viele grüße|beste grüße|lg|mfg|saludos|un saluto|cordiali saluti)[,.!]*$/i;

/** Lines that are only signature furniture: phone, address, web, job title separators. */
const FURNITURE = [
  /^([tmfpe]|tel|phone|mobile|mob|gsm|fax|direct|office)\.?\s*[:.]?\s*[+(]?\d[\d\s().-]{6,}$/i,
  /^[+(]?\d[\d\s().\/-]{8,}$/,
  /^(www\.|https?:\/\/)\S+$/i,
  /^[\w.+-]+@[\w-]+\.[\w.-]+$/,
  /^[-_=*~•|·.]{3,}$/,
  /^\d{4}\s?[a-z]{2}\s+\S+/i, // Dutch postcode + city
  /^[a-z .-]+\s\d{1,4}[a-z]?,?\s*\d{4,5}\s?[a-z]{0,2}\b/i, // street + number + postcode
  /^(vat|btw|kvk|tva|ust-?id|iban|bic|coc)\b/i,
  /^[{}@;]|^\.[a-z-]+\s*\{|^(font|color|margin|mso-)[a-z-]*\s*:/i, // CSS remnants
];

const DROP_LINE = [
  /^you don.t often get email from/i,
  /^learn why this is important/i,
  /^(get outlook for (ios|android)|download outlook for)/i,
  /^(this message was sent|sent with|sent via|sent using) /i,
  /^\[(cid|image|afbeelding|logo)[^\]]*\]$/i, // [cid:image001.png@…], [image: logo]
  /^<?image\d+\.(png|jpe?g|gif)>?$/i,
  /^\s*(caution|external email|this email originated from outside)/i,
  /^\s*(sent from my (iphone|ipad|android|mobile)|verzonden vanaf mijn|envoyé de mon)/i,
];

/** The start of a legal disclaimer: everything from here on goes. */
const DISCLAIMER = /^(disclaimer|confidentiality notice|this (e-?mail|message) (and any attachments )?(is|are|may be) (confidential|intended)|de informatie verzonden met dit e-?mailbericht|dit e-?mailbericht is uitsluitend bestemd|ce message (et ses pièces jointes )?est confidentiel|the information (contained )?in this (e-?mail|message))/i;

const SOCIAL = /(linkedin\.com|facebook\.com|twitter\.com|x\.com\/|instagram\.com|youtube\.com|tiktok\.com|wa\.me)/i;
const NOISE_URL = /\.(png|jpe?g|gif|svg|webp)(\?|$)|^mailto:|^tel:|unsubscribe|aka\.ms\/|track|click\.|emltrk|list-manage/i;

/** Outlook Safe Links and similar wrappers: the real address is in a parameter. */
function unwrap(url: string): string {
  try {
    const u = new URL(url);
    if (/safelinks\.protection\.outlook\.com$/i.test(u.hostname)) return u.searchParams.get("url") ?? url;
    if (/urldefense\.(com|proofpoint\.com)$/i.test(u.hostname)) return u.searchParams.get("u")?.replace(/-/g, "%").replace(/_/g, "/") ?? url;
  } catch {
    /* not a URL */
  }
  return url;
}

function linkOf(raw: string): MailLink | null {
  const url = unwrap(raw.replace(/[).,;>\]]+$/, ""));
  if (NOISE_URL.test(url) || SOCIAL.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "");
  if (/(^|\.)qargo\.com$/.test(host)) {
    const parts = u.pathname.split("/").filter(Boolean);
    return { url, label: host.startsWith("app.") && parts[0] ? `Qargo · ${parts[0]}${parts[1] ? ` / ${parts[1]}` : ""}` : `${host}${u.pathname.length > 1 ? u.pathname.slice(0, 30) : ""}`, kind: "qargo" };
  }
  if (/notion\.(so|com|site)$/.test(host)) return { url, label: "Notion page", kind: "notion" };
  if (/frontapp\.com$/.test(host)) return { url, label: "Front conversation", kind: "front" };
  if (/(docs\.google|drive\.google|sharepoint\.com|onedrive|dropbox\.com|box\.com|wetransfer\.com)/.test(host)) return { url, label: host.split(".")[0] === "docs" ? "Google Doc" : host, kind: "doc" };
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/$/, "").slice(0, 32) : "";
  return { url, label: `${host}${path}`, kind: "web" };
}

/** Style sheets that leak into mail text: "#fae_… p.x, li.x {margin:0cm; font-size:12pt;}", @font-face, @page, HTML comments. */
export function stripCss(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/@(font-face|page|media|import)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gi, "")
    .replace(/(^|\n|\})[^{}\n]{0,600}\{[^{}]*:[^{}]*\}/g, (m, lead) => (lead === "\n" ? "\n" : ""))
    .replace(/^\s*[#.][\w\\-]+[^\n]*\{[^\n]*$/gm, "");
}

export function cleanMail(raw: string): { text: string; links: MailLink[]; trimmed: boolean } {
  const css = stripCss(raw);
  const lines = css.replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n");
  const out: string[] = [];
  let trimmed = css.length !== raw.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    // Quoted history: stop at its first line.
    if (line.startsWith(">")) {
      trimmed = true;
      continue;
    }
    const quote = QUOTE_START.findIndex((re) => re.test(line));
    if (quote >= 0) {
      const isHeader = quote === QUOTE_START.length - 1;
      if (!isHeader || lines.slice(i + 1, i + 5).some((l) => HEADER_FOLLOW.test(l.trim()))) {
        trimmed = true;
        break;
      }
    }
    if (DISCLAIMER.test(line)) {
      trimmed = true;
      break;
    }
    if (SIGN_OFF.test(line)) {
      // Keep the sign-off and the next non-empty line (the name), drop the block below.
      out.push(lines[i]!.trim());
      const name = lines.slice(i + 1).map((l) => l.trim()).find((l) => l.length > 0);
      if (name && name.length <= 60 && !/[@:+\d]{3,}/.test(name)) out.push(name);
      trimmed = true;
      break;
    }
    if (FURNITURE.some((re) => re.test(line))) {
      trimmed = true;
      continue;
    }
    if (DROP_LINE.some((re) => re.test(line))) {
      trimmed = true;
      continue;
    }
    out.push(lines[i]!.replace(/\s+$/, ""));
  }
  let text = out.join("\n");
  const urls = [...new Set(text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [])];
  const links: MailLink[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    const l = linkOf(u);
    if (l && !seen.has(l.url)) {
      seen.add(l.url);
      links.push(l);
    }
  }
  // Links read badly in running text: a short label where a chip below carries it, nothing where it is noise (social, tracking, images).
  text = text.replace(/<?https?:\/\/[^\s<>"')\]]+>?/g, (m) => {
    const tail = m.match(/[.,;:!?]+$/)?.[0] ?? "";
    const l = linkOf(m.slice(0, m.length - tail.length).replace(/^<|>$/g, ""));
    if (!l) trimmed = true;
    return (l ? `[${l.label}]` : "") + tail;
  });
  // Separators left behind by removed links in a signature line ("Lead |  | ").
  text = text.replace(/(\s*\|\s*)+$/gm, "").replace(/\|\s*\|/g, "|");
  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, links, trimmed };
}
