/* eslint-disable no-bitwise */
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  } : null
}

function hexAndOpacityToRgb(hex, alpha) {
  const rgb = hexToRgb(hex)
  const oneMinusAlphaTimes255 = 255 * (1 - alpha)
  const r = rgb.r * alpha + oneMinusAlphaTimes255
  const g = rgb.g * alpha + oneMinusAlphaTimes255
  const b = rgb.b * alpha + oneMinusAlphaTimes255
  return { r, g, b }
}

function rgbToHex(rgb) {
  return `#${((1 << 24) + (rgb.r << 16) + (rgb.g << 8) + rgb.b).toString(16).slice(1).split('.')[0]}`
}

function bestTextColor(rgb) {
  if ((rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114) > 186) {
    return '#000000'
  } else {
    return '#ffffff'
  }
}

export function getBackgroundAndTextColor(hex, alpha) {
  const rgb = hexAndOpacityToRgb(hex, alpha)
  const bgColor = rgbToHex(rgb)
  const textColor = bestTextColor(rgb)
  return { bgColor, textColor }
}
