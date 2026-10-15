export interface SvgMetadata {
  width: number;
  height: number;
  viewBox: string;
}

const forbidden = /<\s*(?:script|foreignObject|iframe|object|embed|image|audio|video|use|animate|animateTransform|set|style|link|feImage)\b|\bon[a-z]+\s*=|<!DOCTYPE|<!ENTITY|javascript\s*:|data\s*:|https?:\/\/|@import|expression\s*\(/i;
const supportedElements = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath"]);

export function validateSvg(source: string): { svg: string; bytes: number; metadata: SvgMetadata } {
  const svg = source.trim().replace(/^```(?:svg|xml)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!svg || Buffer.byteLength(svg, "utf8") > 1_000_000) throw new Error("SVG is empty or exceeds the 1 MB source limit.");
  const withoutNamespace = svg.replace(/xmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/i, "xmlns=\"svg-namespace\"");
  if (forbidden.test(withoutNamespace)) throw new Error("SVG contains a forbidden active, external, or embedded element.");
  if (!/^<svg\b/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) throw new Error("Output must be one complete SVG document.");
  if (!/\bxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(svg)) throw new Error("SVG must declare the standard SVG namespace.");
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i.test(svg)) throw new Error("SVG contains an unsupported XML entity.");
  if (/\b(?:href|xlink:href)\s*=/.test(svg) && /\b(?:href|xlink:href)\s*=\s*["'](?!#)/i.test(svg)) throw new Error("SVG external references are forbidden.");
  for (const match of svg.matchAll(/<\/?([A-Za-z][\w:-]*)\b/g)) {
    const tag = match[1];
    if (!supportedElements.has(tag)) throw new Error(`SVG element is not allowed: ${tag}`);
  }
  const stack: string[] = [];
  for (const token of svg.matchAll(/<\/?([A-Za-z][\w:-]*)\b[^>]*>/g)) {
    const tag = token[1];
    const markup = token[0];
    if (markup.startsWith("</")) {
      if (stack.pop() !== tag) throw new Error("SVG element nesting is malformed.");
    } else if (!/\/\s*>$/.test(markup)) stack.push(tag);
  }
  if (stack.length) throw new Error("SVG element nesting is incomplete.");
  const viewBox = /\bviewBox\s*=\s*["']\s*([\d.+-]+[\s,]+[\d.+-]+[\s,]+[\d.+-]+[\s,]+[\d.+-]+)\s*["']/i.exec(svg)?.[1];
  if (!viewBox) throw new Error("SVG must include a numeric viewBox.");
  const viewValues = viewBox.trim().split(/[\s,]+/).map(Number);
  if (viewValues.some((value) => !Number.isFinite(value)) || viewValues[2] <= 0 || viewValues[3] <= 0) throw new Error("SVG viewBox dimensions are invalid.");
  const width = readDimension(svg, "width") ?? viewValues[2];
  const height = readDimension(svg, "height") ?? viewValues[3];
  if (width > 8192 || height > 8192) throw new Error("SVG dimensions exceed 8192 pixels.");
  // Allow only local fragment references in paint and clip attributes.
  for (const match of svg.matchAll(/url\(([^)]*)\)/gi)) if (!/^\s*#[\w.-]+\s*$/.test(match[1])) throw new Error("SVG may only reference local gradient or clip IDs.");
  return { svg, bytes: Buffer.byteLength(svg, "utf8"), metadata: { width, height, viewBox: viewValues.join(" ") } };
}

function readDimension(svg: string, name: "width" | "height"): number | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([\\d.]+)(?:px)?["']`, "i").exec(svg);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`SVG ${name} is invalid.`);
  return value;
}
