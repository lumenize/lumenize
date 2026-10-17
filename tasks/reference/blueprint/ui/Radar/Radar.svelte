<script lang="ts">
  export let teams
  export let levelConfig
  export let assessmentData
  export let disciplines

  export let _logoBackgroundColor = "#FFFFFF"
  export let identifyingData: unknown = null
  export let title: string|null = null
  export let subTitle: string|null = null
  export let titleHeight = 10
  export let showLogo = true
  export let innerRadius = 10
  export let radarSize = 100  // height and width
  export let showSidebar = true
  export let sidebarWidth = 60
  if (! showSidebar) sidebarWidth = 0
  export let descriptionsInLegend = true
  export let showSummaryStats = true
  export let practiceStroke = "#999999"
  export let disciplineStroke = "#555555"
  export let strokeWidth = 0.15
  export let baseColor = "#2E8468"
  export let fontColor = "#22644E"
  export let practiceFontSize = 1
  export let disciplineFontSize = 1
  export let highlightedTeamID: string|null = null
  export let lockHighlight = false
  export let legendFontColor = "#FFFFFF"
  export let diciplineFontColor = "#184738"

  import sortOn from "sort-on"
  import { onMount } from 'svelte'

  import { nanoid } from "nanoid"
  import { getBackgroundAndTextColor } from "./color-utils"
  import Slice from './Slice.svelte'
  import Arc from './Arc.svelte'
  import Sidebar from './Sidebar.svelte'
  
  import type { Level, Practice, Discipline, Team } from './types'

  function clearHighlight() {
    lockHighlight = false
    highlightedTeamID = null
    titleAsShown = title
    subTitleAsShown = subTitle
    const event = new CustomEvent('clear-highlight', {
      detail: {identifyingData},
      bubbles: true,
      cancelable: true,
      composed: true, // makes the event jump shadow DOM boundary
    })
    // this.options.target.dispatchEvent(event)
    document.dispatchEvent(event)  // TODO: Figure out how to dispatch to the actual Radar. Line above works in testing but not for Comcast
  }

  function teamHighlight(teamID: string) {
    titleAsShown = lookupTeamByID[teamID].label
    subTitleAsShown = title
    highlightedTeamID = teamID
    const event = new CustomEvent('team-highlight', {
      detail: {teamID, identifyingData},
      bubbles: true,
      cancelable: true,
      composed: true, // makes the event jump shadow DOM boundary
    })
    // this.options.target.dispatchEvent(event)
    document.dispatchEvent(event)  // TODO: Figure out how to dispatch to the actual Radar. Line above works in testing but not for Comcast
  }

  function assessmentMouseover(e: CustomEvent) {
    if (! lockHighlight) {
      teamHighlight(e.detail.assessment.teamID)
    }
  }

  function assessmentMouseout(e: CustomEvent) {
    if (! lockHighlight) {
      clearHighlight()
    }
  }

  function assessmentClick(e: CustomEvent) {
    // e.detail.originalEvent.stopPropagation()
    const clickedTeamID = e.detail.assessment.teamID
    if (clickedTeamID == highlightedTeamID) {
      lockHighlight = true
    } else {
      clearHighlight()
      teamHighlight(clickedTeamID)
      lockHighlight = true
    }
    const event = new CustomEvent('team-lock', {
      detail: {assessment: e.detail.assessment, identifyingData},
      bubbles: true,
      cancelable: true,
      composed: true, // makes the event jump shadow DOM boundary
    })
    // this.options.target.dispatchEvent(event)
    document.dispatchEvent(event)  // TODO: Figure out how to dispatch to the actual Radar. Line above works in testing but not for Comcast
  }

  function assessmentDblclick(e: CustomEvent) {
    e.detail.originalEvent.stopPropagation()
    const event = new CustomEvent('team-practice-drilldown', {
      detail: {assessment: e.detail.assessment, identifyingData},
      bubbles: true,
      cancelable: true,
      composed: true, // makes the event jump shadow DOM boundary
    })
    // this.options.target.dispatchEvent(event)
    document.dispatchEvent(event)  // TODO: Figure out how to dispatch to the actual Radar. Line above works in testing but not for Comcast
  }

  let titleAsShown = title
  let subTitleAsShown = subTitle

  // @ts-ignore
  let viewBoxStartY = (title?.length > 0 || subTitle?.length > 0) ? -1 * titleHeight : 0
  // @ts-ignore
  let viewBoxHeight = (title?.length > 0 || subTitle?.length > 0) ? radarSize + titleHeight : radarSize
  let vhPercent = 100 * (viewBoxHeight / (viewBoxHeight - viewBoxStartY) - 0.05) 
  let centerXViewBox = (radarSize + sidebarWidth) / 2
  let centerX = radarSize / 2
  let centerY = radarSize / 2
  let outerRadius = radarSize / 2 - 0.5

  let disciplineBandHeight = 0.07 * radarSize
  let practiceBandHeight = 0.06 * radarSize

  let practiceCount: number = 0
  let sliceWidth: number
  let disciplineMaxWidth: number
  let practiceMaxWidth: number
  $: {
    practiceCount = 0
    for (let discipline of disciplines) {
      practiceCount += discipline.practices.length
    }
    sliceWidth = Math.PI * 2 / practiceCount
    disciplineMaxWidth = 0.95 * sliceWidth * (outerRadius - disciplineBandHeight / 2)
    practiceMaxWidth = 0.95 * sliceWidth * (outerRadius - disciplineBandHeight - practiceBandHeight / 2)
  }

  let teamArcStrokeWidth = (teams.length < 15) ? strokeWidth : strokeWidth / (teams.length / 15)

  let disciplineMaxHeight = 0.80 * disciplineBandHeight
  let practiceMaxHeight = 0.80 * practiceBandHeight

  let levelConfigAnnotated: Level[]
  $: {
    let temp = []
    let baseColorCount = 0
    for (let level of levelConfig) {
      if (! level.color)
        baseColorCount++
    }
    let i = 0
    for (let level of levelConfig) {
      let rawColor = level.color || baseColor
      let alpha = 1
      if (! level.color) {
        alpha = (baseColorCount - i - 1) / (baseColorCount - 1)
      }
      if (! level.description || ! descriptionsInLegend) {
        level.description = ""
      }
      level.color = getBackgroundAndTextColor(rawColor, alpha).bgColor
      level.textColor = getBackgroundAndTextColor(rawColor, alpha).textColor
      level.labelID = nanoid()
      level.descriptionID = nanoid()
      level.levelIndex = i
      temp.push(level)
      i++
    }
    levelConfigAnnotated = temp
  }

  let lookupLevelByID: Record<string, Level>
  $: {
    let lookup: Record<string, Level> = {}
    for (let level of levelConfigAnnotated) {
      lookup[level["_entityID"]] = level
    }
    lookupLevelByID = lookup
  }

  let lookupTeamByID: Record<string, Team>
  $: {
    let lookup: Record<string, Team> = {}
    let i = 0
    for (let team of teams) {
      team.assessmentData = []
      team.teamIndex = i
      lookup[team["_entityID"]] = team
      i++
    }
    lookupTeamByID = lookup
  }

  let lookupPracticeByID: Record<string, Practice>
  $: {
    let lookup: Record<string, Practice> = {}
    for (let discipline of disciplines) {
      for (let practice of discipline.practices) {
        lookup[practice["_entityID"]] = practice
      }
    }
    lookupPracticeByID = lookup
  }

  let disciplinesAnnotated: Discipline[]
  $: {
    let temp = disciplines  // TODO: Maybe I should make a deep copy because this actually modifies the disciplines
    let currentAngle = 0

    for (let discipline of disciplines) {
      discipline.id = nanoid()
      discipline.startRadians = currentAngle
      for (let practice of discipline.practices) {
        practice.assessmentData = []
        lookupPracticeByID[practice["_entityID"]] = practice
        practice.id = nanoid()
        practice.startRadians = currentAngle
        currentAngle += sliceWidth
        practice.endRadians = currentAngle
      }
      discipline.endRadians = currentAngle
    }

    // Populate assessmentData inside each practice and team
    for (let row of assessmentData) {
      let level = lookupLevelByID[row.levelID]
      row.levelIndex = level.levelIndex
      if (! highlightedTeamID || row.teamID === highlightedTeamID) {
        row.color = level.color
      } else {
        row.color = "#333333"
      }
      row.opacity = 1
      let team = lookupTeamByID[row.teamID]
      row.teamIndex = team.teamIndex
      let practice = lookupPracticeByID[row.practiceID]
      if (practice) {
        practice.assessmentData.push(row)
        team.assessmentData.push(row)
      }
    }
    // Sort the assessmentData levelIndex and then teamIndex. Calculate inner and outer radius for each assessmentData row.
    for (let practiceID in lookupPracticeByID) {
      let practice: Practice = lookupPracticeByID[practiceID]
      practice.assessmentData = sortOn(practice.assessmentData, ['levelIndex', 'teamIndex'])
      let r = innerRadius
      let arcHeight = (outerRadius - practiceBandHeight - disciplineBandHeight - innerRadius) / practice.assessmentData.length
      for (let row of practice.assessmentData) {
        row.innerRadius = r
        row.outerRadius = r + arcHeight
        r += arcHeight
      }

    }
    disciplinesAnnotated = temp
  }

  let percentages: Record<string, {count: number, percentage?: number}>
  $: {
    let temp: Record<string, {count: number, percentage?: number}> = {}
    for (let levelID in lookupLevelByID) {
      temp[levelID] = {count: 0}
    }
    let data
    if (highlightedTeamID) {
      data = assessmentData.filter((row: {teamID: string}) => (row.teamID == highlightedTeamID) ? true : false)
    } else {
      data = assessmentData
    }
    let total = 0
    for (let row of data) {
      if (lookupPracticeByID[row.practiceID]) {
        temp[row.levelID].count++
        total++
      }
    }
    for (let levelID in temp) {
      temp[levelID].percentage = Math.round(100 * temp[levelID].count / total)
    }
    percentages = temp
  }

  let stats: {label: string, id: string}[]
  $: {
    let notAssessedCount = 0
    let partiallyAsssessedCount = 0
    let fullyAssessedCount = 0

    for (let team of teams) {
      let assessedCount = 0
      for (let row of team.assessmentData) {
        if (! lookupLevelByID[row.levelID].considerNotAssessed) {
          assessedCount++
        }
      }
      team.assessedCount = assessedCount
      if (assessedCount == 0) {
        notAssessedCount++
      } else if (assessedCount < practiceCount) {
        partiallyAsssessedCount++
      } else {
        fullyAssessedCount++
      }
    }
    stats = [ 
      {label: `${teams.length} teams identified`, id: "stat1"},
      {label: `${fullyAssessedCount} (${Math.round(100*fullyAssessedCount/teams.length)}%) fully assessed`, id: "stat2"},
      {label: `${partiallyAsssessedCount} (${Math.round(100*partiallyAsssessedCount/teams.length)}%) partially assessed`, id: "stat3"},
      {label: `${notAssessedCount} (${Math.round(100*notAssessedCount/teams.length)}%) not assessed`, id: "stat4"},
    ]
  }

  /**
   * Sizes the ring's labels to fit their slots, and gets it wrong (measured 2026-10-09).
   * The formula is sound: width scales with font-size to within about 0.1% between sizes
   * 1 and 100. The widths fed to it are not, for three reasons:
   *
   * 1. The wrong font, on every load. The measuring <text dy="-100"> elements below are
   *    styled by this component, which sets no font-family, so they get the page's
   *    DM Sans 400. The labels render through Arc.svelte in Roboto Condensed 300, but
   *    Svelte scopes Arc's `text` rule to Arc. Measured widths run 1.14-1.24x too wide,
   *    varying by string, so on the landing page practice labels render at 3.22 where
   *    true widths give 3.8, and the widest fills 81% of its slot instead of 95%.
   * 2. Fonts still loading. onMount runs before Google Fonts delivers the face, so
   *    getBBox measures a fallback. Sidebar.svelte, which does style its own text, shows
   *    this one alone: legend labels render at 2.37 on a first visit and 2.68 after.
   * 3. CSS not applied yet. In a production build on a first visit this runs about 60 ms
   *    in, before the route's stylesheet applies, so everything measures in Times. The
   *    ring renders at 3.55 there and at 3.22 on a repeat visit.
   *
   * All three make labels too small, never too large, by an amount that changes per
   * string, per cache state, and between dev and production. No constant factor can
   * cancel that.
   *
   * The fix is to measure in the font that renders, after that face has loaded. Awaiting
   * document.fonts.load('300 1px "Roboto Condensed"') is not enough by itself: in case 3
   * it resolves with zero faces, because the @font-face rule is not registered yet.
   * Register the face first (an @font-face in app.html, or the FontFace API), then
   * measure on a canvas: with ctx.font = '300 100px "Roboto Condensed"',
   * ctx.measureText(label).width / 100 matches getBBox at font-size 1 to within 0.1%,
   * with no hidden elements and no mounted DOM.
   *
   * Reproduce with tasks/reference/blueprint/ui/Radar/measure-labels.mjs in
   * github.com/lumenize/lumenize.
   */
  onMount(() => {
    let maxPracticeWidth = 0
    let maxPracticeHeight = 0
    let maxDisciplineWidth = 0
    let maxDisciplineHeight = 0

    for (let discipline of disciplinesAnnotated) {
      // @ts-ignore
      maxDisciplineWidth = Math.max(maxDisciplineWidth, document.getElementById(discipline.id).getBBox().width)
      // @ts-ignore
      maxDisciplineHeight = Math.max(maxDisciplineHeight, document.getElementById(discipline.id).getBBox().height)
      for (let practice of discipline.practices) {
        // @ts-ignore
        maxPracticeWidth = Math.max(maxPracticeWidth, document.getElementById(practice.id).getBBox().width)
        // @ts-ignore
        maxPracticeHeight = Math.max(maxPracticeHeight, document.getElementById(practice.id).getBBox().height)
      }
    }

    const margin = 0.05  // Leave this much of the space unused
    const multiplier = 1 + margin
    maxPracticeWidth *= multiplier
    maxPracticeHeight *= multiplier
    maxDisciplineWidth *= multiplier
    maxDisciplineHeight *= multiplier

    disciplineFontSize = Math.min(disciplineMaxWidth / maxDisciplineWidth, disciplineMaxHeight / maxDisciplineHeight)  
    practiceFontSize = Math.min(disciplineFontSize, practiceMaxWidth / maxPracticeWidth, practiceMaxHeight / maxPracticeHeight)

  })

