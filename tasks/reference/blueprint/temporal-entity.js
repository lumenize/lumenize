// @ts-nocheck
/* eslint-disable no-param-reassign */  // safe because durable objects are airgapped so to speak
/* eslint-disable no-irregular-whitespace */  // because I use non-breaking spaces in comments

// 3rd party imports
import { diff } from 'deep-object-diff'
import { Validator as JsonSchemaValidator } from '@cfworker/json-schema'

// monorepo imports
import { errorResponseOut, requestIn } from './content-processor.js'
import { throwIf, throwUnless } from './throws.js'
import { getDebug, Debug } from './debug.js'
import { applyDelta } from './apply-delta.js'
import { dateISOStringRegex } from './date-utils'
import { temporalMixin } from './temporal-mixin'

// initialize imports
const debug = getDebug('blueprint:temporal-entity')

// The DurableObject storage API has no way to list just the keys so we have to keep track of all the
// validFrom dates manually and store them under a key entityMeta.timeline
// For now, timeline is just an array of ISO date strings, but later it could be a range-query-optimized b-tree
// if that will help performance. Then again, I could search the array by starting in the middle and
// continuing to split until I've found the right one -- a b-tree-like algorith as opposed to a b-tree data structure.

// To make the code unit testable, we separate the upper-case PUT, GET, etc. from the lower-case put, get, etc.
// The lower-case functions have all the tricky business logic that we test with unit tests.
// The upper-case functions are wrappers and deal with Request and Response objects.
// Lower-case functions will throw errors that are caught by the upper-case functions and turned into
// HTTP responses in a consistent way with a single `getErrorReponse()` function.

// I'm using Microsoft's captialization style for identifiers
// https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/capitalization-conventions
// It's PascalCase for classes/types and camelCase for everything else.
// Acronyms are treated as words, so HTTP is Http, not HTTP, except for two-letter ones, so it's ID, not Id.

/**
 * # TemporalEntityBase
 *
 * Instances of TemporalEntityBase retain their history in a timeline of snapshots. Each snapshot has a complete a copy of the entity's
 * value for that moment in time along with meta like validFrom and validTo. validFrom and validTo define the time range for which the
 * snapshot is... well... valid. This approach was invented by Richard Snodgrass and his doctoral student
 * (see https://en.wikipedia.org/wiki/Valid_time).
 *
 * @constructor
 * @param {DurableObjectState} state
 * @param {DurableObjectEnv} env
 *
 * */
export class TemporalEntity {
  static END_OF_TIME = '9999-01-01T00:00:00.000Z'

  // typeVersionConfig: {
  //  type: string,
  //  version: string,
  //  schema: JSON schema object,
  //  additionalValidation: (object) => boolean; Return true if valid. Throw if not valid.
  //  granularity: string or integer milliseconds,
  //  supressPreviousValues: boolean,
  // }
  constructor(state, env, typeVersionConfig) {
    throwUnless(typeVersionConfig != null, 'typeVersionConfig is required as the third parameter when creating a TemporalEntityBase instance', 500)
    Debug.enable(env.DEBUG)
    this.state = state
    this.env = env
    this.typeVersionConfig = typeVersionConfig
    this.hydrateTypeVersionConfig()

    Object.assign(this, temporalMixin)

    this.hydrated = false
  }

  hydrateTypeVersionConfig() {
    if (this.typeVersionConfig?.granularity != null && typeof this.typeVersionConfig.granularity === 'string') {
      if (['sec', 'second'].includes(this.typeVersionConfig.granularity)) this.typeVersionConfig.granularity = 1000
      else if (['min', 'minute'].includes(this.typeVersionConfig.granularity)) this.typeVersionConfig.granularity = 60000
      else if (['hr', 'hour'].includes(this.typeVersionConfig.granularity)) this.typeVersionConfig.granularity = 3600000
      else if (this.typeVersionConfig.granularity === 'day') this.typeVersionConfig.granularity = 86400000
      else throwIf(true, `Unsupported granularity: ${this.typeVersionConfig.granularity}`, 500)
    }
  }

  async hydrate() {
    if (this.hydrated) return

    this.idString = this.state.id.toString()

    // hydrate #entityMeta
    this.entityMeta = await this.state.storage.get(`${this.idString}/entityMeta`) || { timeline: [] }

    // hydrate #current
    if (this.entityMeta.timeline.length > 0) {
      this.current = await this.state.storage.get(`${this.idString}/snapshot/${this.entityMeta.timeline.at(-1)}`)
    }

    this.hydrated = true
  }

