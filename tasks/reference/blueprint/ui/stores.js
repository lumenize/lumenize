import Debug from 'debug'

import { writable, derived, get } from 'svelte/store'

import { Dragster } from '@transformation-dev/dragster'

import { ViewstateStore } from '@transformation-dev/svelte-viewstate-store'
import { RealtimeStore } from '@transformation-dev/svelte-realtime-store'

const debug = Debug('blueprint:stores.js')  // Don't forget to set environment variable with 'DEBUG=blueprint:*' and localStorage with debug='blueprint:*'

// TODO: Change every name to have "Store" at the end to make it clear that you need to use $<store_nameStore> to access the value

// export const { connected } = RealtimeStore
export const connected = writable(true)

export const authenticated = writable(false)
// export const readyToGo = writable('not ready')  // 'getting ready', 'ready'
export const readyToGo = derived(  // 'not ready', 'getting ready', 'ready'
  [authenticated, connected],
  ([$authenticated, $connected]) => {
    debug('Inside readyToGo derivation callback. $authenticated: %O, $connected: %O', $authenticated, $connected)
    if ($authenticated && $connected) {
      return 'ready'
    } else if ($authenticated || $connected) {
      return 'getting ready'
    } else {
      return 'not ready'
    }
  },
  'not ready',
)

export const accountInitializedStore = writable(true)

export const openPracticeID = new ViewstateStore({
  identifier: 'openPracticeID',
  defaultValue: '',
  scope: '/plan',
  isGlobal: true,
})
// export const openPracticeID = writable('')

// export const formulation = writable({
// export const formulation = realtimeClient.realtime({_entityID: 'formulation'}, {
export const formulation = new RealtimeStore({
  _entityID: 'formulation',
  defaultValue: {
    label: 'Some formulation',
    disciplines: [
      {
        id: 'discipline1',
        label: 'Artisanship',
        description: 'blah',
        documentation: 'blah',
        practices: [
          {
            id: 'practice1',
            label: 'Yellow Belt',
            description: 'Something to <strong>say</strong> about **Yellow Belt** in Markdown',
            documentation: 'Some _Markdown_ documentation',
          },
          {
            id: 'practice2',
            label: 'Orange Belt',
            description: 'blah blah blah',
            documentation: 'blah',
          },
        ],
      },
      {
        id: 'discipline2',
        label: 'Tools',
        description: 'blah',
        documentation: 'blah',
        practices: [
          {
            id: 'practice3',
            label: 'SCA',
            description: 'in Markdown',
            documentation: 'Some _Markdown_ documentation',
          },
          {
            id: 'practice4',
            label: 'SAST/IAST',
            description: 'Something to say in Markdown',
            documentation: 'Some _Markdown_ documentation',
          },
          {
            id: 'practice5',
            label: 'Network Originated Scans',
            description: 'blah blah blah',
            documentation: 'blah',
          },
          {
            id: 'practice6',
            label: 'Morgans Practice',
            description: 'blah blah blah',
            documentation: 'blah',
          },
        ],
      },
    ],
  },
})

export const queueSwimlanes = writable({
  queue1: {
    id: 'queue1',
    label: 'Planned',
  },
  queue2: {
    id: 'queue2',
    label: 'Stretch',
  },
})

export const chosenOrgBreadcrumbsArrayStore = writable([])

const dagNode = { id: 'DAGNode', label: 'DAG Node' }
export const authorizedTreeStore = writable({
  id: 'companyID',
  label: 'Company',
  children: [
    {
      id: 'node1',
      label: 'Node 1',
      children: [
        {
          id: 'node1.1',
          label: 'Node 1.1',
          children: [
            {
              id: 'node1.1.1',
              label: 'Node 1.1.1',
              children: [
                {
                  id: 'node1.1.1.1',
                  label: 'Node 1.1.1.1',
                },
              ],
            },
            {
              id: 'node1.1.2',
              label: 'Node 1.1.2 is Strong',
              children: [],  // Intentionally has children but empty to test
            },
            dagNode,
          ],
        },
        {
          id: 'node1.2',
          label: 'Node 1.2',
          children: [],
        },
        dagNode,
      ],
    },
    {
      id: 'node2',
      label: 'Node 2',
      children: [],
    },
    {
      id: 'node3',
      label: 'Node 3',  // Intentionally missing children to test
    },
    {
      id: 'node4',
      label: 'Node 4',
      children: [],
    },
  ],
})

// export const plan = realtimeClient.realtime({_entityID: 'plan'}, {
export const plan = new RealtimeStore({
  _entityID: 'plan',
  defaultValue: {
  // export const plan = writable({
    practice1: {
      practiceID: 'practice1',
      formulationID: 'formulation1',
      teamID: 'teamA',
      assessedLevel: 'Words',
      notes: 'Some note',
      goalLevel: 'level2',
      goalDate: '2020-07-12',
      status: 'Doing',
      queueSwimlaneID: 'queue1',
    },
    practice6: {
      practiceID: 'practice6',
      formulationID: 'formulation1',
      teamID: 'teamA',
      assessedLevel: 'Words',
      notes: 'Some note',
      goalLevel: 'level2',
      goalDate: '2020-07-12',
      status: 'Doing',
      queueSwimlaneID: 'queue1',
    },
    practice2: {
      practiceID: 'practice2',
      formulationID: 'formulation1',
      teamID: 'teamA',
      assessedLevel: 'Actions',
      notes: 'Some note 2',
      goalLevel: 'level4',
      goalDate: '2020-09-12',
      status: 'Doing',
      queueSwimlaneID: 'queue1',
    },
    practice4: {
      practiceID: 'practice4',
      formulationID: 'formulation1',
      teamID: 'teamA',
      assessedLevel: 'Culture',
      notes: 'Some note 2',
      goalLevel: 'level4',
      goalDate: '2020-09-12',
      status: 'Doing',
      queueSwimlaneID: 'queue2',
    },
    practice3: {
      practiceID: 'practice3',
      formulationID: 'formulation1',
      teamID: 'teamA',
      assessedLevel: 'Culture',
      notes: 'Some note 2',
      status: 'Done',
    },
    practice5: {
      practiceID: 'practice5',
      formulationID: 'formulation1',
      teamID: 'teamA',
      assessedLevel: 'Thoughts',
      notes: 'Some note again',
      status: 'Todo',
    },
  },
})

export function addDragster(node) {  // TODO: Why is this in stores.js? There are no actual stores
  return new Dragster(node)
}

export const toastsStore = writable([])
const toastsSet = new Set()  // Using a Set so I can delete it using the original object
export const addToast = (newToast, overrideDuration) => {  // { messageType, message, duration (in milliseconds) }
  toastsSet.add(newToast)
  const duration = overrideDuration || newToast.duration || { warning: 10000, success: 3000, info: 1000 }[newToast.messageType] || false
  if (duration) {
    setTimeout(() => {
      toastsSet.delete(newToast)
      toastsStore.set([...toastsSet])
    }, duration)
  }
  toastsStore.set([...toastsSet])
}
export const closeToast = (toast) => {  // { messageType, message, duration (in milliseconds) }
  toastsSet.delete(toast)
  toastsStore.set([...toastsSet])
}
