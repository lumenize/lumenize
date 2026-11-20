<script>

  export let levelConfigAnnotated
  export let percentages
  export let maxFontSize
  export let legendFontColor
  export let sidebarWidth
  export let radarSize
  export let descriptionsInLegend

  export let labelScale = 1
  export let descriptionScale = 1
  export let margin = 2
  export let wrapMargin = .3
  export let statsScale = 1
  export let adjustedStatsDrawingWidth = null
  export let stats = []
  export let showSummaryStats = false

  import { onMount, afterUpdate, beforeUpdate, tick } from 'svelte'

  let legendAnnotated = levelConfigAnnotated
  // $: {  // TODO: Remove this. It was done this way when we had a goal in the legend
  //   let temp = []
  //   for (let level of levelConfigAnnotated) {
  //     temp.push(level)
  //   }
  //   legendAnnotated = temp
  // }

  let startX = radarSize + margin
  let drawingWidth = sidebarWidth - (2 * margin)
  let keyWidth = descriptionsInLegend ? .14 * drawingWidth : 0.3 * drawingWidth
  let keyHeight = (labelScale * 1.9) - (2 * wrapMargin)
  let keyStartX = startX + wrapMargin
  let labelAreaWidth = descriptionsInLegend ? .21 * drawingWidth : 0.7 * drawingWidth
  let labelTextWidth = labelAreaWidth - (2 * margin)
  let labelTextStartX = keyStartX + keyWidth + margin
  let descriptionWidth = descriptionsInLegend ? .65 * drawingWidth : 0
  let descriptionTextWidth = descriptionWidth - (3 * margin)
  let descriptionTextStartX = labelTextStartX + labelAreaWidth + margin
  let dividerX = descriptionTextStartX - 1.5 * margin

  let legendStartY
  $: {
    if (showSummaryStats) {
      legendStartY = (3 * radarSize / 4) - (labelScale * legendAnnotated.length)  // Each row is 2*labelScale
    } else {
      legendStartY = (radarSize / 2) - (labelScale * legendAnnotated.length)
    }
  }

  let statsStartY = (radarSize / 4) - (3 * statsScale * stats.length / 4)  // Each row is 1.5*statsScale
  let statsTextWidth = drawingWidth - 2 * margin

  // These legend sizes are wrong on a first visit. The measurement runs before Roboto
  // Condensed has loaded (and in a production build, before any CSS applies), so getBBox
  // measures a fallback face. Causes 2 and 3 in the comment above Radar.svelte's onMount,
  // which has the numbers and the fix.
  onMount(async () => {
    await tick()  // Allows time to draw the legend with default scale before attempting to get the dimensions of the BBox
    if (labelScale == 1.0) {
      // Set max label and description widths
      let maxLabelWidth = 0
      let maxDescriptionWidth = 0
      for (let level of legendAnnotated) {
        // @ts-ignore
        level.labelWidth = document.getElementById(level.labelID).getBBox().width
        if (level.labelWidth > maxLabelWidth) {
          maxLabelWidth = level.labelWidth
        }
        if (descriptionsInLegend) {
          // @ts-ignore
          level.descriptionWidth = document.getElementById(level.descriptionID).getBBox().width
          if (level.descriptionWidth > maxDescriptionWidth) {
            maxDescriptionWidth = level.descriptionWidth
          }
        }
      }

      // Set label and description font scales
      labelScale = Math.min(maxFontSize, labelTextWidth / maxLabelWidth)
      keyHeight = (labelScale * 1.9) - (2 * wrapMargin)

      if (descriptionsInLegend) {
        descriptionScale = Math.min(labelScale, descriptionTextWidth / maxDescriptionWidth)
      } else {
        descriptionScale = 1  // TODO: Do we even need this since it's the default?
      }
    }

    // Set stats font scale
    if (showSummaryStats && stats?.length > 0 && statsScale == 1.0) {
      // Set max stat width
  
      let maxStatWidth = 0
      for (let stat of stats) {
        let el = document.getElementById(stat.id)
        // @ts-ignore
        maxStatWidth = Math.max(maxStatWidth, el.getBBox().width)
      }
      let tempStatsScale = statsTextWidth / maxStatWidth
      let tempAdjustedStatsDrawingWidth = adjustedStatsDrawingWidth || drawingWidth
      if (tempStatsScale > labelScale) {
        tempStatsScale = labelScale
        tempAdjustedStatsDrawingWidth = maxStatWidth * tempStatsScale + 2 * margin
      }

      statsScale = tempStatsScale
      adjustedStatsDrawingWidth = tempAdjustedStatsDrawingWidth
    }

  })

