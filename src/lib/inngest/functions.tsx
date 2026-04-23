import { eq, inArray } from 'drizzle-orm'
import { NonRetriableError, RetryAfterError } from 'inngest'

import { client } from '../api/client'
import { db } from '../db/db'
import * as schema from '../db/schema'
import { resend } from '../resend/client'
import { SuiteFailedEmail } from '../resend/emails/SuiteFailedEmail'
import type { TestDefinition } from '../testing/engine'
import { getTaskPrompt, getTaskResponse, RESPONSE_JSON_SCHEMA } from '../testing/engine'
import { ExhaustiveSwitchCheck } from '../types'
import { inngest } from './client'

// Functions -----------------------------------------------------------------

/**
 * Utility function to test the Inngest connection.
 */
export const helloWorld = inngest.createFunction(
  {
    id: 'hello-world',
  },
  { event: 'hello' },
  async ({ step, event }) => {
    await step.run('hello', async () => {
      if (event.data.name) {
        return `Hello, ${event.data.name}!`
      }

      return 'Hello, world!'
    })
  },
)

/**
 * Performs a single test run.
 */
export const runTest = inngest.createFunction(
  {
    id: 'run-test',
    onFailure: async ({ event, step }) => {
      const testRunId = event.data.event.data.testRunId

      await step.run('update-test-run-status', async () => {
        await db.update(schema.testRun).set({ status: 'failed' }).where(eq(schema.testRun.id, testRunId))
      })
    },
  },
  { event: 'test/run' },
  async ({ step, event }) => {
    const { testRunId, beforeEach, afterEach } = event.data

    await step.run(`start-test-run-${testRunId}`, _startTestRun, { testRunId, beforeEach, afterEach })

    await step.run(`complete-test-run-${testRunId}`, _pollTaskUntilFinished, { testRunId })

    await step.run(`finalize-test-run`, _finalizeTestRun, { testRunId })
  },
)

/**
 * Runs a test suite.
 */
export const runTestSuite = inngest.createFunction(
  {
    id: 'run-test-suite',
    onFailure: async ({ event, step }) => {
      const suiteRunId = event.data.event.data.suiteRunId

      await step.run('update-suite-run-status', async () => {
        await db.update(schema.suiteRun).set({ status: 'failed' }).where(eq(schema.suiteRun.id, suiteRunId))
        await db.update(schema.testRun).set({ status: 'failed' }).where(eq(schema.testRun.suiteRunId, suiteRunId))
      })
    },
  },
  { event: 'test-suite/run' },
  async ({ step, event }) => {
    const { suiteRunId, beforeEach, afterEach } = event.data

    const testRunIds = await step.run('get-test-run-ids', async () => {
      const dbTestRuns = await db.query.testRun.findMany({
        where: eq(schema.testRun.suiteRunId, suiteRunId),
        columns: {
          id: true,
        },
      })

      return dbTestRuns.map((testRun) => testRun.id)
    })

    await Promise.all(
      testRunIds.map((testRunId) =>
        step.run(`start-test-run-${testRunId}`, _startTestRun, { testRunId, beforeEach, afterEach }),
      ),
    )

    await Promise.all(
      testRunIds.map((testRunId) => step.run(`complete-test-run-${testRunId}`, _pollTaskUntilFinished, { testRunId })),
    )

    await step.run(`finalize-suite-run`, _finalizeSuiteRun, { suiteId: suiteRunId, testRunIds })

    await step.run(`send-suite-notification`, _sendSuiteNotification, { suiteRunId: event.data.suiteRunId })
  },
)

// Steps ---------------------------------------------------------------------

/**
 * Start a new agent test run and return the ID of the test run.
 */
