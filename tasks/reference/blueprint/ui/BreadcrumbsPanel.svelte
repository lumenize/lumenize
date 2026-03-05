
<script>
  export let chosenBreadcrumbsArray = []
  export let handleNodeChosen
  export let hidden = false
</script>

<div id="{hidden ? "hidden-" : ""}breadcrumbs-box" class:rotated={!hidden} class:offscreen={hidden}>
  <div id="{hidden ? "hidden-" : ""}breadcrumbs" class="breadcrumbs">
    {#each chosenBreadcrumbsArray as node}
      {#if node.id !== 'root'}
        {#if chosenBreadcrumbsArray.indexOf(node) < chosenBreadcrumbsArray.length - 1}
          <span class="link" on:click={(e) => {
            e.stopPropagation()
            handleNodeChosen(chosenBreadcrumbsArray.slice(0, chosenBreadcrumbsArray.indexOf(node) + 1))
          }}>
            {node.label}
          </span>
          <!-- <Icon scale={0.7} data={chevronRight} /> -->
          <span class="breadcrumb-separator"> > </span>
        {:else}
          &nbsp;
        {/if}
      {/if}
    {/each}
  </div>
  <div id="{hidden ? "hidden-" : ""}breadcrumb-name">
    {chosenBreadcrumbsArray.length > 0 ? chosenBreadcrumbsArray[chosenBreadcrumbsArray.length - 1].label : ''}
  </div>
</div>


<style>

  .link:hover {
    color: var(--agnostic-primary-hover);
    cursor: pointer;
  }

  .offscreen {
    transform: translate(-100000px, -100000px);
    position: absolute;
  }

  .rotated { 
    /* overflow: hidden; */
    /* text-overflow: ellipsis; */
    white-space: nowrap;
    /* display: block; */
    width: 100%;
    /* min-width: 500px; */
    transform: rotate(90deg) translate(-20px, 0px);
    transform-origin: 8px 100%;
  }

  #breadcrumb-name {
    font-size: 1.1rem;
  }

  .breadcrumbs {
    font-size: .7rem;
  }

  .breadcrumb-separator {
    font-weight: 800;
    margin-left: 6px;
    margin-right: 6px;
  }

</style>
