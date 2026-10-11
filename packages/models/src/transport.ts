import { Agent, fetch as undiciFetch } from "undici";

// Native fetch's 300s header/body inactivity timers can terminate valid long generations.
// Every model caller supplies an AbortSignal (the SDK also supplies one); keep that deadline
// authoritative and pair the dispatcher with the same Undici fetch implementation.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
export const modelFetch: typeof globalThis.fetch = (input, init) =>
  undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher,
  }) as unknown as Promise<Response>;
