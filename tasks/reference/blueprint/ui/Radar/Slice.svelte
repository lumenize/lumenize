<script>
  export let centerX
  export let centerY
  export let startRadians
  export let endRadians
  export let innerRadius
  export let outerRadius
  export let assessmentData
  export let label
  export let description
  export let labelBandHeight
  export let stroke
  export let strokeWidth
  export let teamArcStrokeWidth
  export let fontColor
  export let fontSize

  import Arc from './Arc.svelte'
  import { createEventDispatcher } from 'svelte'
  const dispatch = createEventDispatcher()

  let dataOuterRadius = outerRadius - labelBandHeight

</script>


<svelte:options namespace="svg"/>
<g>

  <!-- Assessment Data Arcs -->
  {#each assessmentData as assessment}
    <Arc
      on:mouseover={(e) => dispatch('assessment-mouseover', {originalEvent: e, assessment})}
      on:mouseout={(e) => dispatch('assessment-mouseout', {originalEvent: e, assessment})}
      on:click={(e) => dispatch('assessment-click', {originalEvent: e, assessment})}
      on:dblclick={(e) => dispatch('assessment-dblclick', {originalEvent: e, assessment})}
      centerX={centerX} centerY={centerY}
      startRadians={startRadians} endRadians={endRadians}
      innerRadius={assessment.innerRadius} outerRadius={assessment.outerRadius}
      fill={assessment.color} opacity={assessment.opacity} 
      stroke={stroke} strokeWidth={teamArcStrokeWidth}
      teamID={assessment.teamID}
    />
  {/each}

  <!-- Data Area Arc -->
  <Arc
    centerX={centerX} centerY={centerY} 
    startRadians={startRadians} endRadians={endRadians}
    innerRadius={innerRadius} outerRadius={dataOuterRadius}
    strokeWidth={strokeWidth} stroke={stroke} fill="none"
  />

  <!-- Label Arc -->
  <Arc
    centerX={centerX} centerY={centerY} 
    startRadians={startRadians} endRadians={endRadians}
    innerRadius={dataOuterRadius} outerRadius={outerRadius}
    fontColor={fontColor} fontSize={fontSize} 
    strokeWidth={strokeWidth} stroke={stroke} fill="#FFFFFF"
    label={label} description={description}
  />

</g>
