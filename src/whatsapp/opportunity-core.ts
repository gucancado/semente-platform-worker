export type OppStatus = 'em_andamento' | 'ganho' | 'perdido';

export type OppQualification =
  | 'indefinido'
  | 'qualificado'
  | 'desqualificado';

export interface OppState {
  status: OppStatus;
  qualification: OppQualification;
  closedAt: string | null;
  title: string | null;
}

export interface OppPatch {
  status?: OppStatus;
  qualification?: OppQualification;
  title?: string | null;
}

export interface OppEvent {
  field: 'status' | 'qualification' | 'title';
  oldValue: string | null;
  newValue: string | null;
}

export interface TransitionResult {
  next: OppState;
  events: OppEvent[];
  closedAtAction: 'set_now' | 'clear' | 'keep';
}

export class OppInvariantError extends Error {
  code: 'desqualificar_ganho' | 'invalid_value';

  constructor(code: 'desqualificar_ganho' | 'invalid_value') {
    super(code);
    this.name = 'OppInvariantError';
    this.code = code;
  }
}

const STATUSES: readonly OppStatus[] = [
  'em_andamento',
  'ganho',
  'perdido',
];

const QUALIFICATIONS: readonly OppQualification[] = [
  'indefinido',
  'qualificado',
  'desqualificado',
];

function validatePatch(patch: OppPatch): void {
  if (
    patch.status !== undefined &&
    !STATUSES.includes(patch.status)
  ) {
    throw new OppInvariantError('invalid_value');
  }

  if (
    patch.qualification !== undefined &&
    !QUALIFICATIONS.includes(patch.qualification)
  ) {
    throw new OppInvariantError('invalid_value');
  }

  if (
    patch.title !== undefined &&
    patch.title !== null &&
    typeof patch.title !== 'string'
  ) {
    throw new OppInvariantError('invalid_value');
  }
}

export function applyOppPatch(
  cur: OppState,
  patch: OppPatch,
): TransitionResult {
  validatePatch(patch);

  if (
    patch.qualification === 'desqualificado' &&
    (cur.status === 'ganho' || patch.status === 'ganho')
  ) {
    throw new OppInvariantError('desqualificar_ganho');
  }

  const nextStatus = patch.status ?? cur.status;
  let nextQualification = patch.qualification ?? cur.qualification;

  if (nextStatus === 'ganho') {
    nextQualification = 'qualificado';
  }

  const next: OppState = {
    status: nextStatus,
    qualification: nextQualification,
    closedAt: cur.closedAt,
    title: patch.title === undefined ? cur.title : patch.title,
  };

  const events: OppEvent[] = [];

  if (next.status !== cur.status) {
    events.push({
      field: 'status',
      oldValue: cur.status,
      newValue: next.status,
    });
  }

  if (next.qualification !== cur.qualification) {
    events.push({
      field: 'qualification',
      oldValue: cur.qualification,
      newValue: next.qualification,
    });
  }

  if (next.title !== cur.title) {
    events.push({
      field: 'title',
      oldValue: cur.title,
      newValue: next.title,
    });
  }

  let closedAtAction: TransitionResult['closedAtAction'] = 'keep';
  if (next.status !== cur.status) {
    closedAtAction =
      next.status === 'em_andamento' ? 'clear' : 'set_now';
  }

  return { next, events, closedAtAction };
}

export function migrationRowFor(
  stage: string,
): {
  status: OppStatus;
  qualification: OppQualification;
  closed: boolean;
} | null {
  switch (stage) {
    case 'cliente':
      return {
        status: 'ganho',
        qualification: 'qualificado',
        closed: true,
      };
    case 'qualificado':
      return {
        status: 'em_andamento',
        qualification: 'qualificado',
        closed: false,
      };
    case 'perdido':
      return {
        status: 'perdido',
        qualification: 'qualificado',
        closed: true,
      };
    default:
      return null;
  }
}

export function normalizeTagName(raw: string): string | null {
  const normalized = raw.trim().replace(/\s+/g, ' ');
  return normalized === '' ? null : normalized;
}
