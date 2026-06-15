import { Hono } from 'hono';
import { loadCourses } from '../lib/data.js';
import type { Course, Day } from '../types.js';

// GET /api/courses?year=&q=&day=&period=&intensive=&grade=&term= → Course[]
// GET /api/courses/years → { years: number[] } (講義データが存在する年度一覧)
// GET /api/courses/:id → Course (404 あり)
export const coursesRoutes = new Hono();

const DAYS: readonly Day[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

/** 日本の年度 (4月始まり) */
function currentAcademicYear(d = new Date()): number {
  return d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1;
}

/** 講義データが存在する年度。env COURSE_DATA_YEARS (カンマ区切り) があればそれ、無ければ現年度。 */
function courseDataYears(): number[] {
  const env = process.env.COURSE_DATA_YEARS;
  if (env) {
    const years = env
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));
    if (years.length > 0) return years;
  }
  return [currentAcademicYear()];
}

function parseBoolean(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const lower = v.toLowerCase();
  if (lower === '1' || lower === 'true') return true;
  if (lower === '0' || lower === 'false') return false;
  return undefined;
}

coursesRoutes.get('/', (c) => {
  let courses: Course[] = loadCourses();

  // year は categoryByProgram のキー存在を問わず単に無視する (CONVENTIONS §12)
  void c.req.query('year');

  const q = c.req.query('q');
  if (q && q.trim().length > 0) {
    const needle = q.trim().toLowerCase();
    courses = courses.filter(
      (course) =>
        course.name.toLowerCase().includes(needle) ||
        course.subjectNumber.toLowerCase().includes(needle) ||
        course.instructors.some((i) => i.toLowerCase().includes(needle)),
    );
  }

  const day = c.req.query('day');
  if (day && (DAYS as readonly string[]).includes(day)) {
    courses = courses.filter((course) => course.slots.some((s) => s.day === day));
  }

  const periodRaw = c.req.query('period');
  if (periodRaw !== undefined) {
    const period = Number(periodRaw);
    if (Number.isInteger(period) && period >= 1 && period <= 5) {
      courses = courses.filter((course) => course.slots.some((s) => s.period === period));
    }
  }

  const intensive = parseBoolean(c.req.query('intensive'));
  if (intensive !== undefined) {
    courses = courses.filter((course) => course.intensive === intensive);
  }

  const gradeRaw = c.req.query('grade');
  if (gradeRaw !== undefined) {
    const grade = Number(gradeRaw);
    if (Number.isInteger(grade)) {
      courses = courses.filter((course) => course.targetGrade <= grade);
    }
  }

  const term = c.req.query('term');
  if (term) {
    courses = courses.filter((course) => course.term === term || course.term === 'full_year');
  }

  return c.json(courses);
});

coursesRoutes.get('/years', (c) => {
  return c.json({ years: courseDataYears() });
});

coursesRoutes.get('/:id', (c) => {
  const id = c.req.param('id');
  const course = loadCourses().find((course) => course.id === id);
  if (!course) return c.json({ error: 'not_found' }, 404);
  return c.json(course);
});
