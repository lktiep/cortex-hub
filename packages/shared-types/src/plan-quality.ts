// ============================================================
// Plan Quality Loop — Pre-Execution Validation
// Score plans against 8 criteria before execution starts.
// Threshold: >= 8.0/10.0 to proceed. Max 3 iterations.
// Inspired by Forgewright quality-gate.md + GSD-2 planning.
// ============================================================

/** Individual criterion score (0-10) */
export type PlanCriterion = {
  name: string
  score: number // 0-10
  weight: number // relative importance
  feedback: string // specific improvement suggestion
}

/** Plan quality assessment result */
export type PlanQualityResult = {
  criteria: PlanCriterion[]
  totalScore: number // weighted average, 0-10
  passed: boolean // >= threshold
  iteration: number // which iteration this is (1-3)
  maxIterations: number // always 3
  canRetry: boolean // iteration < maxIterations && !passed
  summary: string
  improvements: string[] // top areas to improve
}

/** Plan input for quality assessment */
export type PlanInput = {
  /** The plan text / description */
  plan: string
  /** Original user request. Empty when unknown: completeness is then judged on the plan alone. */
  request: string
  /** Iteration number (1-based) */
  iteration?: number
  /** Custom threshold (default 8.0) */
  threshold?: number
  /** Context: what type of plan is this? */
  planType?: 'feature' | 'bugfix' | 'refactor' | 'architecture' | 'migration' | 'general'
}

const DEFAULT_THRESHOLD = 8.0
const MAX_ITERATIONS = 3

// ── 8 Quality Criteria ──

/**
 * Assess plan quality against 8 criteria.
 * Pure heuristic analysis — no LLM calls.
 */
export function assessPlanQuality(input: PlanInput): PlanQualityResult {
  const { plan, request, iteration = 1, threshold = DEFAULT_THRESHOLD } = input
  const planLower = plan.toLowerCase()
  const planLines = plan.split('\n').filter(l => l.trim().length > 0)

  const criteria: PlanCriterion[] = [
    assessCompleteness(planLower, request, planLines),
    assessSpecificity(planLower, planLines),
    assessFeasibility(planLower, planLines),
    assessRiskAwareness(planLower, planLines),
    assessScopeBoundary(planLower, request, planLines),
    assessOrdering(planLower, planLines),
    assessTestability(planLower, planLines),
    assessImpactClarity(planLower, planLines),
  ]

  // Weighted average
  const totalWeight = criteria.reduce((sum, c) => sum + c.weight, 0)
  const weightedSum = criteria.reduce((sum, c) => sum + c.score * c.weight, 0)
  const totalScore = Math.round((weightedSum / totalWeight) * 10) / 10

  const passed = totalScore >= threshold
  const canRetry = iteration < MAX_ITERATIONS && !passed

  // Top improvements (criteria scoring < 7)
  const improvements = criteria
    .filter(c => c.score < 7)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map(c => c.feedback)

  const summary = passed
    ? `Plan quality ${totalScore}/10 — APPROVED (iteration ${iteration})`
    : `Plan quality ${totalScore}/10 — NEEDS IMPROVEMENT (iteration ${iteration}/${MAX_ITERATIONS})`

  return {
    criteria,
    totalScore,
    passed,
    iteration,
    maxIterations: MAX_ITERATIONS,
    canRetry,
    summary,
    improvements,
  }
}

// ── Criterion Assessors ──

function assessCompleteness(plan: string, request: string, lines: string[]): PlanCriterion {
  let score = 5

  // Check if plan addresses key aspects of the request
  const requestWords = request.toLowerCase().split(/\s+/).filter(w => w.length > 3)
  const coveredWords = requestWords.filter(w => plan.includes(w))
  const coverage = requestWords.length > 0 ? coveredWords.length / requestWords.length : 0.5
  score = Math.round(coverage * 10)

  // Bonus for having steps/phases/tasks
  if (plan.includes('step') || plan.includes('phase') || plan.includes('task') || /\d+\./g.test(plan)) {
    score = Math.min(10, score + 1)
  }

  // Bonus for having deliverables
  if (plan.includes('output') || plan.includes('deliverable') || plan.includes('result') || plan.includes('artifact')) {
    score = Math.min(10, score + 1)
  }

  // Penalty for very short plans
  if (lines.length < 3) score = Math.min(score, 4)

  score = Math.max(1, Math.min(10, score))

  return {
    name: 'Completeness',
    score,
    weight: 2,
    feedback: score < 7
      ? 'Plan should address all aspects of the request with clear deliverables'
      : 'Plan covers the request requirements adequately',
  }
}

