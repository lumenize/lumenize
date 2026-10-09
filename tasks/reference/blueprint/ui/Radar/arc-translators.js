export function translateX(r, centerX, radians) {
  return centerX + (r * Math.sin(radians))
}

export function translateY(r, centerY, radians) {
  return centerY - (r * Math.cos(radians))
}

export function getArcEnds(r, centerX, centerY, startRadians, endRadians) {
  const p1x = translateX(r, centerX, startRadians)
  const p1y = translateY(r, centerY, startRadians)
  const p2x = translateX(r, centerX, endRadians)
  const p2y = translateY(r, centerY, endRadians)
  return { p1x, p1y, p2x, p2y }
}
