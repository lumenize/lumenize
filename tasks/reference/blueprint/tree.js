// @ts-nocheck
/* eslint-disable no-param-reassign */  // safe because durable objects are airgapped so to speak
// file deepcode ignore AttrAccessOnNull: Everytime I see this, I think it's a false positive
// file deepcode ignore StaticAccessThis: I disagree with the rule. Repeating the class name is not DRY.

// monorepo imports
import { requestOutResponseIn, errorResponseOut, requestIn } from './content-processor.js'
import { throwIf, throwUnless } from './throws.js'
import { getDebug, Debug } from './debug.js'
import { HTTPError } from './http-error.js'
import { dateISOStringRegex } from './date-utils'
import { TemporalEntity } from './temporal-entity'
import { temporalMixin } from './temporal-mixin'

// initialize imports
const debug = getDebug('blueprint:tree')

/*

/tree/v1
  POST - creates a new tree with a root node

/tree/v1/[treeIDString]
  GET - returns the DAG with just labels and children
  PATCH
    addNode - Adds a node to the tree
      body.addNode contains newNode and parent fields
    addBranch - Adds a branch
      body contains parent and child fields. Strings or numbers are accepted.
    deleteBranch - Deletes a branch
      body contains parent and child fields. Strings or numbers are accepted.
    moveBranch - Moves a branch from one parent to another.
      body contains parent, child, and newParent fields. Strings or numbers are accepted.
      Start with addBranch which has error checking. If that succeeds, removeBranch which has no error checking.

/tree/v1/[treeIdString]/aggregate
  TODO B: POST - execute the aggregation. Starting nodeIDString in body or root if omitted. First version just gathers all matching nodes.

TODO: Use Cloudflare queues to communicate changes to node TemporalEntities to the Tree instance
*/

/**
 * # Tree
 *
 *
 * @constructor
 * @param {DurableObjectState} state
 * @param {DurableObjectEnv} env
 *
 * */
export class Tree  {
  // <NodeStub> = {
  //   label: string,  // denormalized from the node itself
  //   idString: string  // idString for the DO that holds the actual node
  // }
  // <Nodes> = {
  //   <id: string>: <NodeStub>,  // this id comes from incrementing nodeCount
  // }
  // <Edges> = {  // use for both edges and reverseEdges
  //   <id: string>: [<id: string>],
  // }

  constructor(state, env, typeVersionConfig) {
    Debug.enable(env.DEBUG)
    this.state = state
    this.env = env
    this.typeVersionConfig = typeVersionConfig

    Object.assign(this, temporalMixin)

    this.idString = this.state.id.toString()
    this.hydrated = false  // using this.hydrated for lazy load rather than this.state.blockConcurrencyWhile(this.hydrate.bind(this))
  }

  // Utilities

  async hydrate() {
    debug('hydrate() called. this.hydrated: %O', this.hydrated)
    if (this.hydrated) return

    // hydrate #entityMeta
    const defaultEntityMeta = {
      timeline: [],
      nodeCount: 0,
    }
    this.entityMeta = await this.state.storage.get(`${this.idString}/entityMeta`) || defaultEntityMeta

    // hydrate instance data
    this.current = {}
    if (this.entityMeta.timeline.length > 0) {
      this.nodes = await this.state.storage.get(`${this.idString}/snapshot/${this.entityMeta.timeline.at(-1)}/nodes`)
      this.edges = await this.state.storage.get(`${this.idString}/snapshot/${this.entityMeta.timeline.at(-1)}/edges`)
    }
    this.invalidateDerived()
    this.hydrated = true
  }

  invalidateDerived() {
    this.reverseEdges = null
    this.tree = null
  }

  deriveReverseEdges() {  // This is the first function after 6 months of using GitHub Copilot that was auto-created without any edits
    if (this.reverseEdges != null) return
    this.reverseEdges = {}
    for (const [parentID, children] of Object.entries(this.edges)) {
      for (const childID of children) {
        if (this.reverseEdges[childID] == null) this.reverseEdges[childID] = []
        this.reverseEdges[childID].push(parentID)
      }
    }
  }

  isChildOf(parentID, childID) {  // is childID (2nd parameter) a child of parentID (1st parameter)?
    return this.edges?.[parentID]?.includes(childID)
  }

