/* eslint-disable no-param-reassign */

import { responseOut } from './content-processor.js'
import { throwIf } from './throws.js'
import { dateISOStringRegex } from './date-utils.js'

// These are methods that are common to all TemporalEntities including Tree
// This assumes that this.entityMeta is defined and it has a timeline property. Note, it can have other properties as well.
export const temporalMixin = {
  calculateValidFrom(validFrom) {  // This is the one from TemporalEntityBase not old Tree
    let validFromDate
    let newValidFrom
    if (validFrom != null) {
      if (this.entityMeta?.timeline?.length > 0) {
        throwIf(validFrom <= this.entityMeta.timeline.at(-1), 'the validFrom for a TemporalEntity update is not greater than the prior validFrom')
      }
      validFromDate = new Date(validFrom)
      newValidFrom = validFromDate.toISOString()
    } else {
      validFromDate = new Date()
      if (this.entityMeta?.timeline?.length > 0) {
        const lastTimelineDate = new Date(this.entityMeta.timeline.at(-1))
        if (validFromDate <= lastTimelineDate) {
          validFromDate = new Date(lastTimelineDate.getTime() + 1)
        }
        newValidFrom = new Date(validFromDate).toISOString()
      } else {
        newValidFrom = validFromDate.toISOString()
        validFromDate = new Date(validFrom)
      }
    }
    return { validFrom: newValidFrom, validFromDate }
  },

  async GET(request) {
    const ifModifiedSince = request.headers.get('If-Modified-Since')
    const url = new URL(request.url)
    const asOf = url.searchParams.get('asOf')
    const asOfISOString = asOf ? new Date(asOf).toISOString() : undefined  // TODO: Maybe we should require ISO-8601 format?
    const [response, status] = await this.get({ ifModifiedSince, asOfISOString })
    if (status === 304) return responseOut(undefined, 304)
    return responseOut(response)
  },

  async getEntityMeta(ifModifiedSince) {
    throwIf(
      ifModifiedSince != null && !dateISOStringRegex.test(ifModifiedSince),
      'If-Modified-Since must be in YYYY:MM:DDTHH:MM:SS.mmmZ format because we need millisecond granularity',
      400,
      this.current,  // TODO: Does Tree have this.current?
    )
    await this.hydrate()
    if (this.entityMeta.timeline.at(-1) <= ifModifiedSince) return [undefined, 304]
    return [this.entityMeta, 200]
  },

  async GETEntityMeta(request) {
    const ifModifiedSince = request.headers.get('If-Modified-Since')
    const [entityMeta, status] = await this.getEntityMeta(ifModifiedSince)
    if (status === 304) return responseOut(undefined, 304)
    return responseOut(entityMeta, status)
  },

  async doResponseOut(body, status = 200) {
    const headers = new Headers()
    headers.set('Content-ID', this.idString)
    if (body != null) {
      body.idString = this.state?.id.toString()
      if (this.warnings != null) body.warnings = this.warnings
    }
    return responseOut(body, status, undefined, headers)
  },
}
