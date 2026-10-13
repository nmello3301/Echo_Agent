// One in-process event bus; the WebSocket layer forwards every event to the browser.
export type EchoEvent = { type: string; [k: string]: unknown };
type Handler = (e: EchoEvent) => void;

const handlers = new Set<Handler>();

export function publish(e: EchoEvent) {
  for (const h of handlers) {
    try {
      h(e);
    } catch (err) {
      console.error("[bus]", err);
    }
  }
}

export function subscribe(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}