  async throwIfInvalidID(id) {
    await this.hydrate()
    const parentIDNumber = Number(id)
    throwIf(
      Number.isNaN(parentIDNumber) || parentIDNumber < 0 || parentIDNumber > this.entityMeta.nodeCount,
      `${id} not found`,
      404,
    )
  }

  recurseThrowIfIDInAncestry(parent, child, pathFromAncestorToChild) {
    pathFromAncestorToChild.unshift(parent)
    throwIf(pathFromAncestorToChild[0] === pathFromAncestorToChild.at(-1), `Adding this branch would create a cycle: ${pathFromAncestorToChild.join(' -> ')}`, 409)
    if (parent !== '0') {
      for (const p of this.reverseEdges[parent]) {
        this.recurseThrowIfIDInAncestry(p, child, pathFromAncestorToChild)
      }
    }
    return true
  }

  async throwIfIDInAncestry(parent, child, pathFromAncestorToChild = []) {
    await this.hydrate()
    this.deriveReverseEdges()
    parent = parent.toString()
    child = child.toString()
    pathFromAncestorToChild.push(child)
    return this.recurseThrowIfIDInAncestry(parent, child, pathFromAncestorToChild)
  }

  async save() {  // TODO: Upgrade this to support a large number of nodes once we have a customer getting close to that limit. Determine the limit now with testing.
    debug('save() called')
    this.state.storage.put(`${this.idString}/entityMeta`, this.entityMeta)
    this.state.storage.put(`${this.idString}/snapshot/${this.entityMeta.timeline.at(-1)}/nodes`, this.nodes)
    this.state.storage.put(`${this.idString}/snapshot/${this.entityMeta.timeline.at(-1)}/edges`, this.edges)
  }

  async updateMetaAndSave(validFrom, userID, impersonatorID, incrementNodeCount = false) {  // You must update current.nodes or current.edges before calling this.
    debug('updateMetaAndSave() called')
    throwUnless(this.hydrated, 'updateMetaAndSave() called before hydrate()')
    this.current.meta = {
      validFrom,
      validTo: TemporalEntity.END_OF_TIME,
      userID,
      type: this.typeVersionConfig.type,
      version: this.typeVersionConfig.version,
      // We don't maintain previousValues for the tree itself, but we do for the nodes
    }
    if (impersonatorID != null) this.current.meta.impersonatorID = impersonatorID
    this.entityMeta.timeline.push(validFrom)
    if (incrementNodeCount) this.entityMeta.nodeCount++
    return this.save()
  }

  async callNodeDO(nodeType, nodeVersion, options, expectedResponseCode, idString) {
    let id
    let url = `http://fake.host/${nodeType}/${nodeVersion}/`
    if (idString == null) {
      id = this.env[this.typeVersionConfig.nodeDOEnvNamespace].newUniqueId()
    } else {
      id = this.env[this.typeVersionConfig.nodeDOEnvNamespace].idFromString(idString)
      url += `${idString}/`
    }
    const entityStub = this.env[this.typeVersionConfig.nodeDOEnvNamespace].get(id)
    const response = await requestOutResponseIn(url, options, entityStub)  // TODO: Pass along the cookies
    if (response.status !== expectedResponseCode) {
      if (response.status >= 400) {
        throw new HTTPError(response.content.error.message, response.status, response.content)
      } else {
        throwIf(
          true,  // because we checked for expectedResponseCode above
          `Unexpected response code ${response.status} from call to ${url}`,
          response.status,
          response.content,
        )
      }
    }
    return response
  }

  async hardDeleteDO(idString) {
    debug('hardDeleteDO() called. idString: %s', idString)
    throwIf(idString == null, 'Required parameter, idString, missing from call to hardDeleteDO()')
    const options = {
      method: 'DELETE',
    }
    const url = `http://fake.host/transactional-do-wrapper/${idString}`
    const id = this.env[this.typeVersionConfig.nodeDOEnvNamespace].idFromString(idString)
    const entityStub = this.env[this.typeVersionConfig.nodeDOEnvNamespace].get(id)
    const response = await requestOutResponseIn(url, options, entityStub)  // TODO: Pass along the cookies
    if (response.status >= 400) {
      const { error } = response.content
      throwIf(
        true,
        error?.message || `Unexpected response code ${response.status} from call to ${url}`,
        response.status,
        response.content,
      )
    }
    return response
  }

