// Extract recognised commands from a post body. A single post may contain
// multiple commands on separate lines. Returns an array of command objects.
import { parseCell } from './game.js';

const COMMAND_RE = /(^|[\s>])!(join|leave|goto|move|shot|shoot|fire|color)\b([^\n\r]*)/gi;

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
    if (t.includes('red') || t.includes('кр')) team = 'red';
    else if (t.includes('blue') || t.includes('син')) team = 'blue';
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
  if (verb === 'color') {
    const c = rest.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(c)) return { type: 'color', color: '#' + c.toLowerCase() };
    return null;
  }
  return null;
}
