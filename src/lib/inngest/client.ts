import { EventSchemas, Inngest } from 'inngest'

export type HelloEvent = {
  data: {
    name?: string
  }
}

export type RunTestSuiteEvent = {
  data: {
    suiteRunId: number
    beforeEach?: string[]
    afterEach?: string[]
  }
}

export type RunTestEvent = {
  data: {
    testRunId: number
    beforeEach?: string[]
    afterEach?: string[]
  }
}

type Events = {
  hello: HelloEvent
  'test-suite/run': RunTestSuiteEvent
  'test/run': RunTestEvent
}

export const inngest = new Inngest({
  id: 'qa-use',
  schemas: new EventSchemas().fromRecord<Events>(),
})
