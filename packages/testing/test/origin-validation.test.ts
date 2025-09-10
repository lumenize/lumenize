import { describe, expect, it } from 'vitest'
import { simulateWSUpgrade } from '../src/websocket-utils.js'

describe('Origin validation tests', () => {
  it('should reject invalid origins with 403 status', async () => {
    const result = await simulateWSUpgrade('https://test-harness.example.com/wss', {
      origin: 'https://malicious-site.com'
    })
    
    expect(result.response.ok).toBe(false)
    expect(result.response.status).toBe(403)
    
    const text = await result.response.text()
    expect(text).toBe('Origin not allowed')
  })

  it('should reject missing origins with 403 status', async () => {
    const result = await simulateWSUpgrade('https://test-harness.example.com/wss', {
      // No origin provided
    })
    
    expect(result.response.ok).toBe(false)
    expect(result.response.status).toBe(403)
    
    const text = await result.response.text()
    expect(text).toBe('Origin header required')
  })

  it('should accept valid origins', async () => {
    const result = await simulateWSUpgrade('https://test-harness.example.com/wss', {
      origin: 'https://example.com'
    })
    
    expect(result.response.status).toBe(101) // WebSocket upgrade status
    expect(result.ws).toBeTruthy() // WebSocket should be created
  })
})