async function _startTestRun({
  testRunId,
  beforeEach,
  afterEach,
}: {
  testRunId: number
  beforeEach?: string[]
  afterEach?: string[]
}): Promise<number> {
  const dbTestRun = await db.query.testRun.findFirst({
    where: eq(schema.testRun.id, testRunId),
    with: {
      test: {
        with: {
          steps: true,
        },
      },
    },
  })

  if (dbTestRun?.browserUseId != null) {
    return dbTestRun.id
  }

  if (!dbTestRun) {
    throw new NonRetriableError(`Test run not found: ${testRunId}`)
  }

  const definition: TestDefinition = {
    evaluation: dbTestRun.test.evaluation,
    label: dbTestRun.test.label,
    steps: dbTestRun.test.steps.map((step) => ({
      id: step.id,
      label: `${step.order}`,
      description: step.description,
    })),
  }

  // Start browser task
  const buTaskResponse = await client.POST('/sessions', {
    body: {
      task: getTaskPrompt(definition, { beforeEach, afterEach }),
      model: 'bu-mini',
      keepAlive: false,
      proxyCountryCode: 'us',
      outputSchema: RESPONSE_JSON_SCHEMA,
      maxCostUsd: 2,
      enableScheduledTasks: false,
      enableRecording: false,
      skills: false,
      agentmail: false,
      workspaceId: process.env.BROWSER_USE_WORKSPACE_ID || undefined,
      cacheScript: process.env.BROWSER_USE_WORKSPACE_ID ? true : null,
    },
  })

  if (!buTaskResponse.data) {
    throw new RetryAfterError('Failed to start browser task', 1_000, {
      cause: new Error(JSON.stringify(buTaskResponse.error)),
    })
  }

  if (dbTestRun.suiteRunId) {
    await db
      .update(schema.suiteRun)
      .set({
        status: 'running',
      })
      .where(eq(schema.suiteRun.id, dbTestRun.suiteRunId))
  }

  await db
    .update(schema.testRun)
    .set({
      status: 'running',
      browserUseId: buTaskResponse.data.id,
    })
    .where(eq(schema.testRun.id, dbTestRun.id))

  return dbTestRun.id
}

/**
 * Polls the Browser Use API until the task is finished.
 */
async function _pollTaskUntilFinished({ testRunId }: { testRunId: number }) {
  while (true) {
    const dbTestRun = await db.query.testRun.findFirst({
      where: eq(schema.testRun.id, testRunId),
      with: {
        testRunSteps: true,
      },
    })

    if (!dbTestRun) {
      throw new NonRetriableError(`Test run not found: ${testRunId}`)
    }

    if (!dbTestRun.browserUseId) {
      throw new NonRetriableError(`Test run not started: ${testRunId}`)
    }

    const buTaskResponse = await client.GET('/sessions/{session_id}', {
      params: { path: { session_id: dbTestRun.browserUseId } },
    })

    if (buTaskResponse.error || !buTaskResponse.data) {
      throw new RetryAfterError('Failed to get task status, retrying...', 1_000)
    }

    switch (buTaskResponse.data.status) {
      case 'stopped': {
        const taskResult = getTaskResponse(buTaskResponse.data.output)

        if (taskResult.status === 'pass') {
          await db.transaction(async (tx) => {
            await tx
              .update(schema.testRun)
              .set({
                finishedAt: new Date(),
                status: 'passed',
                error: null,
                publicShareUrl: null,
                liveUrl: buTaskResponse.data.liveUrl,
              })
              .where(eq(schema.testRun.id, dbTestRun.id))

            // NOTE: Here we update all steps at once and mark them as passed.
            await tx
              .update(schema.testRunStep)
              .set({
                status: 'passed' as const,
              })
              .where(eq(schema.testRunStep.testRunId, dbTestRun.id))
          })
        }

        if (taskResult.status === 'failing') {
          await db.transaction(async (tx) => {
            await tx
              .update(schema.testRun)
              .set({
                finishedAt: new Date(),
                status: 'failed',
                error: taskResult.error,
                publicShareUrl: null,
                liveUrl: buTaskResponse.data.liveUrl,
              })
              .where(eq(schema.testRun.id, dbTestRun.id))

            // NOTE: We manually check each step to see if it was performed as expected.
            for (const step of dbTestRun.testRunSteps) {
              // TODO: Unify step ID types!
              const passed = taskResult.steps?.find((s) => s.id === `${step.stepId}`)

              await tx
                .update(schema.testRunStep)
                .set({
                  status: passed ? 'passed' : 'failed',
                })
                .where(eq(schema.testRunStep.id, step.id))
            }
          })
        }

        return { ok: true, data: buTaskResponse.data.output }
      }

      case 'running':
      case 'created':
      case 'idle': {
        if (buTaskResponse.data.liveUrl) {
          await db
            .update(schema.testRun)
            .set({
              liveUrl: buTaskResponse.data.liveUrl,
              publicShareUrl: null,
            })
            .where(eq(schema.testRun.id, dbTestRun.id))
        }

        await new Promise((resolve) => setTimeout(resolve, 1_000))
        break
      }

      case 'timed_out':
      case 'error': {
        await db
          .update(schema.testRun)
          .set({
            status: 'failed',
          })
          .where(eq(schema.testRun.id, dbTestRun.id))

        return {
          ok: false,
          data: buTaskResponse.data.output,
        }
      }

      default:
        throw new ExhaustiveSwitchCheck(buTaskResponse.data.status)
    }
  }
}