function assessSpecificity(plan: string, lines: string[]): PlanCriterion {
  let score = 5

  // File paths mentioned
  const hasFilePaths = /[\w/]+\.\w{1,4}/.test(plan)
  if (hasFilePaths) score += 2

  // Function/class names mentioned
  const hasSymbols = /[A-Z]\w+(?:Service|Controller|Router|Handler|Component|Model|Type)/.test(plan)
  if (hasSymbols) score += 1

  // Specific commands
  const hasCommands = /`[^`]+`/.test(plan) || plan.includes('pnpm') || plan.includes('npm') || plan.includes('npx')
  if (hasCommands) score += 1

  // Numbered steps with details
  const numberedSteps = lines.filter(l => /^\s*\d+[\.\)]\s/.test(l))
  if (numberedSteps.length >= 3) score += 1

  // Penalty for vague language
  const vagueWords = ['somehow', 'maybe', 'probably', 'might', 'could possibly', 'consider']
  const vagueCount = vagueWords.filter(w => plan.includes(w)).length
  score -= vagueCount

  score = Math.max(1, Math.min(10, score))

  return {
    name: 'Specificity',
    score,
    weight: 2,
    feedback: score < 7
      ? 'Add specific file paths, function names, and concrete steps'
      : 'Plan has adequate specificity',
  }
}

function assessFeasibility(plan: string, lines: string[]): PlanCriterion {
  let score = 7 // default optimistic

  // Red flags that suggest infeasible scope
  const scopeFlags = ['entire codebase', 'all files', 'everything', 'rewrite from scratch', 'complete overhaul']
  const flagCount = scopeFlags.filter(f => plan.includes(f)).length
  score -= flagCount * 2

  // Reasonable step count (3-15 is ideal)
  const stepCount = lines.filter(l => /^\s*[-*\d]/.test(l)).length
  if (stepCount > 20) score -= 2
  if (stepCount >= 3 && stepCount <= 15) score += 1

  // Dependencies acknowledged
  if (plan.includes('depend') || plan.includes('requires') || plan.includes('prerequisite') || plan.includes('before')) {
    score += 1
  }

  score = Math.max(1, Math.min(10, score))

  return {
    name: 'Feasibility',
    score,
    weight: 1.5,
    feedback: score < 7
      ? 'Plan scope may be too ambitious — break into smaller, achievable chunks'
      : 'Plan scope appears feasible',
  }
}

function assessRiskAwareness(plan: string, _lines: string[]): PlanCriterion {
  let score = 4 // start low, earn points

  // Risk/concern mentions
  if (plan.includes('risk') || plan.includes('caution') || plan.includes('careful')) score += 2
  if (plan.includes('rollback') || plan.includes('revert') || plan.includes('backup')) score += 2
  if (plan.includes('breaking change') || plan.includes('backward compat')) score += 1
  if (plan.includes('migration') && plan.includes('data')) score += 1

  // Edge case awareness
  if (plan.includes('edge case') || plan.includes('corner case') || plan.includes('error handling')) score += 1

  // Fallback/alternative mentioned
  if (plan.includes('fallback') || plan.includes('alternative') || plan.includes('if .* fails')) score += 1

  score = Math.max(1, Math.min(10, score))

  return {
    name: 'Risk Awareness',
    score,
    weight: 1,
    feedback: score < 7
      ? 'Identify potential risks, breaking changes, and rollback strategies'
      : 'Plan adequately addresses risks',
  }
}

function assessScopeBoundary(plan: string, request: string, _lines: string[]): PlanCriterion {
  let score = 7

  // Scope creep indicators
  const creepPhrases = [
    'while we\'re at it', 'also refactor', 'also clean up',
    'additionally improve', 'nice to have', 'bonus',
  ]
  const creepCount = creepPhrases.filter(p => plan.includes(p)).length
  score -= creepCount * 2

  // Clear scope statement
  if (plan.includes('scope') || plan.includes('out of scope') || plan.includes('not included')) {
    score += 2
  }

  // Plan size proportional to request (only measurable when the request was given)
  if (request.trim()) {
    const requestWords = request.split(/\s+/).length
    const planWords = plan.split(/\s+/).length
    if (planWords / requestWords > 50) score -= 1 // plan is massively longer than request
  }

  score = Math.max(1, Math.min(10, score))

  return {
    name: 'Scope Boundary',
    score,
    weight: 1.5,
    feedback: score < 7
      ? 'Define clear scope boundaries — avoid scope creep and "nice to haves"'
      : 'Plan has clear scope boundaries',
  }
}

function assessOrdering(plan: string, _lines: string[]): PlanCriterion {
  let score = 5

  // Has numbered/ordered steps
  const hasOrder = /\d+[\.\)]\s/.test(plan) || plan.includes('first') || plan.includes('then') || plan.includes('finally')
  if (hasOrder) score += 2

  // Has phases or stages
  if (plan.includes('phase') || plan.includes('stage') || plan.includes('step ')) score += 1

  // Dependencies between steps acknowledged
  if (plan.includes('after') || plan.includes('before') || plan.includes('depends on') || plan.includes('requires')) {
    score += 1
  }

  // Parallel vs sequential consideration
  if (plan.includes('parallel') || plan.includes('concurrent') || plan.includes('independent')) score += 1

  score = Math.max(1, Math.min(10, score))

  return {
    name: 'Ordering',
    score,
    weight: 1,
    feedback: score < 7
      ? 'Add clear step ordering with dependencies (what must happen before what)'
      : 'Plan has logical step ordering',
  }
}

function assessTestability(plan: string, _lines: string[]): PlanCriterion {
  let score = 4

  // Testing mentions
  if (plan.includes('test') || plan.includes('verify') || plan.includes('validate')) score += 2

  // Specific verification
  if (plan.includes('pnpm build') || plan.includes('pnpm test') || plan.includes('pnpm typecheck') || plan.includes('pnpm lint')) {
    score += 2
  }

  // Acceptance criteria
  if (plan.includes('acceptance') || plan.includes('criteria') || plan.includes('expected outcome') || plan.includes('success:')) {
    score += 2
  }

  // Manual verification steps
  if (plan.includes('manually check') || plan.includes('smoke test') || plan.includes('verify that')) score += 1

  score = Math.max(1, Math.min(10, score))

  return {
    name: 'Testability',
    score,
    weight: 1.5,
    feedback: score < 7
      ? 'Add verification steps: how will you know this plan succeeded? Include test/build commands.'
      : 'Plan has adequate verification steps',
  }
}

function assessImpactClarity(plan: string, _lines: string[]): PlanCriterion {
  let score = 5

  // Files to modify mentioned
  if (/modify|change|edit|update|create|add to/.test(plan)) score += 1

  // Impact on existing code
  if (plan.includes('existing') || plan.includes('current') || plan.includes('affected')) score += 1

  // User-facing vs internal distinction
  if (plan.includes('user-facing') || plan.includes('internal') || plan.includes('api change') || plan.includes('breaking')) {
    score += 1
  }

  // Performance/security implications
  if (plan.includes('performance') || plan.includes('security') || plan.includes('latency')) score += 1

  // Clear outcome statement
  if (plan.includes('outcome') || plan.includes('result:') || plan.includes('after this') || plan.includes('will enable')) {
    score += 1
  }

  score = Math.max(1, Math.min(10, score))

  return {
    name: 'Impact Clarity',
    score,
    weight: 1,
    feedback: score < 7
      ? 'Clarify what will change, what files are affected, and the expected outcome'
      : 'Plan clearly describes the expected impact',
  }
}

/** Format plan quality result as a readable scorecard */
export function formatPlanScorecard(result: PlanQualityResult): string {
  const lines = [
    `Plan Quality Assessment (Iteration ${result.iteration}/${result.maxIterations})`,
    '─'.repeat(55),
  ]

  for (const c of result.criteria) {
    const bar = '█'.repeat(Math.round(c.score)) + '░'.repeat(10 - Math.round(c.score))
    const status = c.score >= 8 ? 'GOOD' : c.score >= 6 ? 'OK' : 'WEAK'
    lines.push(`  ${c.name.padEnd(18)} ${bar} ${c.score.toFixed(1)}/10  ${status}`)
  }

  lines.push('─'.repeat(55))
  lines.push(`  Total Score: ${result.totalScore.toFixed(1)}/10  ${result.passed ? 'APPROVED' : 'NEEDS IMPROVEMENT'}`)

  if (!result.passed && result.improvements.length > 0) {
    lines.push('')
    lines.push('  Improvements needed:')
    for (const imp of result.improvements) {
      lines.push(`    - ${imp}`)
    }
  }

  if (result.canRetry) {
    lines.push(`\n  Retries remaining: ${result.maxIterations - result.iteration}`)
  }

  return lines.join('\n')
}
