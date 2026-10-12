// DOM helpers shared by the Market Research and Breaker Bay pages. Values go in as text nodes or textContent, never HTML.

const SVGNS = 'http://www.w3.org/2000/svg';

export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style') setStyle(n, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    n.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return n;
}

// The page's CSP forbids style attributes; the CSSOM is allowed.
export function setStyle(n, css) {
  for (const decl of String(css).split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) n.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
  }
}

export function svg(tag, attrs = {}, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
}

export function debounce(fn, ms) {
  let t = null;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}