  // Optimistic concurrency check. If the last validFrom is not the same as before the check, delete the Node DO and throw an error.
  async rollbackDOCreateAndThrowIfConcurrencyCheckFails(lastValidFrom, idString) {
    if (this.entityMeta.timeline?.at(-1) !== lastValidFrom) {  // This should work for both tree/root node creation as well as later node creation
      if (idString != null) {
        this.hardDeleteDO(idString)
      }
      throwIf(true, 'Optimistic concurrency check failed. Retry', 409)
    }
    return true
  }

  static separateTreeAndDeleted(
    nodes,
    edges,
    idNumString = '0',
    tree = {},
    alreadyVisited = {},
    deleted = { id: 'deleted', label: 'Deleted' },
    inDeletedBranch = false,
  ) {
    const node = nodes[idNumString]
    if (!inDeletedBranch) delete nodes[idNumString]  // Checking inDeletedBranch here assures that descendants of deleted nodes that aren't also descendants of an undeleted node will show up in orphaned
    tree.id = node.nodeIDString
    tree.label = node.label
    const childrenArrayOfNumStrings = edges[idNumString]
    if (childrenArrayOfNumStrings != null && childrenArrayOfNumStrings.length > 0) {
      for (const childIdString of childrenArrayOfNumStrings) {
        if (alreadyVisited[childIdString] != null) {
          if (alreadyVisited[childIdString].deleted) {
            deleted.children ??= []
            deleted.children.push(alreadyVisited[childIdString])
          } else {
            tree.children ??= []
            tree.children.push(alreadyVisited[childIdString])
          }
        } else {
          const newNode = {}
          if (nodes[childIdString]?.deleted) {
            deleted.children ??= []
            deleted.children.push(newNode)
            inDeletedBranch = true
          } else {
            tree.children ??= []
            tree.children.push(newNode)
          }
          alreadyVisited[childIdString] = newNode
          this.separateTreeAndDeleted(nodes, edges, childIdString, newNode, alreadyVisited, deleted, inDeletedBranch)
        }
      }
    }
    return { tree, deleted }
  }

  async deriveTree() {
    await this.hydrate()

    if (this.entityMeta.nodeCount === 0) return

    if (this.tree != null) return

    const nodesCopy = structuredClone(this.nodes)
    const { tree, deleted } = Tree.separateTreeAndDeleted(nodesCopy, this.edges)
    // populate orphaned from nodesCopy that is mutated by separateTreeDeletedAndOrphaned and attach to tree if not empty
    const nodesCopyKeys = Object.keys(nodesCopy)
    if (nodesCopyKeys.length > 0) {
      const orphaned = { id: 'orphaned', label: 'Orphaned' }
      // TODO: loop through nodesIndexKeys and add to orphaned

      tree.children ??= []
      tree.children.push(orphaned)
    }
    // attach deleted and orphaned to tree under the root node
    if (deleted.children?.length > 0) {
      tree.children ??= []
      tree.children.push(deleted)
    }
    this.tree = tree
  }

  // Fetch

  async fetch(request) {
    debug('fetch() called with %s %s', request.method, request.url)
    this.warnings = []
    try {
      const url = new URL(request.url)
      const pathArray = url.pathname.split('/').filter((s) => s !== '')

      const restOfPath = `/${pathArray.join('/')}`
      switch (restOfPath) {
        case '/':
          if (this[request.method] != null) return await this[request.method](request)
          return throwIf(true, `Unrecognized HTTP method ${request.method} for ${url.pathname}`, 405)

        case '/entity-meta':  // This doesn't require type or version but this.hydrate may in the future and this calls this.hydrate
          throwUnless(request.method === 'GET', `Unrecognized HTTP method ${request.method} for ${request.url}`, 405)
          // @ts-ignore: It's in temporalMixin
          return await this.GETEntityMeta(request)

        default:
          return throwIf(true, `Unrecognized URL ${url.pathname}`, 404)
      }
    } catch (e) {
      this.hydrated = false  // Makes sure the next call to this DO will rehydrate  TODO: Don't always do this
      this.invalidateDerived()
      return errorResponseOut(e, this.env, this.idString)
    }
  }

