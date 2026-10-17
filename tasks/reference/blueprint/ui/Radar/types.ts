export type Level = {
    _entityID: string
    color: string
    description: string
    textColor: string
    labelID: string
    levelIndex: number
    considerNotAssessed: boolean
}

export type AssessmentData = {
    levelIndex: number
    color: string
    opacity: number
    teamIndex: number
    innerRadius: number
    outerRadius: number
}

export type Team = {
    _entityID: string
    label: string
    assessmentData: AssessmentData[]
    teamIndex: number
    assessedCount: number
}

export type Practice = {
    _entityID: string
    label: string
    assessmentData: AssessmentData[]
    startRadians: number
    endRadians: number
    id: string
    description: string
  }


export type Discipline = {
    _entityID: string
    label: string
    practices: Practice[]
    startRadians: number
    endRadians: number
    id: string
    description: string
}
