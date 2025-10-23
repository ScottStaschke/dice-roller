import { z } from 'zod';
import { createMcpHandler } from 'mcp-handler';

type DieRoll = { value: number };
type DiceTerm = {
  count: number;
  sides: number;
  keep?: { kind: 'kh' | 'kl'; n: number };
  drop?: { kind: 'dh' | 'dl'; n: number };
};

type ParsedExpression = {
  terms: (DiceTerm | { modifier: number })[];
  advantage?: boolean;
  disadvantage?: boolean;
};

function rollOnce(sides: number): number {
  return 1 + Math.floor(Math.random() * sides);
}

function parseNotation(notation: string): ParsedExpression {
  const tokens = notation.trim().toLowerCase().split(/\s+/);
  let adv = false, dis = false;
  const expr: ParsedExpression = { terms: [] };

  while (tokens.length) {
    const last = tokens[tokens.length - 1];
    if (last === 'adv' || last === 'advantage') { adv = true; tokens.pop(); }
    else if (last === 'dis' || last === 'disadvantage') { dis = true; tokens.pop(); }
    else break;
  }

  const joined = tokens.join('');
  const parts = joined.replace(/^\+?/, '+').split(/(?=[+-])/g).filter(Boolean);
  const termRe = /^(?<sign>[+-])(?:(?<count>\d*)d(?<sides>\d+)(?:(?<kd>(kh|kl|dh|dl))(?<n>\d+))?|(?<mod>\d+))$/i;

  for (const part of parts) {
    const m = part.match(termRe);
    if (!m || !m.groups) throw new Error(`Invalid dice part: ${part}`);
    const sign = m.groups.sign === '-' ? -1 : 1;
    if (m.groups.mod) {
      expr.terms.push({ modifier: sign * parseInt(m.groups.mod, 10) });
      continue;
    }
    const count = m.groups.count ? parseInt(m.groups.count, 10) : 1;
    const sides = parseInt(m.groups.sides!, 10);
    if (sign === -1) throw new Error(`Negative dice pools not supported: ${part}`);
    const kd = m.groups.kd as 'kh'|'kl'|'dh'|'dl'|undefined;
    const n  = m.groups.n ? parseInt(m.groups.n, 10) : undefined;
    const term: DiceTerm = { count: count || 1, sides };
    if (kd && n) {
      if (kd === 'kh' || kd === 'kl') term.keep = { kind: kd, n };
      else term.drop = { kind: kd as 'dh'|'dl', n };
    }
    expr.terms.push(term);
  }
  if (adv && dis) throw new Error('Cannot have both advantage and disadvantage.');
  if (adv) expr.advantage = true;
  if (dis) expr.disadvantage = true;
  return expr;
}

function rollTerm(term: DiceTerm): { rolls: DieRoll[]; used: number[]; subtotal: number } {
  const rolls: DieRoll[] = Array.from({ length: term.count }, () => ({ value: rollOnce(term.sides) }));
  let indices = rolls.map((_, i) => i);
  const sortedIdx = [...indices].sort((a, b) => rolls[b].value - rolls[a].value);
  if (term.keep) {
    if (term.keep.kind === 'kh') indices = sortedIdx.slice(0, term.keep.n);
    else indices = sortedIdx.slice(-term.keep.n).sort((a, b) => a - b);
  }
  if (term.drop) {
    const toDrop = term.drop.kind === 'dh' ? sortedIdx.slice(0, term.drop.n) : sortedIdx.slice(-term.drop.n);
    const set = new Set(toDrop);
    indices = indices.filter(i => !set.has(i));
  }
  const used = indices;
  const subtotal = used.reduce((acc, i) => acc + rolls[i].value, 0);
  return { rolls, used, subtotal };
}

function applyAdvantage(base: number, sides: number, adv?: boolean, dis?: boolean): { value: number; detail?: string } {
  if (sides !== 20 || (!adv && !dis)) return { value: base };
  const a = rollOnce(20);
  const b = rollOnce(20);
  if (adv) return { value: Math.max(a, b), detail: `adv(${a}, ${b})` };
  return { value: Math.min(a, b), detail: `dis(${a}, ${b})` };
}

const InputSchema = z.object({
  notation: z.string().min(1).describe("Dice expression, e.g. '1d20+5 adv', '4d6kh3', '2d6+1d4+3'.")
});

const handler = createMcpHandler(
  (server) => {
    // mcp-handler v1 signature: name, paramsShape, annotations, callback
    server.tool(
      'roll_dice',
      InputSchema.shape,
      { title: 'D&D dice roller (read-only)', readOnlyHint: true },
      async ({ notation }) => {
        const parsed = parseNotation(notation);
        let total = 0;
        const details: any[] = [];

        for (const t of parsed.terms) {
          if ('modifier' in t) {
            total += t.modifier;
            details.push({ type: 'modifier', value: t.modifier });
            continue;
          }
          if (t.count === 1 && t.sides === 20 && (parsed.advantage || parsed.disadvantage) && !t.keep && !t.drop) {
            const base = rollOnce(20);
            const advd = applyAdvantage(base, 20, parsed.advantage, parsed.disadvantage);
            total += advd.value;
            details.push({ type: 'd20', base, advOrDis: advd.detail ?? null, final: advd.value });
            continue;
          }
          const r = rollTerm(t);
          total += r.subtotal;
          details.push({
            type: 'dice',
            sides: t.sides,
            count: t.count,
            keep: (t as any).keep ?? null,
            drop: (t as any).drop ?? null,
            rolls: r.rolls.map(x => x.value),
            usedIndices: r.used,
            subtotal: r.subtotal
          });
        }

        const text = `Expression: ${notation}\nTotal: ${total}`;
        // mcp-handler v1 content types do not include a 'json' variant; include JSON as text and structuredContent
        return {
          content: [
            { type: 'text', text },
            { type: 'text', text: JSON.stringify({ notation, total, details }) }
          ],
          structuredContent: { notation, total, details }
        };
      }
    );
  },
  { name: 'mcp-dice', version: '2.0.2', description: 'Read-only D&D dice roller MCP server (no write actions).' },
  { basePath: '/api' }
);

export { handler as GET, handler as POST };
