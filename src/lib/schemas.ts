import { z } from 'zod';

// CONVENTIONS §5 の型に対応する zod スキーマ(API 入力検証用)

export const daySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri']);

export const periodSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const semesterSchema = z.enum(['first', 'second']);

export const quarterSchema = z.enum(['1Q', '2Q', '3Q', '4Q']);

export const subjectCategorySchema = z.enum([
  'english',
  'liberal_foundation',
  'liberal_practical',
  'liberal_senior',
  'intro_required',
  'intro_elective_required',
  'intro_elective',
  'basic_required',
  'basic_elective_required',
  'basic_elective',
  'program_required',
  'program_elective_required',
  'program_elective',
  'program_elective_A',
  'program_elective_B',
  'program_elective_C',
  'program_elective_ABC',
  'program_elective_D',
  'program_elective_other_course',
  'graduation_research',
  'other_program',
  'out_of_scope',
  'not_allowed',
]);

export const customCourseSchema = z.object({
  name: z.string().min(1).max(200),
  instructors: z.array(z.string().max(100)).max(50).optional(),
  credits: z.number().min(0).max(50),
  category: subjectCategorySchema,
  room: z.string().max(100).optional(),
  memo: z.string().max(2000).optional(),
});

export const timetableEntrySchema = z.object({
  id: z.string().min(1).max(100),
  year: z.number().int().min(2000).max(2100),
  term: semesterSchema,
  quarters: z.array(quarterSchema).max(4).optional(),
  day: daySchema.optional(),
  period: periodSchema.optional(),
  courseId: z.string().max(100).optional(),
  custom: customCourseSchema.optional(),
  classLabel: z.string().max(100).optional(),
  color: z.string().max(50).optional(),
  excludeFromCredits: z.boolean().optional(),
});

export const sharedTimetableSchema = z.object({
  version: z.literal(1),
  title: z.string().max(200).optional(),
  year: z.number().int().min(2000).max(2100),
  term: semesterSchema,
  entries: z.array(timetableEntrySchema).max(500),
});

export const syncPutBodySchema = z.object({
  entries: z.array(timetableEntrySchema).max(1000),
});

export const webPushSubscriptionSchema = z
  .object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  })
  .passthrough();

export const pushRegisterSchema = z
  .object({
    platform: z.enum(['expo', 'web']),
    token: z.string().min(1).max(500).optional(),
    subscription: webPushSubscriptionSchema.optional(),
    cancellationNotifications: z.boolean(),         // 休講通知
    lectureInfoNotifications: z.boolean().optional(), // 授業関連連絡(省略時は休講と同値)
  })
  .superRefine((v, ctx) => {
    if (v.platform === 'expo' && !v.token) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'token is required for platform "expo"', path: ['token'] });
    }
    if (v.platform === 'web' && !v.subscription) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subscription is required for platform "web"', path: ['subscription'] });
    }
  });

export const pushUnregisterSchema = z
  .object({
    platform: z.enum(['expo', 'web']),
    token: z.string().min(1).max(500).optional(),
    endpoint: z.string().min(1).max(2000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.platform === 'expo' && !v.token) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'token is required for platform "expo"', path: ['token'] });
    }
    if (v.platform === 'web' && !v.endpoint) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'endpoint is required for platform "web"', path: ['endpoint'] });
    }
  });
