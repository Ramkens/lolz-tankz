// Extract recognised commands from a post body. A single post may contain
// multiple commands on separate lines. Returns an array of command objects.
import { parseCell } from './game.js';

const COMMAND_RE = /(^|[\s>])!(join|leave|goto|move|shot|shoot|fire|color|colour)\b([^\n\r]*)/gi;

const COLOR_NAMES = new Set(['red', 'green', 'blue', 'black', 'beige']);

export function extractCommands(text, gridSize) {
  if (!text) return [];
  const out = [];
  let m;
  COMMAND_RE.lastIndex = 0;
  while ((m = COMMAND_RE.exec(text)) !== null) {
    const verb = m[2].toLowerCase();
    const rest = (m[3] || '').trim();
    const cmd = normalize(verb, rest, gridSize);
    if (cmd) out.push(cmd);
  }
  return out;
}

function normalize(verb, rest, gridSize) {
  if (verb === 'join') {
    let team = null;
    const t = rest.toLowerCase();
    if (/\bred\b|кр\w*/i.test(t)) team = 'red';
    else if (/\bblue\b|син\w*/i.test(t)) team = 'blue';
    return { type: 'join', team };
  }
  if (verb === 'leave') return { type: 'leave' };
  if (verb === 'goto' || verb === 'move') {
    const cell = parseCell(rest.split(/[\s,;]/)[0], gridSize);
    if (!cell) return null;
    return { type: 'goto', col: cell.col, row: cell.row };
  }
  if (verb === 'shot' || verb === 'shoot' || verb === 'fire') {
    const cell = parseCell(rest.split(/[\s,;]/)[0], gridSize);
    if (!cell) return null;
    return { type: 'shot', col: cell.col, row: cell.row };
  }
  if (verb === 'color' || verb === 'colour') {
    const c = rest.trim().toLowerCase().replace(/^#/, '');
    if (COLOR_NAMES.has(c)) return { type: 'color', color: c };
    return null;
  }
  return null;
}
