
<script>
  
  export let tree
  // export let handleNodeChosen  // Using a callback because the event approach was ugly with the recursion TODO: Consider switching this to a store now that this contains both expanded and collapsed modes
  export let chosenBreadcrumbsArrayStore

  import TreeNode from './TreeNode.svelte'
  import BreadcrumbsPanel from './BreadcrumbsPanel.svelte'

  import chevronLeft from 'svelte-awesome/icons/chevron-left'
  import close from 'svelte-awesome/icons/close'
  import Icon from 'svelte-awesome'
  import { tick } from 'svelte'

  function highlightSearchText(node, searchString) {
    if (searchString.length === 0 || node.alreadyHighlighted) return
    node.labelHighlighted = node.label.replace(new RegExp(searchString, 'gi'), '<strong>$&</strong>')
    node.alreadyHighlighted = true
  }
  
  function expandNodeAndAncestors(node) {
    if (node) {
      node.expanded = true
      if (node.parents) {
        for (let parent of node.parents) {
          expandNodeAndAncestors(parent)
        }
      }
    }
  }

  function highlightNode(node) {
    highlightSearchText(node, searchString)
    expandNodeAndAncestors(node)
  }

  function markTree(node, searchString) {  // makes search text <strong> and expands the node and ancestors
    if (searchString?.length > 0 && node.label.toLowerCase().includes(searchString)) highlightNode(node)  // TODO: Allow specification of multiple fields to search
    if (node.children?.length > 0) {
      for (let child of node.children) {
        markTree(child, searchString)
      }
    }    
  }

  function stitchParents(node, parent = null) {
    if (parent) {
      node.parents = node.parents || []
      node.parents.push(parent)
    }
    if (node.children?.length > 0) {
      for (let child of node.children) {
        stitchParents(child, node)
      }
    }  
  }
  stitchParents(tree, null)  // TODO: Store it with parents already stitched

  let minimumPanelHeight = 500
  function updatePanelHeight() {
    minimumPanelHeight = Math.max(500, document.getElementById('hidden-breadcrumbs-box')?.getBoundingClientRect()?.width + 40)
  }

  function collapseAllNodes(node) {
    node.expanded = (node.id === 'root')
    if (node.children?.length > 0) {
      for (const child of node.children) {
        collapseAllNodes(child)
      }
    }
  }

  let panelCollapsed = false
  async function collapsePanel() {
    searchString = ''
    panelCollapsed = true
    await tick()
    updatePanelHeight()
  }

  function expandTreeToChosen(node, breadcrumbsArray, level = 0) {
    const targetID = breadcrumbsArray[level]?.id
    if (!targetID || level >= breadcrumbsArray.length - 1) return
    if (node.id === targetID) {
      node.expanded = true
      if (level < breadcrumbsArray.length - 1 && node.children?.length > 0) {
        for (const child of node.children) {
          expandTreeToChosen(child, breadcrumbsArray, level + 1)
        } 
      } else {
        return
      }
    } 
  }

  function expandPanel() {
    collapseAllNodes(preparedTree)
    expandTreeToChosen(preparedTree, $chosenBreadcrumbsArrayStore)
    panelCollapsed = false
  }

  let searchString = ''
  function clearSearch() {
    searchString = ''
  }

  let treeCopy
  let preparedTree
  $: {
    searchString = searchString.toLowerCase()
    treeCopy = structuredClone(tree)  // Works with circular references which means it should also work with a DAG
    collapseAllNodes(treeCopy)
    if (searchString.length > 0) {
      markTree(treeCopy, searchString)
    } else {
      expandTreeToChosen(treeCopy, $chosenBreadcrumbsArrayStore)
    }
    preparedTree = treeCopy
  }

  function handleNodeChosen(breadcrumbsArray) {
    $chosenBreadcrumbsArrayStore = breadcrumbsArray
    collapsePanel()
  }

</script>

{#if panelCollapsed}

  <!-- Breadcrumbs panel -->
  <div class='breadcrumbs-panel' style="min-height: {minimumPanelHeight}px;" on:click={expandPanel} >
    <BreadcrumbsPanel handleNodeChosen={handleNodeChosen} chosenBreadcrumbsArray={$chosenBreadcrumbsArrayStore} hidden />
    <BreadcrumbsPanel handleNodeChosen={handleNodeChosen} chosenBreadcrumbsArray={$chosenBreadcrumbsArrayStore} />
  </div>

{:else}

  <!-- Tree panel -->
  <div class='flex flex-column tree-panel' style="min-height: {minimumPanelHeight}px;">

    <!-- Search bar -->
    <div id="search-bar" class="flex flex-row items-center">
      <div id="search-bubble" class="mis8 mbs8 mbe8 flex flex-fill items-center">
        <input id="search-input" type="text" class="flex-fill p4 pis8 focus-link" placeholder="Search" bind:value={searchString} />
        <button id="clear-search" on:click={clearSearch} class="flex inherit-colors">
          <Icon data={close} class="m8" />
        </button>
      </div>
      <button id="collapse-tree" on:click={(e) => collapsePanel()} class="flex inherit-colors">
        <Icon scale={1.0} data={chevronLeft} class="m8" />
      </button>
    </div>

    <!-- Tree -->
    <!-- Using a callback because an event is ugly with the recursion, and a store only updates if the user selects a different node  -->
    <div class="m8">
      <TreeNode
        node={ preparedTree }
        expanded={ true }
        handleNodeChosen={handleNodeChosen}
        chosenBreadcrumbsArray={$chosenBreadcrumbsArrayStore}
      />
    </div>

  </div>

{/if}


<style>

  .tree-panel {
    /* padding: 0px; */
    background-color: var(--agnostic-dark);
    color: var(--agnostic-primary-light);
    min-width: 400px;
  }

  .breadcrumbs-panel {
    background-color: var(--agnostic-dark);
    color: var(--agnostic-primary-light);
    width: 56px; 
    cursor: pointer;
  }

  #search-bar {
    background-color: var(--agnostic-gray-dark);
  }

  #search-bubble {
    background-color:var(--agnostic-gray-mid-dark);
  }

  #search-input {
    margin-top: 0px;
    background-color:var(--agnostic-gray-mid-dark);
    border-radius: 4px;
    border: 0px;
    color: var(--agnostic-primary-light);
  }

  #collapse-tree {
    color: var(--agnostic-primary-light);
    background-color: inherit;
    border: 0px;
  }

  /* Focusing the button with a keyboard will show a focus ring. */
  .focus-link:focus-visible {
    outline: 3px var(--agnostic-primary-light);
  }
  
  /* Focusing the button with a mouse, touch, or stylus will make it look like a button is down. */
  .focus-link:focus:not(:focus-visible) {
    outline: 0px;
    box-shadow: inset 1px 1px 5px black;
  }

</style>