</script>


<svelte:options namespace="svg"/>
<g>
  <!-- Summary Stats Table -->
  {#if showSummaryStats && stats?.length > 0}
    <rect rx={margin} ry={margin} x={startX} y={statsStartY-margin} height={stats.length*statsScale*1.5+2*margin} width={adjustedStatsDrawingWidth||drawingWidth} fill="#184738" stroke="none" />
    {#each stats as stat, i}
      <text id={stat.id} x={startX+margin} y={statsStartY+i*1.5*statsScale+statsScale} font-size={statsScale} text-anchor="left" fill={legendFontColor}>
        {stat.label}
      </text>
    {/each}
  {/if}

  <!-- Legend -->
  {#each legendAnnotated as level, i}
    {#if level._entityID}
      <!-- legend row oval -->
      <rect rx={labelScale*1.9/2} ry={labelScale*1.9/2} x={startX} y={legendStartY+i*2*labelScale} height={labelScale*1.9} width={drawingWidth} fill="#184738" stroke="none" />
      <!-- key oval -->
      <rect rx={keyHeight/2} ry={keyHeight/2} x={keyStartX} y={legendStartY+i*2*labelScale+wrapMargin} height={keyHeight} width={keyWidth} fill={level.color} stroke="none" />
      <!-- percent text -->
      <text x={keyStartX+keyWidth/2} y={legendStartY+i*2*labelScale+1.25*labelScale} font-size={labelScale} text-anchor="middle" fill={level.textColor}>
        {percentages[level._entityID].percentage}%
      </text>
      <!-- label text -->
      <text id={level.labelID} x={labelTextStartX} y={legendStartY+i*2*labelScale+1.25*labelScale} font-size={labelScale} text-anchor="left" fill={legendFontColor}>
        {level.label}
      </text>
      {#if descriptionsInLegend}
        <!-- divider -->
        <line x1={dividerX} y1={legendStartY+i*2*labelScale+2*wrapMargin} x2={dividerX} y2={legendStartY+(i+1)*2*labelScale-2*wrapMargin-0.1*labelScale} stroke="white" stroke-width={labelScale/12} stroke-dasharray="{labelScale/12} {labelScale/6}"/>
        <!-- description text -->
        <text id={level.descriptionID} x={descriptionTextStartX} y={legendStartY+i*2*labelScale+labelScale+0.25*descriptionScale} font-size={descriptionScale} text-anchor="left" fill={legendFontColor}>
          {level.description}
        </text>
      {/if}
    {:else}
      <!-- legen row oval -->
      <rect rx={labelScale*1.9/2} ry={labelScale*1.9/2} x={startX} y={legendStartY+i*2*labelScale} height={labelScale*1.9} width={drawingWidth} fill="#DDDDDD" stroke="none" />
      <!-- label text -->
      <text id={level.labelID} x={labelTextStartX} y={legendStartY+i*2*labelScale+1.25*labelScale} font-size={labelScale} text-anchor="left" fill="#184738">
        {level.label}
      </text>
      {#if descriptionsInLegend}
        <!-- divider -->
        <line x1={dividerX} y1={legendStartY+i*2*labelScale+2*wrapMargin} x2={dividerX} y2={legendStartY+(i+1)*2*labelScale-2*wrapMargin-0.1*labelScale}
            stroke="#184738" stroke-width={labelScale/12} stroke-dasharray="{labelScale/12} {labelScale/6}"/>
        <!-- description text -->
        <text id={level.descriptionID} x={descriptionTextStartX} y={legendStartY+i*2*labelScale+labelScale+0.25*descriptionScale}
            font-size={descriptionScale} text-anchor="left" fill="#184738">
          {level.description}
        </text>
      {/if}
    {/if}
  {/each}
</g>

<style>
  text {
    font-family: 'Roboto Condensed', sans-serif;
    font-weight: 300;
    letter-spacing: 0;
  }
</style>

