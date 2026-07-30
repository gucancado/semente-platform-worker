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

// ---------------------------------------------------------------------------
// Kernel v3 — is_qualified (boolean | null), loss_reason, cascatas e board.
// Convive com o v2 acima (migrationRowFor/applyOppPatch seguem usados pelo CLI
// de migração antiga e pelas rotas atuais até a Task 8). Reusa OppInvariantError.
// ---------------------------------------------------------------------------

export interface OppStateV3 {
  status: OppStatus;
  isQualified: boolean | null;
  closedAt: string | null;
  title: string | null;
  lossReason: string | null;
}

export interface OppPatchV3 {
  status?: OppStatus;
  isQualified?: boolean | null;
  title?: string | null;
  lossReason?: string | null;
}

export interface OppEventV3 {
  field: 'status' | 'qualification' | 'title' | 'loss_reason';
  oldValue: string | null;
  newValue: string | null;
}

export interface TransitionResultV3 {
  next: OppStateV3;
  events: OppEventV3[];
  closedAtAction: 'set_now' | 'clear' | 'keep';
  // §4.1-4.2: ganho ou is_qualified TRUE/FALSE ⇒ is_lead=TRUE (NULL não cascateia)
  threadLeadAction: 'set_true' | 'keep';
}

export type BoardColumn =
  | 'novas_conversas'
  | 'interessados'
  | 'negociacoes'
  | 'ganhos'
  | 'perdas';

export function qualificationLabel(
  q: boolean | null,
): 'indefinido' | 'qualificado' | 'desqualificado' {
  if (q === null) return 'indefinido';
  return q ? 'qualificado' : 'desqualificado';
}

function validatePatchV3(patch: OppPatchV3): void {
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) {
    throw new OppInvariantError('invalid_value');
  }

  if (
    patch.isQualified !== undefined &&
    patch.isQualified !== null &&
    typeof patch.isQualified !== 'boolean'
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

  if (
    patch.lossReason !== undefined &&
    patch.lossReason !== null &&
    typeof patch.lossReason !== 'string'
  ) {
    throw new OppInvariantError('invalid_value');
  }
}

export function applyOppPatchV3(
  cur: OppStateV3,
  patch: OppPatchV3,
): TransitionResultV3 {
  // 1. Valores válidos.
  validatePatchV3(patch);

  // 2. Contraditório (§4.4): desqualificar só fecha como perdido.
  if (
    patch.isQualified === false &&
    patch.status !== undefined &&
    patch.status !== 'perdido'
  ) {
    throw new OppInvariantError('invalid_value');
  }

  // 3. Não se pode desqualificar um ganho.
  if (
    patch.isQualified === false &&
    (cur.status === 'ganho' || patch.status === 'ganho')
  ) {
    throw new OppInvariantError('desqualificar_ganho');
  }

  // 4. Status resultante (§4.3: desqualificar sem status vira perdido).
  let nextStatus: OppStatus = patch.status ?? cur.status;
  if (patch.isQualified === false && patch.status === undefined) {
    nextStatus = 'perdido';
  }

  // 5. Qualificação resultante (§4.1: ganho ⇒ qualificado).
  let nextQ: boolean | null =
    patch.isQualified !== undefined ? patch.isQualified : cur.isQualified;
  if (nextStatus === 'ganho') {
    nextQ = true;
  }

  // 6. Reabertura (§4.5): perdido→em_andamento limpa a desqualificação herdada.
  const reabriu = cur.status === 'perdido' && nextStatus === 'em_andamento';
  if (reabriu && nextQ === false && patch.isQualified === undefined) {
    nextQ = null;
  }

  // 7. loss_reason (§4.6 CHECK: só existe em perdido).
  if (patch.lossReason !== undefined && nextStatus !== 'perdido') {
    throw new OppInvariantError('invalid_value');
  }
  let nextLoss: string | null;
  if (nextStatus !== 'perdido') {
    nextLoss = null;
  } else {
    nextLoss =
      patch.lossReason !== undefined
        ? patch.lossReason
        : reabriu
          ? null
          : cur.lossReason;
  }

  const next: OppStateV3 = {
    status: nextStatus,
    isQualified: nextQ,
    closedAt: cur.closedAt,
    title: patch.title === undefined ? cur.title : patch.title,
    lossReason: nextLoss,
  };

  // 8. Eventos + ações derivadas.
  const events: OppEventV3[] = [];

  if (next.status !== cur.status) {
    events.push({
      field: 'status',
      oldValue: cur.status,
      newValue: next.status,
    });
  }

  if (next.isQualified !== cur.isQualified) {
    events.push({
      field: 'qualification',
      oldValue: qualificationLabel(cur.isQualified),
      newValue: qualificationLabel(next.isQualified),
    });
  }

  if (next.title !== cur.title) {
    events.push({
      field: 'title',
      oldValue: cur.title,
      newValue: next.title,
    });
  }

  if (next.lossReason !== cur.lossReason) {
    events.push({
      field: 'loss_reason',
      oldValue: cur.lossReason,
      newValue: next.lossReason,
    });
  }

  let closedAtAction: TransitionResultV3['closedAtAction'] = 'keep';
  if (next.status !== cur.status) {
    closedAtAction =
      next.status === 'em_andamento' ? 'clear' : 'set_now';
  }

  const threadLeadAction: TransitionResultV3['threadLeadAction'] =
    nextStatus === 'ganho' ||
    patch.isQualified === true ||
    patch.isQualified === false
      ? 'set_true'
      : 'keep';

  return { next, events, closedAtAction, threadLeadAction };
}

export function boardColumn(
  isLead: boolean | null,
  o: { status: OppStatus; isQualified: boolean | null; lossReason: string | null },
): BoardColumn | null {
  if (isLead === false) return null;
  if (o.status === 'ganho') return 'ganhos';
  if (o.status === 'perdido') {
    return o.lossReason === 'nao_lead' ? null : 'perdas';
  }
  // em_andamento
  if (isLead === null) return 'novas_conversas';
  if (isLead === true && o.isQualified === null) return 'interessados';
  if (isLead === true && o.isQualified === true) return 'negociacoes';
  // isQualified === false em em_andamento é inalcançável (invariante §4.4);
  // fora do board por segurança.
  return null;
}