  // eslint-disable-next-line consistent-return
  async fetch(request) {
    debug('%s %s', request.method, request.url)
    this.warnings = []
    try {
      const url = new URL(request.url)
      const pathArray = url.pathname.split('/').filter((s) => s !== '')

      const restOfPath = `/${pathArray.join('/')}`

      switch (restOfPath) {
        case '/':
          if (this[request.method] != null) return await this[request.method](request)
          return throwIf(true, `Unrecognized HTTP method ${request.method} for ${request.url}`, 405)

        case '/ticks':
          throwIf(true, '/ticks not implemented yet', 404)
          return this.doResponseOut(undefined, 500)

        case '/entity-meta':
          throwUnless(request.method === 'GET', `Unrecognized HTTP method ${request.method} for ${request.url}`, 405)
          return await this.GETEntityMeta(request)

        default:
          throwIf(true, `Unrecognized URL ${request.url}`, 404)
      }
    } catch (e) {
      this.hydrated = false
      return errorResponseOut(e, this.env, this.idString)
    }
  }

  async delete(userID, validFrom, impersonatorID) {
    throwUnless(userID, 'userID required by TemporalEntity DELETE is missing')

    await this.hydrate()

    if (this.current?.meta?.deleted) return [this.current, 200]
    throwUnless(this.entityMeta?.timeline?.length > 0, 'cannot call TemporalEntity DELETE when there is no prior value')

    const metaDelta = {
      userID,
      validFrom,
      deleted: true,
    }
    if (impersonatorID != null) metaDelta.impersonatorID = impersonatorID
    await this.patchMetaDelta(metaDelta)
    return [this.current, 200]
  }

  async DELETE(request) {
    const { content: options } = await requestIn(request)
    const [responseBody, status] = await this.delete(options.userID, options.validFrom, options.impersonatorID)
    return this.doResponseOut(responseBody, status)
  }

  async put(value, userID, validFrom, impersonatorID, ifUnmodifiedSince) {
    throwUnless(value, 'body.value field required by TemporalEntity PUT is missing')
    throwUnless(userID, 'userID required by TemporalEntity operation is missing')
    throwIf(
      ifUnmodifiedSince != null && !dateISOStringRegex.test(ifUnmodifiedSince),
      'If-Unmodified-Since must be in YYYY:MM:DDTHH:MM:SS.mmmZ format because we need millisecond granularity',
      400,
      this.current,
    )

    await this.hydrate()

    const { schema } = this.typeVersionConfig
    if (schema != null) {
      const schemaValidator = new JsonSchemaValidator(schema)
      const result = schemaValidator.validate(value)
      throwUnless(result.valid, `Schema validation failed. Error(s):\n${JSON.stringify(result.errors, null, 2)}`)
    }
    const { additionalValidation } = this.typeVersionConfig
    if (additionalValidation != null) {
      additionalValidation(value)
    }

    // Process ifUnmodifiedSince header
    throwIf(this.entityMeta.timeline.length > 0 && ifUnmodifiedSince == null, 'required If-Unmodified-Since header for TemporalEntity PUT is missing', 428, this.current)
    throwIf(ifUnmodifiedSince != null && ifUnmodifiedSince < this.current?.meta?.validFrom, 'If-Unmodified-Since is earlier than the last time this TemporalEntity was modified', 412, this.current)

    throwIf(this.current?.meta?.deleted, 'PUT on deleted TemporalEntity not allowed', 404)

    // Set validFrom and validFromDate
    let validFromDate
    ({ validFrom, validFromDate } = this.calculateValidFrom(validFrom))

    // Determine if this update should be debounced and set oldCurrent
    let debounce = false
    let oldCurrent = { value: {} }
    if (this.current != null) {
      oldCurrent = structuredClone(this.current)
      if (
        userID === this.current?.meta?.userID
        && validFromDate - new Date(this.current.meta.validFrom) < this.typeVersionConfig.granularity
      ) {
        debounce = true
        oldCurrent = await this.state.storage.get(`${this.idString}/snapshot/${this.entityMeta.timeline.at(-2)}`) ?? { value: {} }
        validFrom = this.current.meta.validFrom
      }
    }

    // Calculate the previousValues diff and check for idempotency
    const previousValues = diff(value, oldCurrent.value)
    if (Object.keys(previousValues).length === 0) {  // idempotent
      return this.get()
    }

    // Update the old current and save it
    if (!debounce && this.current != null) {
      oldCurrent.meta.validTo = validFrom
      await this.state.storage.put(`${this.idString}/snapshot/${oldCurrent.meta.validFrom}`, oldCurrent)
    }

    // Create the new current and save it
    this.current = {}
    this.current.meta = {
      userID,
      validFrom,
      validTo: this.constructor.END_OF_TIME,
    }
    if (!this.typeVersionConfig.supressPreviousValues) this.current.meta.previousValues = previousValues
    if (impersonatorID != null) this.current.meta.impersonatorID = impersonatorID
    this.current.value = value
    if (!debounce) {
      this.entityMeta.timeline.push(validFrom)
      await this.state.storage.put(`${this.idString}/entityMeta`, this.entityMeta)
    }
    await this.state.storage.put(`${this.idString}/snapshot/${validFrom}`, this.current)

    // return the new current
    return this.get()
  }

