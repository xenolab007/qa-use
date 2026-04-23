import z from 'zod/v4'

export const zResponse = z.object({
  status: z.union([z.literal('pass'), z.literal('failing')]),
  steps: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
      }),
    )
    .nullable(),
  error: z.string().nullable(),
})

export type TaskResponse = z.infer<typeof zResponse>

export const RESPONSE_JSON_SCHEMA = z.toJSONSchema(zResponse)

/**
 * Get the task response from the output.
 *
 * v3 returns `output` as a parsed object matching the `outputSchema`, so we validate
 * directly. Legacy string inputs (from v1 or older persisted data) are parsed first.
 */
export function getTaskResponse(output: unknown): TaskResponse {
  if (output == null) {
    return {
      status: 'failing',
      steps: [],
      error: 'No output was provided!',
    }
  }

  let candidate: unknown = output
  if (typeof output === 'string') {
    try {
      candidate = JSON.parse(output)
    } catch {
      return {
        status: 'failing',
        steps: [],
        error: 'Failed to parse task response',
      }
    }
  }

  const response = zResponse.safeParse(candidate)
  if (!response.success) {
    return {
      status: 'failing',
      steps: [],
      error: `Failed to parse task response: ${response.error.message}`,
    }
  }

  return response.data
}

export type TestDefinition = {
  label: string

  /**
   * The steps you need to take to get there.
   */
  steps: { id: number; label: string; description: string }[]

  /**
   * The success criteria for the final state of the application.
   */
  evaluation: string
}

export type TestSuiteDefinition = {
  label: string

  /**
   * The tests to run.
   */
  tests: TestDefinition[]

  /**
   * Steps to run before each test (e.g. authenticate, set a token).
   */
  beforeEach?: string[]

  /**
   * Steps to run after each test (e.g. log out, reset state).
   */
  afterEach?: string[]
}

export const SYSTEM_PROMPT = `
You are a QA testing agent. Execute the given steps in order and evaluate the final state against the success criteria.

# Rules
- Execute steps in exact order. No retries, no workarounds.
- A step fails if it cannot be performed or makes the next step impossible.
- Only evaluate the end state after all steps complete successfully.
- Evaluate ONLY what the criteria specifies — nothing more, nothing less.

# Response
Return ONLY valid JSON.
Pass: { "status": "pass", "steps": null, "error": null }
Fail: { "status": "failing", "steps": [<completed steps in order>], "error": "<reason referencing the failed step label>" }
`

/**
 * Formats a test definition into a string that can be used by an LLM.
 */
function stringifyTest(test: TestDefinition) {
  return `
<test>
  <steps>
    ${test.steps.map((step) => `<step id="${step.id}" label="${step.label}">${step.description}</step>`).join('\n')}
  </steps>
  <evaluation>${test.evaluation}</evaluation>
</test>
  `.trim()
}

/**
 * Get the prompt for a test, with optional before/after steps injected.
 */
export function getTaskPrompt(test: TestDefinition, opts?: { beforeEach?: string[]; afterEach?: string[] }) {
  let definition = test

  if (opts?.beforeEach?.length || opts?.afterEach?.length) {
    const offset = opts.beforeEach?.length ?? 0
    const beforeSteps = (opts.beforeEach ?? []).map((description, i) => ({
      id: -(offset - i),
      label: `before-${i + 1}`,
      description,
    }))
    const afterSteps = (opts.afterEach ?? []).map((description, i) => ({
      id: test.steps.length + i + 1,
      label: `after-${i + 1}`,
      description,
    }))

    definition = {
      ...test,
      steps: [...beforeSteps, ...test.steps, ...afterSteps],
    }
  }

  return `
${SYSTEM_PROMPT}

--- TASK STARTS HERE ---

${stringifyTest(definition)}
`
}

export function createTest(test: { label: string; steps: string[]; evaluation: string }): TestDefinition {
  return {
    label: test.label,
    steps: test.steps.map((step, index) => ({
      id: index,
      label: `${index + 1}`,
      description: step,
    })),
    evaluation: test.evaluation,
  }
}