async function _finalizeTestRun({ testRunId }: { testRunId: number }) {
  const dbTestRun = await db.query.testRun.findFirst({
    where: eq(schema.testRun.id, testRunId),
  })

  if (!dbTestRun) {
    throw new NonRetriableError(`Test run not found: ${testRunId}`)
  }

  const hasFailed = dbTestRun.status === 'failed'

  await db
    .update(schema.testRun)
    .set({
      status: hasFailed ? 'failed' : 'passed',
      finishedAt: new Date(),
    })
    .where(eq(schema.testRun.id, testRunId))

  return { hasFailed }
}

async function _finalizeSuiteRun({ suiteId, testRunIds }: { suiteId: number; testRunIds: number[] }) {
  const dbTestRuns = await db.query.testRun.findMany({ where: inArray(schema.suiteRun.id, testRunIds) })

  const hasFailed = dbTestRuns.some((result) => result.status === 'failed')

  await db
    .update(schema.suiteRun)
    .set({
      status: hasFailed ? 'failed' : 'passed',
      finishedAt: new Date(),
    })
    .where(eq(schema.suiteRun.id, suiteId))

  return { hasFailed }
}

async function _sendSuiteNotification({ suiteRunId }: { suiteRunId: number }) {
  const dbSuiteRun = await db.query.suiteRun.findFirst({
    where: eq(schema.suiteRun.id, suiteRunId),
    with: {
      suite: true,
      testRuns: {
        with: {
          test: true,
        },
      },
    },
  })

  if (!dbSuiteRun) {
    throw new NonRetriableError(`Suite run not found: ${suiteRunId}`)
  }

  if (dbSuiteRun.status !== 'failed' || dbSuiteRun.suite.notificationsEmailAddress == null) {
    // NOTE: We don't send notifications for successful runs or if no email address is set.
    return { sent: false }
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL
  if (resend == null || !fromEmail) {
    throw new NonRetriableError('Resend is not configured!')
  }

  const res = await resend.emails.send({
    from: fromEmail,
    to: dbSuiteRun.suite.notificationsEmailAddress,
    subject: `Suite ${dbSuiteRun.suite.name} Failed (#${suiteRunId})`,
    react: (
      <SuiteFailedEmail
        suiteId={dbSuiteRun.suite.id}
        suiteName={dbSuiteRun.suite.name}
        suiteStartedAt={dbSuiteRun.createdAt}
        suiteFinishedAt={dbSuiteRun.createdAt}
        runs={dbSuiteRun.testRuns.map((testRun) => ({
          runId: testRun.id,
          runName: testRun.test.label,
          runStatus: testRun.status,
          runStartedAt: testRun.createdAt,
          runFinishedAt: testRun.finishedAt,
        }))}
      />
    ),
  })

  if (res.error) {
    console.error(res)
    throw new Error(`Failed to send email: ${JSON.stringify(res.error)}`)
  }

  return { sent: true }
}
