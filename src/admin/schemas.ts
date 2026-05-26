import { z } from 'zod';

// HH:MM-HH:MM 24h
const TimeRangeRegex = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const TimeRange = z.string().regex(TimeRangeRegex, 'use HH:MM-HH:MM 24h');

export const WorkingHoursSchema = z
  .object({
    mon: z.array(TimeRange).optional(),
    tue: z.array(TimeRange).optional(),
    wed: z.array(TimeRange).optional(),
    thu: z.array(TimeRange).optional(),
    fri: z.array(TimeRange).optional(),
    sat: z.array(TimeRange).optional(),
    sun: z.array(TimeRange).optional(),
    timezone: z.string().min(1),
  })
  .refine(
    (h) => !!(h.mon || h.tue || h.wed || h.thu || h.fri || h.sat || h.sun),
    'pelo menos 1 dia da semana com janela'
  );

export const ProjectSlugParams = z.object({
  agent: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'use [a-z0-9-]+'),
});

export const ProjectCreateBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'use [a-z0-9-]+'),
  display_name: z.string().min(1).max(200),
});

export const ProjectPatchBody = z
  .object({
    display_name: z.string().min(1).max(200).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'pelo menos 1 campo obrigatório');

export const GoalUpsertBody = z.object({
  goal_type: z.literal('scheduling'), // MVP: só este
  enabled: z.boolean().default(true),
  config: z
    .object({
      selection_strategy: z.enum(['single', 'round_robin', 'by_specialty']).default('single'),
    })
    .strict()
    .default({ selection_strategy: 'single' }),
});

export const AgendaCreateBody = z.object({
  person_name: z.string().min(1).max(200),
  person_email: z.string().email(),
  display_label: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  working_hours: WorkingHoursSchema,
  meeting_duration_min: z.number().int().min(5).max(480).default(30),
  min_advance_hours: z.number().int().min(0).max(168).default(4),
  max_advance_business_days: z.number().int().min(1).max(60).default(10),
});

export const AgendaPatchBody = z
  .object({
    person_name: z.string().min(1).max(200).optional(),
    person_email: z.string().email().optional(),
    display_label: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    working_hours: WorkingHoursSchema.optional(),
    meeting_duration_min: z.number().int().min(5).max(480).optional(),
    min_advance_hours: z.number().int().min(0).max(168).optional(),
    max_advance_business_days: z.number().int().min(1).max(60).optional(),
    active: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'pelo menos 1 campo obrigatório');