  // Handlers

  async post({ rootNodeValue, userID, validFrom, impersonatorID }) {
    throwIf(rootNodeValue == null, 'valid body.rootNodeValue is required when Tree is created')
    throwUnless(userID, 'userID required by Tree operation is missing')

    await this.hydrate()

    throwUnless(this.entityMeta.nodeCount === 0, `POST to create tree can only be called once but nodeCount is ${this.entityMeta.nodeCount}`)

    this.invalidateDerived()

    validFrom = this.calculateValidFrom(validFrom).validFrom
    rootNodeValue.treeIDString = this.idString
    const options = {
      method: 'POST',
      body: { value: rootNodeValue, userID, validFrom, impersonatorID },
    }

    // TODO: wrap this in a try/catch block and retry if the optimistic concurrency check fails
    const lastValidFrom = this.entityMeta.timeline?.at(-1)
    // This next line is going to open the input gate, so we need an optimistic concurrency check. The above line is what we'll check against
    const response = await this.callNodeDO(this.typeVersionConfig.rootNodeType, this.typeVersionConfig.rootNodeVersion, options, 201)
    await this.rollbackDOCreateAndThrowIfConcurrencyCheckFails(lastValidFrom, response.content.idString)

    // Update current but not current.meta because that's done in updateMetaAndSave()
    validFrom = response.content.meta.validFrom  // in case it was changed by the Node DO
    this.nodes = {}
    this.edges = {}
    this.nodes[this.entityMeta.nodeCount] = { label: response.content.value.label, nodeIDString: response.content.idString }

    this.updateMetaAndSave(validFrom, userID, impersonatorID, true)

    return this.get({ statusToReturn: 201 })
  }

  async POST(request) {
    // throwIfMediaTypeHeaderInvalid(request)
    const { content: options } = await requestIn(request)
    const [responseBody, status] = await this.post(options)
    return this.doResponseOut(responseBody, status)
  }

  async patchAddNode({ addNode, userID, validFrom, impersonatorID }) {
    const { value, parent } = addNode
    throwIf(value == null, '{ addNode: { value, parent }, userID, validFrom, impersonatorID } expected when Tree PATCH addNode is called')
    throwUnless(userID, 'userID required by Tree operation is missing')

    await this.hydrate()

    await this.throwIfInvalidID(parent)

    this.invalidateDerived()

    validFrom = this.calculateValidFrom(validFrom).validFrom

    value.treeIDString = this.idString
    const options = {
      method: 'POST',
      body: { value, userID, validFrom, impersonatorID },
    }

    // TODO: wrap this in a try/catch block and retry if the optimistic concurrency check fails
    const lastValidFrom = this.entityMeta.timeline?.at(-1)
    // This next line is going to open the input gate, so we need an optimistic concurrency check. The above line is what we'll check against
    const response = await this.callNodeDO(this.typeVersionConfig.nodeType, this.typeVersionConfig.nodeVersion, options, 201)
    await this.rollbackDOCreateAndThrowIfConcurrencyCheckFails(lastValidFrom, response.content.idString)

    // Update current but not current.meta because that's done in updateMetaAndSave()
    validFrom = response.content.meta.validFrom  // in case it was changed by the Node DO
    this.nodes[this.entityMeta.nodeCount] = { label: response.content.value.label, nodeIDString: response.content.idString }
    this.edges[parent] ??= []
    this.edges[parent].push(this.entityMeta.nodeCount.toString())

    this.updateMetaAndSave(validFrom, userID, impersonatorID, true)

    return this.get()
  }

  /**
   *
   * # patchAddBranch
   *
   * Adds a branch to the tree
   */
  async patchAddBranch({ addBranch, userID, validFrom, impersonatorID }) {
    let { parent, child } = addBranch
    parent = parent.toString()
    child = child.toString()
    throwUnless(parent != null && child != null, 'body.addBranch with parent and child required when Tree PATCH patchBranch is called')
    throwIf(parent === child, 'parent and child cannot be the same')

    await this.hydrate()

    await this.throwIfInvalidID(parent)
    await this.throwIfInvalidID(child)

    if (this.isChildOf(parent, child)) {  // return silently if branch already exists
      return this.get()
    }

    await this.throwIfIDInAncestry(parent, child)

    this.invalidateDerived()

    validFrom = this.calculateValidFrom(validFrom).validFrom

    // Update current but not current.meta because that's done in updateMetaAndSave()
    this.edges[parent] ??= []
    this.edges[parent].push(child)

    this.updateMetaAndSave(validFrom, userID, impersonatorID, false)

    return this.get()
  }

