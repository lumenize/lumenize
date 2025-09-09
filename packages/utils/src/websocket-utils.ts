/**
 * Detects if a request is attempting to upgrade to a WebSocket connection
 * by checking the appropriate headers according to WebSocket RFC 6455
 * 
 * @param request - The incoming HTTP request
 * @returns true if this is a WebSocket upgrade request
 */
export function isWebSocketUpgrade(request: Request): boolean {
  const upgradeHeader = request.headers.get("Upgrade");
  const connectionHeader = request.headers.get("Connection");
  
  return request.method === "GET" && 
         upgradeHeader?.toLowerCase() === "websocket" &&
         (connectionHeader?.toLowerCase().includes("upgrade") ?? false);
}