</script>

<svelte:options namespace="svg"/>
<svg 
  version="1.1" on:click={clearHighlight} 
  viewBox="0 {viewBoxStartY} {radarSize+sidebarWidth} {viewBoxHeight}" 
  preserveAspectRatio="xMidYMin meet"
  style="
    max-height: {vhPercent}vh;
    max-width: 100vw;
  "
>

  <!-- Transformation.dev Blueprint logo -->
  {#if showLogo}
    <circle cx={centerX} cy={centerY} r={innerRadius} fill={_logoBackgroundColor} />
    <image 
      href="/transformation-logo-large-black-for-on-white.png"
      height={innerRadius * 1.8} width={innerRadius * 1.8} 
      x={centerX} y={centerY}
      transform="translate({innerRadius * -0.9}, {innerRadius * -0.9})"
    />
  {/if}

  {#if titleAsShown}
    <text text-anchor="middle" x={centerXViewBox} y={-2*titleHeight/4} font-size=5 fill={fontColor} font-weight="bold">
      {titleAsShown}
    </text>
  {/if}
  {#if subTitleAsShown}
    <text text-anchor="middle" x={centerXViewBox} y={-1*titleHeight/8} font-size=3 fill={fontColor}>
      {subTitleAsShown}
    </text>
  {/if}

  {#each disciplinesAnnotated as discipline}
    <!-- Discipline labels for measuring scale -->
    <text dy="-100" id={discipline.id} font-size={disciplineFontSize}>
      {discipline.label}
    </text>

    {#each discipline.practices as practice}
      <!-- Practice labels for measuring scale -->
      <text dy="-100" id={practice.id} font-size={practiceFontSize}>
        {practice.label}
      </text>

      <!-- Slices -->
      <Slice
        on:assessment-mouseover={assessmentMouseover}
        on:assessment-mouseout={assessmentMouseout}
        on:assessment-click={assessmentClick}
        on:assessment-dblclick={assessmentDblclick}
        centerX={centerX}
        centerY={centerY}
        startRadians={practice.startRadians}
        endRadians={practice.endRadians}
        innerRadius={innerRadius}
        outerRadius={outerRadius-disciplineBandHeight}
        assessmentData={practice.assessmentData}
        label={practice.label}
        description={practice.description}
        labelBandHeight={practiceBandHeight}
        stroke={practiceStroke}
        strokeWidth={strokeWidth}
        teamArcStrokeWidth={teamArcStrokeWidth}
        fontColor={fontColor}
        fontSize={practiceFontSize}
      />
    {/each}

    <!-- Discipline Label -->
    <Arc
      centerX={centerX}
      centerY={centerY}
      startRadians={discipline.startRadians}
      endRadians={discipline.endRadians}
      innerRadius={outerRadius-disciplineBandHeight}
      outerRadius={outerRadius}
      fill="#FFFFFF"
      strokeWidth={strokeWidth}
      stroke={disciplineStroke}
      label={discipline.label}
      description={discipline.description}
      fontColor={diciplineFontColor}
      fontSize={disciplineFontSize}
    />

    <!-- Dicipline Area Arc -->
    <Arc
      centerX={centerX}
      centerY={centerY}
      startRadians={discipline.startRadians}
      endRadians={discipline.endRadians}
      outerRadius={outerRadius} {innerRadius}
      fill="none"
      strokeWidth={strokeWidth * 2}
      stroke={disciplineStroke}
    />

  {/each}

  {#if showSidebar}
    <Sidebar
      levelConfigAnnotated={levelConfigAnnotated}
      percentages={percentages}
      maxFontSize={disciplineFontSize}
      legendFontColor={legendFontColor}
      sidebarWidth={sidebarWidth}
      radarSize={radarSize}
      descriptionsInLegend={descriptionsInLegend}
      stats={stats}
      showSummaryStats={showSummaryStats}
    />
  {/if}

</svg>

<style>
  @import url('https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@300&display=swap');
</style>