  /**
   *
   * # patchDeleteBranch
   *
   * Deletes a branch from the tree
   */
  async patchDeleteBranch({ deleteBranch, userID, validFrom, impersonatorID }) {
    let { parent, child } = deleteBranch
    parent = parent.toString()
    child = child.toString()
    throwUnless(parent != null && child != null, 'body.deleteBranch with parent and child required when Tree PATCH patchBranch is called')

    await this.hydrate()

    await this.throwIfInvalidID(parent)
    await this.throwIfInvalidID(child)

    if (!this.isChildOf(parent, child)) {  // return silently if branch does not exist
      return this.get()
    }

    this.invalidateDerived()

    validFrom = this.calculateValidFrom(validFrom).validFrom

    // Update current but not current.meta because that's done in updateMetaAndSave()
    this.edges[parent] = this.edges[parent].filter((id) => id !== child)

    this.updateMetaAndSave(validFrom, userID, impersonatorID, false)

    return this.get()
  }

  /**
   *
   * # patchMoveBranch
   *
   * Moves a branch from one place to another in the tree
   */
  async patchMoveBranch({ moveBranch, userID, validFrom, impersonatorID }) {
    let { child, currentParent, newParent } = moveBranch
    currentParent = currentParent.toString()
    newParent = newParent.toString()
    child = child.toString()

    throwIf(
      child == null || currentParent == null || newParent == null,
      'body.moveBranch with child, currentParent, and newParent required when Tree PATCH moveBranch is called',
    )

    await this.hydrate()

    await this.throwIfInvalidID(currentParent)
    await this.throwIfInvalidID(newParent)
    await this.throwIfInvalidID(child)

    await this.throwIfIDInAncestry(newParent, child)

    this.invalidateDerived()

    validFrom = this.calculateValidFrom(validFrom).validFrom

    // Update current but not current.meta because that's done in updateMetaAndSave()
    if (this.isChildOf(currentParent, child)) {
      this.edges[currentParent] = this.edges[currentParent].filter((id) => id !== child)
    }

    if (!this.isChildOf(newParent, child)) {
      this.edges[newParent] ??= []
      this.edges[newParent].push(child)
    }

    this.updateMetaAndSave(validFrom, userID, impersonatorID, false)

    return this.get()
  }

  // eslint-disable-next-line no-unused-vars
  async patch(options) {
    throwUnless(options.userID, 'userID required by Tree PATCH is missing')

    if (options.addNode != null) return this.patchAddNode(options)
    if (options.addBranch != null) return this.patchAddBranch(options)  // does not use If-Modified-Since because it's idempotent
    if (options.deleteBranch != null) return this.patchDeleteBranch(options)  // does not use If-Modified-Since because it's idempotent
    if (options.moveBranch != null) return this.patchMoveBranch(options)  // does not use If-Modified-Since because ???

    return throwIf(
      true,
      'Malformed PATCH on Tree. Body must include valid operation: addNode, branch, etc.',
      400,
    )
  }

  async PATCH(request) {
    const { content: options } = await requestIn(request)
    const [responseBody, status] = await this.patch(options)
    return this.doResponseOut(responseBody, status)
  }

  async get(options) {  // TODO: Accept asOfISOString
    const { statusToReturn = 200, ifModifiedSince, asOfISOString } = options ?? {}
    throwIf(
      ifModifiedSince != null && !dateISOStringRegex.test(ifModifiedSince),
      'If-Modified-Since must be in YYYY:MM:DDTHH:MM:SS.mmmZ format because we need millisecond granularity',
      400,
      this.current,
    )
    await this.hydrate()
    if (this.entityMeta.timeline.at(-1) <= ifModifiedSince) return [undefined, 304]
    await this.deriveTree()
    const result = {
      current: {
        meta: this.current.meta,
        tree: this.tree,
      },
    }
    return [result, statusToReturn]
  }
}