  async PUT(request) {
    const { content: options } = await requestIn(request)
    const ifUnmodifiedSince = request.headers.get('If-Unmodified-Since')
    const [responseBody, status] = await this.put(options.value, options.userID, options.validFrom, options.impersonatorID, ifUnmodifiedSince)
    return this.doResponseOut(responseBody, status)
  }

  async POST(request) {
    const { content: options } = await requestIn(request)
    const ifUnmodifiedSince = request.headers.get('If-Unmodified-Since')
    const [responseBody, status] = await this.put(options.value, options.userID, options.validFrom, options.impersonatorID, ifUnmodifiedSince)
    if (status === 200) return this.doResponseOut(responseBody, 201)
    else return this.doResponseOut(responseBody, status)
  }

  async patchUndelete({ userID, validFrom, impersonatorID }) {
    await this.hydrate()

    validFrom = this.calculateValidFrom(validFrom).validFrom

    throwUnless(this.current?.meta?.deleted, 'Cannot undelete a TemporalEntity that is not deleted')
    const metaDelta = {
      userID,
      validFrom,
      deleted: undefined,
    }
    if (impersonatorID != null) metaDelta.impersonatorID = impersonatorID
    await this.patchMetaDelta(metaDelta)
    return this.get()
  }

  async patchDelta({ delta, userID, validFrom, impersonatorID }, ifUnmodifiedSince) {
    await this.hydrate()

    throwUnless(this.entityMeta?.timeline?.length > 0, 'cannot call TemporalEntity PATCH when there is no prior value')
    throwIf(this.current?.meta?.deleted, 'PATCH with delta on deleted TemporalEntity not allowed', 404)

    const newValue = structuredClone(this.current.value)

    applyDelta(newValue, delta)

    return this.put(newValue, userID, validFrom, impersonatorID, ifUnmodifiedSince)
  }

  async patchMetaDelta(metaDelta) {
    await this.hydrate()

    metaDelta.validFrom = this.calculateValidFrom(metaDelta.validFrom).validFrom

    // Update and save the old current
    const oldCurrent = structuredClone(this.current)
    oldCurrent.meta.validTo = metaDelta.validFrom
    await this.state.storage.put(`${this.idString}/snapshot/${oldCurrent.meta.validFrom}`, oldCurrent)

    // apply metaDelta to current.meta and save it
    applyDelta(this.current.meta, metaDelta)
    this.current.meta.previousValues = {}  // value never changes in a patchMetaDelta
    this.entityMeta.timeline.push(metaDelta.validFrom)
    await this.state.storage.put(`${this.idString}/entityMeta`, this.entityMeta)
    await this.state.storage.put(`${this.idString}/snapshot/${metaDelta.validFrom}`, this.current)
  }

  async patch(options, ifUnmodifiedSince) {
    throwUnless(options.userID, 'userID required by TemporalEntity PATCH is missing')

    if (options.undelete != null) return this.patchUndelete(options)
    if (options.delta != null) return this.patchDelta(options, ifUnmodifiedSince)

    return throwIf(
      true,
      'Malformed PATCH on TemporalEntity. Body must include valid operation: delta, undelete, addParent, removeParent, etc.',
      400,
    )
  }

  async PATCH(request) {
    try {
      const { content: options } = await requestIn(request)
      const ifUnmodifiedSince = request.headers.get('If-Unmodified-Since')
      const [responseBody, status] = await this.patch(options, ifUnmodifiedSince)
      return this.doResponseOut(responseBody, status)
    } catch (e) {
      this.hydrated = false
      return errorResponseOut(e, this.env, this.idString)
    }
  }

  async get(options) {
    const { statusToReturn = 200, ifModifiedSince, asOfISOString } = options ?? {}
    throwIf(
      ifModifiedSince != null && !dateISOStringRegex.test(ifModifiedSince),
      'If-Modified-Since must be in YYYY:MM:DDTHH:MM:SS.mmmZ format because we need millisecond granularity',
      400,
      this.current,
    )
    await this.hydrate()
    throwIf(this.current?.meta?.deleted, 'Resource is soft deleted. If you DELETE again, it will return the current value and meta.', 404)
    if (this.entityMeta.timeline.at(-1) <= ifModifiedSince) return [undefined, 304]
    return [this.current, statusToReturn]
  }
}
