<script>

  export let centerX
  export let centerY
  export let startRadians
  export let endRadians
  export let innerRadius
  export let outerRadius
  export let stroke
  export let strokeWidth

  export let id = nanoid()
  export let opacity = 1
  export let label = ''
  export let description = ''
  export let fontColor = '#FFFFFF'
  export let fontSize = 1
  export let fill = 'none'
  export let teamID = null

  import { getArcEnds } from './arc-translators'
  import { nanoid } from 'nanoid'
  import { createEventDispatcher } from 'svelte'
  const dispatch = createEventDispatcher()

  let middleRadians = (startRadians + endRadians) / 2

  // pointerEvents: ({description}) => description ? "all" : "none",
  let pointerEvents = (fill && !(fill==="none")) ? "all" : "none"

  // For the actual arc area
  let innerArcEnds = getArcEnds(innerRadius, centerX, centerY, startRadians, endRadians)
  let outerArcEnds = getArcEnds(outerRadius, centerX, centerY, startRadians, endRadians)

  let arcSweep = (endRadians - startRadians <= Math.PI) ? "0" : "1"  // TODO: Move to arc-translators

  // For the line to draw the Label
  let pMRadius = (innerRadius + outerRadius) / 2
  let labelArcEnds = getArcEnds(pMRadius, centerX, centerY, startRadians, endRadians)

</script>

<svelte:options namespace="svg"/>
<g>
  <defs>

    {#if (middleRadians > Math.PI / 2) && (middleRadians < 3 * Math.PI / 2)}
      <path
        id={id}
        d="
          M {labelArcEnds.p2x} {labelArcEnds.p2y}
          A {pMRadius} {pMRadius} 1 {arcSweep} 0 {labelArcEnds.p1x} {labelArcEnds.p1y}
        "
      />
    {:else}
      <path
        id={id}
        d="
          M {labelArcEnds.p1x} {labelArcEnds.p1y}
          A {pMRadius} {pMRadius} 0 {arcSweep} 1 {labelArcEnds.p2x} {labelArcEnds.p2y}
        "
      />
    {/if}

  </defs>

  <!-- svelte-ignore a11y-mouse-events-have-key-events -->
  <path
    pointer-events={pointerEvents}
    on:mouseover={(e) => dispatch('mouseover', e)}
    on:mouseout={(e) => dispatch('mouseout', e)}
    on:click={(e) => {
      if (teamID) e.stopPropagation()
      dispatch('click', e)
    }}
    on:dblclick={(e) => dispatch('dblclick', e)}
    fill={fill} opacity={opacity}
    stroke={stroke} stroke-width={strokeWidth} stroke-linecap="square"
    d="
      M {innerArcEnds.p1x} {innerArcEnds.p1y}
      A {innerRadius} {innerRadius} 0 {arcSweep} 1 {innerArcEnds.p2x} {innerArcEnds.p2y}
      L {outerArcEnds.p2x} {outerArcEnds.p2y}
      A {outerRadius} {outerRadius} 1 {arcSweep} 0 {outerArcEnds.p1x} {outerArcEnds.p1y}
      Z
    "
  >
    {#if (description)}
      <title>{description}</title>
    {/if}
  </path>

  <text pointer-events="none" font-size={fontSize}>
    <textPath xlink:href="#{id}" dominant-baseline="middle" text-anchor="middle" startOffset="50%" fill={fontColor}>
      {label}
    </textPath>
  </text>

</g>


<style>
  text {
    font-family: 'Roboto Condensed', sans-serif;
    font-weight: 300;
    letter-spacing: 0;
  }
</style>
