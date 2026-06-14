import { Hono } from 'hono';
import { loadRequirements } from '../lib/data.js';
import type { RequirementKind, RequirementSet } from '../types.js';

// GET /api/requirements/:admissionYear/:variantKey
//   → { graduation: RequirementSet; research_start: RequirementSet; fallback?: true }
// 該当する admissionYear が無い場合は最も近い年度で代替し fallback: true を付ける。
export const requirementsRoutes = new Hono();

function pickNearest(
  candidates: RequirementSet[],
  kind: RequirementKind,
  admissionYear: number,
): { set: RequirementSet; fallback: boolean } | null {
  const ofKind = candidates.filter((r) => r.kind === kind);
  if (ofKind.length === 0) return null;
  const exact = ofKind.find((r) => r.admissionYear === admissionYear);
  if (exact) return { set: exact, fallback: false };
  let best = ofKind[0];
  for (const r of ofKind) {
    if (Math.abs(r.admissionYear - admissionYear) < Math.abs(best.admissionYear - admissionYear)) {
      best = r;
    }
  }
  return { set: best, fallback: true };
}

requirementsRoutes.get('/:admissionYear/:variantKey', (c) => {
  const admissionYear = Number(c.req.param('admissionYear'));
  const variantKey = c.req.param('variantKey');
  if (!Number.isInteger(admissionYear)) {
    return c.json({ error: 'invalid_admission_year' }, 400);
  }

  const candidates = loadRequirements().filter((r) => r.variantKey === variantKey);
  if (candidates.length === 0) return c.json({ error: 'not_found' }, 404);

  const graduation = pickNearest(candidates, 'graduation', admissionYear);
  const researchStart = pickNearest(candidates, 'research_start', admissionYear);
  if (!graduation || !researchStart) return c.json({ error: 'not_found' }, 404);

  const fallback = graduation.fallback || researchStart.fallback;
  return c.json({
    graduation: graduation.set,
    research_start: researchStart.set,
    ...(fallback ? { fallback: true as const } : {}),
  });
});
