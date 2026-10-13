/**
 * Test stub for Vite's `?worker` import of Monaco's editor worker.
 *
 * jsdom has no Worker implementation worth exercising here, and the stubbed
 * editor never starts one, so this only needs to be constructible.
 */
export default class StubWorker {
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
