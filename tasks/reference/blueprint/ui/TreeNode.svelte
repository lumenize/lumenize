
<script>

  export let node  // a TreeNode
  export let handleNodeChosen  // Using a callback because the event approach was ugly with the recursion 
  export let chosenBreadcrumbsArray
  export let parentBreadcrumbsArray = []
  export let expanded

  import { slide } from 'svelte/transition'
  import Icon from 'svelte-awesome'
  import caretRight from 'svelte-awesome/icons/caret-right'
  import caretDown from 'svelte-awesome/icons/caret-down'

  function toggle(e, node) {
    e.stopPropagation()
    node.expanded = !node.expanded
    expanded = node.expanded
  }

  function clickTreeNode(e, node) {
    handleNodeChosen(getNewBreadcrumbsArray(parentBreadcrumbsArray, node))
  }

  function getNewBreadcrumbsArray(breadcrumbsArray, node) {
    const newArray = [...breadcrumbsArray]
    newArray.push(node)
    return newArray
  }

  function breadcrumbsEqual(a, b) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id) return false
    }
    return true
  }

</script>


{#if node.id !== 'root'}
  <div class="flex">
    <div class="link toggle" on:click={(e) => toggle(e, node)}>
      {#if node.children?.length > 0}
        <Icon data={expanded ? caretDown : caretRight} />
      {/if}
    </div>
    <div on:click={(e) => clickTreeNode(e, node)} class="link">
      <div class:chosen={breadcrumbsEqual(chosenBreadcrumbsArray, getNewBreadcrumbsArray(parentBreadcrumbsArray, node))} >
        {@html node.labelHighlighted || node.label}
      </div>
    </div>
  </div>
{/if}

{#if (expanded) && node.children}
  <ul>
    {#each node.children as child}
      <!-- No out to prevent a stutter when the tree collapses -->
      <li style="padding-left: {node.id === 'root' ? 0 : 1.5}rem;" in:slide>
        <svelte:self 
          node={child}         
          handleNodeChosen={handleNodeChosen}
          chosenBreadcrumbsArray={chosenBreadcrumbsArray}
          parentBreadcrumbsArray = {getNewBreadcrumbsArray(parentBreadcrumbsArray, node)}
          expanded={child.expanded}
        />
      </li>
    {/each}
  </ul>
{/if}


<style>

  .chosen {
    color: var(--agnostic-primary-hover);
  }

  .link:hover {
    color: var(--agnostic-primary-hover);
    cursor: pointer;
  }

  .toggle {
    width: 1.5rem;
  }

</style>
